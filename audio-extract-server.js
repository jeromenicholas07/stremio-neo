#!/usr/bin/env node
// ============================================================
//  Audio Extraction Sidecar for WhisperSync
//  Provides fast, seekable audio extraction via FFmpeg.
//  Run: node audio-extract-server.js
//
//  GET /health                              → { status: 'ok' }
//  GET /audio-extract?mediaURL=...&start=0&duration=5  → raw f32le PCM
// ============================================================

const http = require('http');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const PORT = 12471;

// ── Find FFmpeg ──

function findFFmpeg() {
    const candidates = [];

    // 1. ffmpeg-static npm package (bundled binary — most reliable)
    try {
        const ffmpegStatic = require('ffmpeg-static');
        if (ffmpegStatic) candidates.push(ffmpegStatic);
    } catch (_) { /* not installed */ }

    // 2. System PATH
    candidates.push('ffmpeg');

    // 3. Stremio install directories (Windows)
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        if (local) {
            candidates.push(
                path.join(local, 'Programs', 'LNV', 'Stremio-4', 'stremio-runtime', 'ffmpeg.exe'),
                path.join(local, 'Programs', 'Stremio', 'ffmpeg.exe'),
                path.join(local, 'Programs', 'Stremio', 'stremio-runtime', 'ffmpeg.exe'),
            );
        }
        const prog = process.env.ProgramFiles || '';
        if (prog) candidates.push(path.join(prog, 'Stremio', 'ffmpeg.exe'));
    }

    for (const bin of candidates) {
        try {
            execFileSync(bin, ['-version'], { stdio: 'ignore', timeout: 5000 });
            return bin;
        } catch (_) { /* try next */ }
    }
    return null;
}

const ffmpegPath = findFFmpeg();
if (!ffmpegPath) {
    console.error('ERROR: FFmpeg not found. Install FFmpeg or add it to PATH.');
    process.exit(1);
}
console.log('Using FFmpeg:', ffmpegPath);

// ── CORS helpers ──

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

// ── Downmix variants ──
//
// Dialogue lives in the centre channel of a 5.1 mix. FFmpeg's default mono
// downmix (-ac 1) folds every channel together, so music and effects from
// L/R/LFE/surrounds arrive at full strength while speech is attenuated.
// Whisper's error rate on a cinematic mix climbs accordingly — and garbage
// transcription is exactly what produces spurious subtitle matches. So take
// the centre channel alone wherever there is one.
const AUDIO_FILTERS = {
    surround: 'pan=mono|c0=FC,dynaudnorm=f=200',
    stereo: 'pan=mono|c0=0.5*FL+0.5*FR,dynaudnorm=f=200',
    full: 'anull',
};

// Which variant a given media URL needs. Probed once, then reused.
const layoutCache = new Map();

// Asking `pan` for FC on a stereo source does NOT fail — it returns a
// perfectly valid buffer of pure silence, exit code 0. So the layout has to
// be established up front rather than inferred from a failure. `ffmpeg -i`
// with no output prints the stream table and exits; that is enough, and it
// avoids shipping an ffprobe binary next to ffmpeg-static.
function detectVariant(mediaURL, headers, callback) {
    if (layoutCache.has(mediaURL)) {
        return callback(layoutCache.get(mediaURL));
    }

    const args = [];
    if (headers) args.push('-headers', headers + '\r\n');
    args.push('-i', mediaURL);

    const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderr = '';
    ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });

    const timeout = setTimeout(() => ffmpeg.kill('SIGKILL'), 15000);

    const finish = (variant) => {
        clearTimeout(timeout);
        layoutCache.set(mediaURL, variant);
        console.log(`[Extract] Detected ${variant} audio layout`);
        callback(variant);
    };

    ffmpeg.on('close', () => {
        const audioLines = stderr.match(/Audio:[^\r\n]*/g) || [];
        const surround = audioLines.some((line) => /(^|[\s,(])(5\.[01]|6\.1|7\.1|quad)([\s,)]|$)/i.test(line));
        finish(surround ? 'surround' : 'stereo');
    });

    // Probe failed outright — stereo is the safe default, it works on any layout.
    ffmpeg.on('error', () => finish('stereo'));
}

