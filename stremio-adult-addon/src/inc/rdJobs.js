// Real-Debrid download jobs: the fallback when nothing can play right away.
//
// A torrent Real-Debrid hasn't cached can still be played through it: RD
// downloads it from the swarm to its own servers (even from one or two
// seeders), after which it streams over HTTPS like any cached release. That
// takes minutes, not seconds, so instead of the Player's 20 s wait (which
// then deleted the torrent and started over on every retry) a job keeps the
// torrent on RD, follows its progress, and the Incognito "downloading" page
// shows it and starts playback once RD has the file.
//
// Account hygiene: one job at a time (a new one replaces the old), started
// only from Play or auto-pick, never from opening a title; RD's active
// download limit is checked first; a job nobody is watching, one that stops
// making progress, or one that runs too long is cancelled and its torrent
// deleted. Job torrent ids are saved, so a restarted addon removes leftovers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const rd = require('../rd');
const { getCacheDir } = require('../config');

const { rdFetch, magnetFor, pickLargestVideoIdx, deleteTorrent } = rd._rd;

const POLL_MS = 3000;
// The page polls every few seconds; no poll for this long means the user left.
const UNWATCHED_MS = 3 * 60 * 1000;
// No new bytes (or no metadata) for this long: the swarm has no full copy.
const STALL_MS = 10 * 60 * 1000;
const MAX_MS = 2 * 60 * 60 * 1000;
// RD "error" within this long of starting gets one fresh try, this much later.
const EARLY_ERROR_MS = 90 * 1000;
const READD_PAUSE_MS = 20 * 1000;

const ACTIVE = new Set(['adding', 'finding', 'queued', 'downloading', 'finishing']);
const JOBS_FILE = path.join(getCacheDir() || os.tmpdir(), 'rd-jobs.json');

const jobs = new Map(); // infoHash → job
let ticker = null;

const leftoversAtStart = (() => {
    try {
        const list = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
        return Array.isArray(list) ? list.filter((x) => x && /^[a-f0-9]{40}$/.test(x.hash) && x.torrentId) : [];
    } catch {
        return [];
    }
})();

// Torrents on the account that a crash or a closed Stremio would orphan:
// running jobs, and torrents a cache check parked (rd.js).
function persist() {
    const open = [...jobs.values()].filter((j) => ACTIVE.has(j.state) && j.torrentId && !j.shared).map((j) => ({ hash: j.hash, torrentId: j.torrentId }));
    try { fs.writeFileSync(JOBS_FILE, JSON.stringify([...open, ...rd.parkedList()])); } catch { /* best effort */ }
}
rd.setParkedListener(persist);

function snapshot(job) {
    if (!job) return null;
    const remaining = job.bytes ? job.bytes * (1 - job.progress / 100) : 0;
    return {
        state: job.state,
        progress: Math.round(job.progress * 10) / 10,
        speed: job.speed,
        seeders: job.seeders,
        bytes: job.bytes,
        etaSec: job.state === 'downloading' && job.speed > 0 && remaining > 0 ? Math.round(remaining / job.speed) : null,
        message: job.message || '',
        startedAt: job.startedAt,
    };
}

async function finish(job, state, message) {
    job.state = state;
    job.message = message || '';
    // A torrent shared with a favorite's background download stays theirs.
    if (!job.shared) {
        rd.unprotectHash(job.hash);
        if (state !== 'ready' && job.torrentId) await deleteTorrent(job.token, job.hash, job.torrentId);
    }
    if (state !== 'ready') console.warn(`[rd-job] ${job.hash.slice(0, 8)}: ${state}${message ? ` (${message})` : ''}`);
    persist();
}

// RD's torrent states → ours. https://api.real-debrid.com/#torrents_info
function mapState(status) {
    if (status === 'magnet_conversion') return 'finding';
    if (status === 'waiting_files_selection') return 'finding';
    if (status === 'queued') return 'queued';
    if (status === 'downloading') return 'downloading';
    if (status === 'compressing' || status === 'uploading') return 'finishing';
    if (status === 'downloaded') return 'ready';
    return 'dead'; // magnet_error, error, virus, dead
}

