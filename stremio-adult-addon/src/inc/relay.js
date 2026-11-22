// Play relay and image proxy.
//
// GET /inc/play/<token>  — the Player (mpv in the Shell) streams a tube video
//   from here. The relay resolves the site's file URL server-side, adds the
//   headers the site needs (RedTube: Referer), forwards Range, and retries the
//   ISP's connection resets — they only ever hit before the response starts,
//   so a retry can't corrupt the stream. When a signed URL expires mid-watch
//   (403/410), it re-resolves once and carries on.
//
//   File URLs embed the caller's IP, so they never leave this process and
//   are never logged.
//
// GET /inc/img?u=<url>  — thumbnails from hosts the page can't load reliably,
//   with a disk cache. Only allowlisted hosts are fetched.

const fs = require('fs');
const path = require('path');
const net = require('./net');
const store = require('./store');
const { base64UrlEncode, base64UrlDecode } = require('./titles');

const SOURCES = {
    ep: require('./sources/eporner'),
    rt: require('./sources/redtube'),
    // Porntrex file links are tied to the IP that loaded the page; the relay
    // fetches both through net.js (IPv4), so they match.
    pt: require('./sources/porntrex'),
};

const RESOLVE_TTL_MS = 20 * 60 * 1000;
const resolved = new Map(); // `${site}:${id}` → { ts, streams }
const inflight = new Map();

function makePlayToken(site, siteId, quality) {
    return base64UrlEncode(JSON.stringify({ s: site, id: String(siteId), q: Number(quality) || 0 }));
}

function parsePlayToken(token) {
    try {
        const t = JSON.parse(base64UrlDecode(String(token)));
        if (t && SOURCES[t.s] && typeof t.id === 'string' && t.id) return t;
    } catch { /* fall through */ }
    return null;
}

async function resolveStreams(site, siteId, { fresh = false } = {}) {
    const key = `${site}:${siteId}`;
    const hit = resolved.get(key);
    if (!fresh && hit && Date.now() - hit.ts < RESOLVE_TTL_MS) return hit.streams;
    if (!fresh && inflight.has(key)) return inflight.get(key);
    const p = SOURCES[site].directStreams(siteId)
        .then((streams) => {
            resolved.set(key, { ts: Date.now(), streams });
            if (resolved.size > 500) resolved.delete(resolved.keys().next().value);
            return streams;
        })
        .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

// Pick the requested quality, else the best one at or below it, else the best.
function pickStream(streams, quality) {
    if (!streams.length) return null;
    if (!quality) return streams[0];
    return streams.find((s) => s.quality === quality)
        || streams.find((s) => s.quality < quality)
        || streams[0];
}

const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

async function openUpstream(token, range, method) {
    for (let round = 0; round < 2; round++) {
        const streams = await resolveStreams(token.s, token.id, { fresh: round > 0 });
        const pick = pickStream(streams, token.q);
        if (!pick) throw Object.assign(new Error('no playable file'), { status: 404 });
        const res = await net.open(pick.url, {
            method: method === 'HEAD' ? 'GET' : 'GET',
            headers: { ...pick.headers, ...(range ? { Range: range } : {}) },
            tries: 12,
        });
        // Signed URL expired or was rejected: resolve a fresh one once.
        if ((res.statusCode === 403 || res.statusCode === 410 || res.statusCode === 404) && round === 0) {
            res.resume();
            continue;
        }
        return res;
    }
    throw Object.assign(new Error('upstream refused the file'), { status: 502 });
}

async function handlePlay(req, res, tokenStr) {
    const token = parsePlayToken(tokenStr);
    if (!token) { res.statusCode = 400; res.end('bad token'); return; }
    let upstream;
    try {
        upstream = await openUpstream(token, req.headers.range, req.method);
    } catch (err) {
        console.warn(`[inc/play] ${token.s}:${token.id} failed: ${err.message}`);
        res.statusCode = err.status || 502;
        res.end();
        return;
    }
    const headers = { 'Access-Control-Allow-Origin': '*' };
    for (const h of PASS_HEADERS) if (upstream.headers[h]) headers[h] = upstream.headers[h];
    res.writeHead(upstream.statusCode, headers);
    if (req.method === 'HEAD') {
        upstream.destroy();
        res.end();
        return;
    }
    upstream.pipe(res);
    const cleanup = () => upstream.destroy();
    req.on('close', cleanup);
    res.on('close', cleanup);
    upstream.on('error', () => res.destroy());
}

// ── Image proxy ──

const IMAGE_HOSTS = [/(^|\.)eporner\.com$/i, /(^|\.)rdtcdn\.com$/i, /(^|\.)theporndb\.net$/i];
const IMG_CACHE_MAX_BYTES = 400 * 1024 * 1024;
const IMG_CONCURRENCY = 8;
let imgActive = 0;
const imgQueue = [];
let writesSincePrune = 0;

function imgSlot() {
    if (imgActive < IMG_CONCURRENCY) { imgActive++; return Promise.resolve(); }
    return new Promise((resolve) => imgQueue.push(resolve));
}
function imgRelease() {
    const next = imgQueue.shift();
    if (next) next(); else imgActive--;
}

function pruneImageCache(dir) {
    try {
        const files = fs.readdirSync(dir).map((f) => {
            const full = path.join(dir, f);
            const st = fs.statSync(full);
            return { full, size: st.size, t: st.mtimeMs };
        }).sort((a, b) => a.t - b.t);
        let total = files.reduce((s, f) => s + f.size, 0);
        for (const f of files) {
            if (total <= IMG_CACHE_MAX_BYTES * 0.8) break;
            try { fs.unlinkSync(f.full); total -= f.size; } catch { /* ignore */ }
        }
    } catch { /* ignore */ }
}

function sendImage(res, buf, type) {
    res.writeHead(200, {
        'Content-Type': type || 'image/jpeg',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=604800, immutable',
        'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
}

async function handleImage(req, res, query) {
    const url = query.get('u') || '';
    let host = '';
    try { host = new URL(url).hostname; } catch { /* invalid */ }
    if (!host || !IMAGE_HOSTS.some((re) => re.test(host))) {
        res.statusCode = 400; res.end(); return;
    }
    const dir = store.subDir('img-cache');
    const key = store.hashKey(url);
    const file = path.join(dir, key);
    try {
        const buf = fs.readFileSync(file);
        // The first byte block decides the type; good enough for jpeg/png/webp.
        const type = buf[0] === 0x89 ? 'image/png' : (buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/jpeg');
        sendImage(res, buf, type);
        return;
    } catch { /* not cached */ }

    await imgSlot();
    try {
        const r = await net.open(url, { tries: 8 });
        if (r.statusCode !== 200) { r.resume(); res.statusCode = 502; res.end(); return; }
        const buf = await net.readBody(r, { maxBytes: 5 * 1024 * 1024, timeoutMs: 20000 });
        sendImage(res, buf, r.headers['content-type']);
        try {
            fs.writeFileSync(file, buf);
            if (++writesSincePrune >= 200) { writesSincePrune = 0; pruneImageCache(dir); }
        } catch { /* cache is best-effort */ }
    } catch {
        res.statusCode = 502; res.end();
    } finally {
        imgRelease();
    }
}

module.exports = { handlePlay, handleImage, makePlayToken, parsePlayToken, resolveStreams, pickStream, SOURCES };