// A centre channel that turns out to carry no dialogue (an unusual mix, or a
// genuinely silent passage) would hand Whisper five seconds of nothing. Cheap
// to check, and the difference between a working sync and a total failure.
function isSilent(buffer) {
    const samples = Math.floor(buffer.length / 4);
    for (let i = 0; i < samples; i++) {
        if (Math.abs(buffer.readFloatLE(i * 4)) > 1e-6) return false;
    }
    return true;
}

// Turns ffmpeg's input dump into { duration, chapters }. Null when the dump
// describes no media at all (unreachable URL, not a media file).
function parseMediaInfo(dump) {
    const dm = dump.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!dm && !dump.includes('Stream #')) return null;
    const duration = dm ? Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]) : null;
    const lines = dump.split(/\r?\n/);
    const chapters = [];
    for (let i = 0; i < lines.length; i++) {
        const cm = lines[i].match(/Chapter #\d+:\d+: start (-?[\d.]+), end (-?[\d.]+)/);
        if (!cm) continue;
        // The chapter's own metadata follows, up to the next chapter or the
        // first stream.
        let title = null;
        for (let j = i + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (t.startsWith('Chapter #') || t.startsWith('Stream #')) break;
            const tm = t.match(/^title\s*:\s*(.*)$/);
            if (tm) { title = tm[1].trim(); break; }
        }
        chapters.push({ start: Number(cm[1]), end: Number(cm[2]), title });
    }
    return { duration, chapters };
}

// Hard cuts (scene score above 0.25), black stretches and each frame's mean
// brightness, on a small copy of each frame. Times ffmpeg prints are from
// the seek point.
const SCENE_FILTER = 'scale=320:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG,'
    + 'blackdetect=d=0.04:pix_th=0.10,select=\'gt(scene,0.25)\',showinfo';

function parseSceneCuts(stderr, start) {
    const at = (value) => Math.round((start + Number(value)) * 1000) / 1000;
    const cuts = [];
    const blacks = [];
    const luma = [];
    let frameAt = null;
    for (const line of stderr.split(/\r?\n/)) {
        const pts = line.match(/pts_time:([\d.]+)/);
        if (line.includes('Parsed_showinfo') && pts) cuts.push(at(pts[1]));
        if (line.includes('Parsed_metadata')) {
            if (pts) frameAt = at(pts[1]);
            const y = line.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
            if (y && frameAt !== null) luma.push([frameAt, Math.round(Number(y[1]) * 10) / 10]);
        }
        const black = line.match(/black_start:([\d.]+) black_end:([\d.]+)/);
        if (black) blacks.push([at(black[1]), at(black[2])]);
    }
    return { cuts, blacks, luma };
}

// ── Server ──