async function addMagnet(job) {
    const add = await rdFetch(job.token, 'POST', '/torrents/addMagnet', { magnet: magnetFor(job.hash, job.title) }).catch(() => null);
    if (!add || !add.ok || !add.body || !add.body.id) return add ? `HTTP ${add.status}` : 'no answer';
    job.torrentId = add.body.id;
    job.state = 'finding';
    persist();
    return '';
}

async function tick(job) {
    const now = Date.now();
    if (now - job.watchedAt > UNWATCHED_MS) return finish(job, 'cancelled', 'nobody is waiting for it any more');
    if (now - job.startedAt > MAX_MS) return finish(job, 'stalled', 'took longer than two hours');
    if (!job.torrentId) {
        if (job.readdAt && now < job.readdAt) return undefined;
        const failed = await addMagnet(job);
        if (failed) return finish(job, 'error', `Real-Debrid refused the torrent (${failed})`);
    }
    const info = await rdFetch(job.token, 'GET', `/torrents/info/${job.torrentId}`).catch(() => null);
    if (!info || !info.ok || !info.body) return undefined; // try again next tick
    const b = info.body;
    const state = mapState(b.status);
    if (b.status !== job.rdStatus) {
        console.warn(`[rd-job] ${job.hash.slice(0, 8)}: ${job.rdStatus || 'added'} → ${b.status}`);
        job.rdStatus = b.status;
    }
    if (b.status === 'waiting_files_selection' && Array.isArray(b.files) && b.files.length && !job.selected) {
        const file = b.files[pickLargestVideoIdx(b.files)];
        if (file) {
            const sel = await rdFetch(job.token, 'POST', `/torrents/selectFiles/${job.torrentId}`, { files: String(file.id) }).catch(() => null);
            if (sel && (sel.ok || sel.status === 204)) job.selected = true;
            else console.warn(`[rd-job] ${job.hash.slice(0, 8)}: selectFiles failed (HTTP ${sel ? sel.status : 'none'})`);
        }
    }
    job.progress = Number(b.progress) || 0;
    job.speed = Number(b.speed) || 0;
    job.seeders = Number(b.seeders) || 0;
    job.bytes = Number(b.bytes) || job.bytes || 0;
    if (job.progress > job.lastProgress) {
        job.lastProgress = job.progress;
        job.progressAt = now;
    }
    if (state === 'ready') {
        rd.markDownloaded(job.token, job.hash, job.torrentId, b.files);
        return finish(job, 'ready');
    }
    if (state === 'dead') {
        // An "error" right at the start can be RD's leftover state from a
        // copy deleted moments before (the title page's cache check adds
        // and removes the same torrent): one fresh try after a pause.
        if (b.status === 'error' && !job.retried && !job.shared && now - job.startedAt < EARLY_ERROR_MS) {
            job.retried = true;
            await deleteTorrent(job.token, job.hash, job.torrentId, { force: true });
            job.torrentId = null;
            job.selected = false;
            job.rdStatus = '';
            job.state = 'finding';
            job.readdAt = now + READD_PAUSE_MS;
            persist();
            return undefined;
        }
        return finish(job, 'dead', b.status === 'error'
            ? 'Real-Debrid can’t download it (no reachable peers)'
            : `Real-Debrid says the torrent is ${b.status}`);
    }
    job.state = state;
    if (now - job.progressAt > STALL_MS) {
        return finish(job, 'stalled', job.lastProgress > 0
            ? `no progress for ${STALL_MS / 60000} minutes at ${job.lastProgress}%`
            : `no peers found in ${STALL_MS / 60000} minutes`);
    }
    return undefined;
}

function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(async () => {
        const running = [...jobs.values()].filter((j) => ACTIVE.has(j.state) && !j.busy);
        if (!running.length && ![...jobs.values()].some((j) => ACTIVE.has(j.state))) {
            clearInterval(ticker);
            ticker = null;
            return;
        }
        for (const job of running) {
            job.busy = true;
            try { await tick(job); } catch { /* next tick */ } finally { job.busy = false; }
        }
    }, POLL_MS);
    if (ticker.unref) ticker.unref();
}

// Starts in progress, so two calls at once (the page mounting twice, a
// double click) share one job instead of each adding the torrent, which
// left the first one's torrent on the account with nothing to remove it.
const starting = new Map(); // infoHash → Promise<snapshot>