http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    // ── Health check ──
    if (url.pathname === '/health') {
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', ffmpeg: ffmpegPath }));
    }

    // ── Media info (duration + embedded chapters, for Skip Intro) ──
    if (url.pathname === '/media-info') {
        const mediaURL = url.searchParams.get('mediaURL');
        if (!mediaURL) {
            res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
            return res.end('Missing mediaURL parameter');
        }
        const headers = url.searchParams.get('headers');
        const args = ['-hide_banner'];
        if (headers) args.push('-headers', headers + '\r\n');
        args.push('-i', mediaURL);

        // No output file: ffmpeg prints the stream table and exits non-zero.
        const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
        const timeout = setTimeout(() => {
            ffmpeg.kill('SIGKILL');
            if (!res.headersSent) {
                res.writeHead(504, { ...CORS, 'Content-Type': 'text/plain' });
                res.end('FFmpeg timed out (15s)');
            }
        }, 15000);
        ffmpeg.on('close', () => {
            clearTimeout(timeout);
            if (res.headersSent) return;
            const info = parseMediaInfo(stderr);
            if (!info) {
                res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
                return res.end('Could not read media info');
            }
            res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(info));
        });
        ffmpeg.on('error', (err) => {
            clearTimeout(timeout);
            if (!res.headersSent) {
                res.writeHead(500, { ...CORS, 'Content-Type': 'text/plain' });
                res.end(`FFmpeg spawn error: ${err.message}`);
            }
        });
        return;
    }

    // ── Small grey frames from an episode's end (Skip Intro's credit roll) ──
    if (url.pathname === '/frames') {
        const mediaURL = url.searchParams.get('mediaURL');
        const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
        const duration = Math.min(120, Math.max(1, Number(url.searchParams.get('duration')) || 60));
        if (!mediaURL) {
            res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
            return res.end('Missing mediaURL parameter');
        }
        const headers = url.searchParams.get('headers');
        // One thread, below normal priority, no hardware decoding: it runs
        // alongside playback. Deblocking is invisible at this size.
        const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-threads', '1', '-skip_loop_filter', 'all'];
        if (headers) args.push('-headers', headers + '\r\n');
        args.push('-seekable', '1', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3', '-rw_timeout', '8000000',
            '-ss', String(start), '-i', mediaURL, '-t', String(duration), '-an', '-sn',
            '-vf', 'fps=2,scale=160:90:flags=area,format=gray', '-filter_threads', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1');
        const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        try { os.setPriority(ffmpeg.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* already gone */ }
        res.on('close', () => {
            if (!res.writableFinished && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
        });
        const chunks = [];
        ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
        const timeout = setTimeout(() => {
            ffmpeg.kill('SIGKILL');
            if (!res.headersSent) {
                res.writeHead(504, { ...CORS, 'Content-Type': 'text/plain' });
                res.end('FFmpeg timed out (45s)');
            }
        }, 45000);
        ffmpeg.on('close', () => {
            clearTimeout(timeout);
            if (res.headersSent) return;
            const frames = Buffer.concat(chunks);
            if (frames.length === 0) {
                res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
                return res.end('Could not read the video');
            }
            res.writeHead(200, { ...CORS, 'Content-Type': 'application/octet-stream' });
            res.end(frames);
        });
        ffmpeg.on('error', (err) => {
            clearTimeout(timeout);
            if (!res.headersSent) {
                res.writeHead(500, { ...CORS, 'Content-Type': 'text/plain' });
                res.end(`FFmpeg spawn error: ${err.message}`);
            }
        });
        return;
    }

    // ── Scene cuts and black frames in a short stretch (Skip Intro's end) ──
    if (url.pathname === '/scene-cuts') {
        const mediaURL = url.searchParams.get('mediaURL');
        const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
        const duration = Math.min(15, Math.max(1, Number(url.searchParams.get('duration')) || 6));
        if (!mediaURL) {
            res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
            return res.end('Missing mediaURL parameter');
        }
        const headers = url.searchParams.get('headers');
        const args = ['-hide_banner', '-nostats'];
        if (headers) args.push('-headers', headers + '\r\n');
        // A debrid host can stall mid-read: give up on a silent connection
        // after 8 s and reconnect, rather than hang until the time limit.
        args.push('-seekable', '1', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
            '-rw_timeout', '8000000',
            '-ss', String(start), '-i', mediaURL, '-t', String(duration), '-an', '-sn',
            '-vf', SCENE_FILTER, '-f', 'null', '-');
        const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        res.on('close', () => {
            if (!res.writableFinished && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
        });
        let stderr = '';
        ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
        const timeout = setTimeout(() => {
            ffmpeg.kill('SIGKILL');
            if (!res.headersSent) {
                res.writeHead(504, { ...CORS, 'Content-Type': 'text/plain' });
                res.end('FFmpeg timed out (30s)');
            }
        }, 30000);
        ffmpeg.on('close', (code) => {
            clearTimeout(timeout);
            if (res.headersSent) return;
            if (code !== 0) {
                res.writeHead(502, { ...CORS, 'Content-Type': 'text/plain' });
                return res.end('Could not read the video');
            }
            res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify(parseSceneCuts(stderr, start)));
        });
        ffmpeg.on('error', (err) => {
            clearTimeout(timeout);
            if (!res.headersSent) {
                res.writeHead(500, { ...CORS, 'Content-Type': 'text/plain' });
                res.end(`FFmpeg spawn error: ${err.message}`);
            }
        });
        return;
    }

    // ── Audio extraction ──
    if (url.pathname === '/audio-extract') {
        const mediaURL = url.searchParams.get('mediaURL');
        const start = url.searchParams.get('start') || '0';
        const duration = url.searchParams.get('duration') || '5';

        if (!mediaURL) {
            res.writeHead(400, { ...CORS, 'Content-Type': 'text/plain' });
            return res.end('Missing mediaURL parameter');
        }

        // Optional custom headers (for debrid auth tokens etc.)
        const headers = url.searchParams.get('headers');

        console.log(`[Extract] start=${start}s duration=${duration}s url=${mediaURL.substring(0, 80)}...`);

        const attempt = (variants, index) => {
            const variant = variants[index];

            // Build FFmpeg arguments
            // -ss BEFORE -i = input seeking (keyframe-based, near-instant at any offset)
            const args = [
                '-ss', start,
                '-i', mediaURL,
                '-t', duration,
                '-vn',                          // no video
                '-af', AUDIO_FILTERS[variant],  // dialogue-focused mono downmix
                '-ac', '1',                     // mono
                '-ar', '16000',                 // 16 kHz for Whisper
                '-f', 'f32le',                  // raw 32-bit float PCM (no header — client wraps directly)
                '-y',
                'pipe:1',
            ];

            if (headers) {
                // Insert -headers before -i
                args.splice(0, 0, '-headers', headers + '\r\n');
            }

            const ffmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            // The caller gave up (a cancelled analysis): stop reading for it.
            res.on('close', () => {
                if (!res.writableFinished && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
            });

            const chunks = [];
            ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));

            let stderr = '';
            ffmpeg.stderr.on('data', (data) => { stderr += data.toString().slice(-500); });

            const timeout = setTimeout(() => {
                ffmpeg.kill('SIGKILL');
                if (!res.headersSent) {
                    res.writeHead(504, { ...CORS, 'Content-Type': 'text/plain' });
                    res.end('FFmpeg extraction timed out (30s)');
                }
            }, 30000);

            ffmpeg.on('close', (code) => {
                clearTimeout(timeout);
                const buffer = Buffer.concat(chunks);
                const unusable = code !== 0 || buffer.length === 0 || isSilent(buffer);

                if (unusable) {
                    if (index + 1 < variants.length) {
                        console.log(`[Extract] ${variant} downmix gave nothing usable — retrying as ${variants[index + 1]}`);
                        return attempt(variants, index + 1);
                    }
                    console.error(`[Extract] FFmpeg exit code ${code}`);
                    if (!res.headersSent) {
                        res.writeHead(500, { ...CORS, 'Content-Type': 'text/plain' });
                        res.end(`FFmpeg error (code ${code}): ${stderr.slice(-200)}`);
                    }
                    return;
                }

                console.log(`[Extract] Done — ${buffer.length} bytes (${(buffer.length / 4 / 16000).toFixed(1)}s of audio, ${variant})`);
                res.writeHead(200, {
                    ...CORS,
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': buffer.length,
                });
                res.end(buffer);
            });

            ffmpeg.on('error', (err) => {
                clearTimeout(timeout);
                if (!res.headersSent) {
                    res.writeHead(500, { ...CORS, 'Content-Type': 'text/plain' });
                    res.end(`FFmpeg spawn error: ${err.message}`);
                }
            });
        };

        // mix=full: every channel folded to mono with no dialogue emphasis,
        // which is what the launcher's own extractor returns. Skip Intro
        // fingerprints the music, most of which is outside the centre channel.
        if (url.searchParams.get('mix') === 'full') {
            return attempt(['full'], 0);
        }

        // Surround keeps stereo as a safety net in case the centre channel is
        // empty; a stereo downmix already works on any layout.
        detectVariant(mediaURL, headers, (variant) => {
            attempt(variant === 'surround' ? ['surround', 'stereo'] : ['stereo'], 0);
        });

        return;
    }

    // ── 404 ──
    res.writeHead(404, CORS);
    res.end('Not found');

}).listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Audio Extract Server running on http://127.0.0.1:${PORT}`);
    console.log('  Endpoints:');
    console.log('    GET /health');
    console.log('    GET /audio-extract?mediaURL=...&start=0&duration=5[&mix=full]');
    console.log('    GET /media-info?mediaURL=...\n');
});