/** Start (or rejoin) the download job for a release. → snapshot */
function start(args) {
    const hash = String((args && args.infoHash) || '').toLowerCase();
    if (starting.has(hash)) return starting.get(hash);
    const p = startOnce(args).finally(() => starting.delete(hash));
    starting.set(hash, p);
    return p;
}

async function startOnce({ infoHash, title, token }) {
    const hash = String(infoHash || '').toLowerCase();
    if (!token || !/^[a-f0-9]{40}$/.test(hash)) return { state: 'error', message: 'Real-Debrid is not set up' };
    const existing = jobs.get(hash);
    if (existing && (ACTIVE.has(existing.state) || existing.state === 'ready')) {
        existing.watchedAt = Date.now();
        return snapshot(existing);
    }
    // One job at a time: a new pick replaces a download the user moved away from.
    for (const other of jobs.values()) {
        if (other.hash !== hash && ACTIVE.has(other.state)) await finish(other, 'cancelled', 'replaced by another download');
    }
    const active = await rdFetch(token, 'GET', '/torrents/activeCount').catch(() => null);
    if (active && active.ok && active.body && Number(active.body.nb) >= Number(active.body.limit)) {
        return { state: 'error', message: `Real-Debrid is already running its limit of ${active.body.limit} downloads` };
    }
    const now = Date.now();
    const job = {
        hash, title: String(title || '').slice(0, 160), token,
        state: 'adding', progress: 0, lastProgress: 0, speed: 0, seeders: 0, bytes: 0,
        startedAt: now, watchedAt: now, progressAt: now, torrentId: null, selected: false, message: '',
    };
    jobs.set(hash, job);
    rd.protectHash(hash);
    // A favorite's background download (rdBackground.js) already fetching
    // it: follow that torrent, and leave it to the background on cancel.
    const backgroundId = require('./rdBackground').torrentFor(hash);
    // The title page's cache check may have left RD already fetching it
    // (parked, file selected): take that over rather than adding it again.
    const parkedId = backgroundId ? null : rd.adoptParked(token, hash);
    if (backgroundId) {
        job.torrentId = backgroundId;
        job.shared = true;
        job.selected = true;
        job.state = 'finding';
    } else if (parkedId) {
        job.torrentId = parkedId;
        job.selected = true;
        job.state = 'finding';
        persist();
    } else {
        const failed = await addMagnet(job);
        if (failed) {
            await finish(job, 'error', `Real-Debrid refused the torrent (${failed})`);
            return snapshot(job);
        }
    }
    // First look right away: a release RD already has is ready at once.
    // (`busy` keeps a ticker already running for an earlier job off it.)
    job.busy = true;
    try { await tick(job); } catch { /* the ticker retries */ } finally { job.busy = false; }
    if (ACTIVE.has(job.state)) ensureTicker();
    return snapshot(job);
}

/** The job's progress; asking counts as "still watching". */
function status(infoHash) {
    const job = jobs.get(String(infoHash || '').toLowerCase());
    if (!job) return null;
    if (ACTIVE.has(job.state)) job.watchedAt = Date.now();
    return snapshot(job);
}

async function cancel(infoHash) {
    const job = jobs.get(String(infoHash || '').toLowerCase());
    if (!job || !ACTIVE.has(job.state)) return snapshot(job);
    await finish(job, 'cancelled', 'cancelled');
    return snapshot(job);
}

/** Remove torrents a previous run's jobs (or parked checks) left on the account. */
async function cleanupLeftovers(token) {
    // What the previous run left, read once at startup: by the time this
    // runs, the file may already list this run's own parked torrents.
    const list = leftoversAtStart.splice(0);
    if (!token || !list.length) return;
    for (const { hash, torrentId } of list) {
        if (jobs.has(hash)) continue;
        const info = await rdFetch(token, 'GET', `/torrents/info/${torrentId}`).catch(() => null);
        if (info && info.ok && info.body && info.body.status === 'downloaded') continue;
        await deleteTorrent(token, hash, torrentId);
    }
    persist();
}

function _reset() {
    for (const job of jobs.values()) rd.unprotectHash(job.hash);
    jobs.clear();
    if (ticker) { clearInterval(ticker); ticker = null; }
}

module.exports = { start, status, cancel, cleanupLeftovers, _tick: tick, _reset, _jobs: jobs, STALL_MS, UNWATCHED_MS };
