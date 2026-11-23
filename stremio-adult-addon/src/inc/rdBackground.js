// Background Real-Debrid caching for favorites with thin coverage.
//
// Favoriting a title asks: does anything play it right now (a release
// Real-Debrid has, or one with ≥ 5 live seeders)? If not, Real-Debrid is
// asked to download the best release it can still fetch, and left to it:
// RD downloads on its own servers whether or not anyone is watching, so a
// thin swarm (one or two seeders) that takes hours still ends up cached,
// and the title then plays instantly as "[RD+]". Measured 2026-11-23: two
// thin "Rock, Paper, Pussy" releases reached ~17% in ~40 minutes.
//
// Unlike a play-time download job (rdJobs.js), nothing here waits for a
// viewer: downloads are checked every POLL_MS, a release that fails or
// makes no progress for STALL_MS is dropped for the next candidate, and
// unfavoriting removes it. A few run at once (MAX_ACTIVE); the rest queue.
// Favorites that play fine today are checked again later (swarms fade).
// State is saved, so this survives restarts.

const rd = require('../rd');
const store = require('./store');
const favorites = require('./favorites');

const { rdFetch, magnetFor, pickLargestVideoIdx, deleteTorrent } = rd._rd;

const FILE = 'rd-background.json';
const POLL_MS = 10 * 60 * 1000;
const STALL_MS = 24 * 60 * 60 * 1000;
const RECHECK_MS = 3 * 24 * 60 * 60 * 1000; // covered / no-candidate titles
const MAX_ACTIVE = 3;
const MAX_TRIES = 3;
const FAILED = /^(magnet_error|error|virus|dead)$/;

let state = null; // { titles: { [id]: entry } }
let running = null;
let kickTimer = null;
let catalog = null; // required lazily (catalog → rd, no cycle at load time)

function load() {
    if (!state) {
        const saved = store.readJson(FILE, null);
        state = saved && saved.titles && typeof saved.titles === 'object' ? saved : { titles: {} };
    }
    return state;
}
function save() {
    try { store.writeJson(FILE, load()); } catch { /* best effort */ }
}
const entries = () => Object.values(load().titles);
const active = () => entries().filter((e) => e.state === 'downloading');

/** For the title page: what background caching is doing for this title. */
function statusFor(id) {
    const e = load().titles[id];
    if (!e) return null;
    return { state: e.state, progress: e.progress || 0, seeders: e.seeders || 0, release: e.release || '', message: e.message || '' };
}

/** The torrent a background download holds for this hash (play-time jobs share it). */
function torrentFor(hash) {
    const h = String(hash || '').toLowerCase();
    const e = entries().find((x) => x.state === 'downloading' && x.hash === h);
    return e ? e.torrentId : null;
}

/** A title was favorited: check it, and cache it on RD if it's thin. */
function consider(id, snapshot) {
    if (typeof id !== 'string' || !id) return;
    const titles = load().titles;
    const e = titles[id];
    if (e && (e.state === 'downloading' || e.state === 'cached' || e.state === 'queued')) return;
    titles[id] = { id, state: 'queued', tried: (e && e.tried) || [], snapshot: snapshot || (e && e.snapshot) || null, queuedAt: Date.now() };
    save();
    kick();
}

/** A title was unfavorited: stop its download (a finished one stays cached on RD). */
async function forget(id) {
    const titles = load().titles;
    const e = titles[id];
    if (!e) return;
    delete titles[id];
    save();
    if (e.state === 'downloading' && e.torrentId) {
        rd.unprotectHash(e.hash);
        const token = store.getRdToken();
        if (token) await deleteTorrent(token, e.hash, e.torrentId).catch(() => { /* gone already */ });
    }
}

function kick(delay = 2000) {
    if (kickTimer) return;
    kickTimer = setTimeout(() => { kickTimer = null; run().catch(() => { /* next poll */ }); }, delay);
    if (kickTimer.unref) kickTimer.unref();
}

async function startDownload(token, e, cand) {
    rd.protectHash(cand.infoHash);
    let torrentId = rd.adoptParked(token, cand.infoHash);
    if (!torrentId) {
        const add = await rdFetch(token, 'POST', '/torrents/addMagnet', { magnet: magnetFor(cand.infoHash, cand.name) }).catch(() => null);
        if (!add || !add.ok || !add.body || !add.body.id) {
            rd.unprotectHash(cand.infoHash);
            return false;
        }
        torrentId = add.body.id;
    }
    Object.assign(e, {
        state: 'downloading', hash: cand.infoHash, torrentId, release: cand.name, progress: 0, seeders: 0,
        startedAt: Date.now(), progressAt: Date.now(), selected: false, message: '',
    });
    e.tried = [...(e.tried || []), cand.infoHash];
    console.warn(`[rd-bg] ${e.id}: caching ${cand.infoHash.slice(0, 8)} (${cand.seeders} seeders listed)`);
    return true;
}

// Drop the current release (failed or stuck) so the next candidate gets a turn.
async function drop(token, e, why) {
    rd.unprotectHash(e.hash);
    await deleteTorrent(token, e.hash, e.torrentId).catch(() => { /* gone already */ });
    console.warn(`[rd-bg] ${e.id}: dropped ${e.hash.slice(0, 8)} (${why})`);
    Object.assign(e, { state: 'queued', torrentId: null, hash: null, message: why });
}

async function poll(token, e) {
    const info = await rdFetch(token, 'GET', `/torrents/info/${e.torrentId}`).catch(() => null);
    if (!info) return;
    if (info.status === 404) { await drop(token, e, 'removed from Real-Debrid'); return; }
    if (!info.ok || !info.body) return;
    const b = info.body;
    if (b.status === 'waiting_files_selection' && Array.isArray(b.files) && b.files.length && !e.selected) {
        const file = b.files[pickLargestVideoIdx(b.files)];
        const sel = file && await rdFetch(token, 'POST', `/torrents/selectFiles/${e.torrentId}`, { files: String(file.id) }).catch(() => null);
        if (sel && (sel.ok || sel.status === 204)) e.selected = true;
    }
    const progress = Number(b.progress) || 0;
    if (progress > (e.progress || 0)) e.progressAt = Date.now();
    e.progress = progress;
    e.seeders = Number(b.seeders) || 0;
    if (b.status === 'downloaded') {
        rd.unprotectHash(e.hash);
        rd.markDownloaded(token, e.hash, e.torrentId, b.files);
        Object.assign(e, { state: 'cached', progress: 100, cachedAt: Date.now(), message: '' });
        console.warn(`[rd-bg] ${e.id}: cached on Real-Debrid`);
    } else if (FAILED.test(b.status || '')) {
        await drop(token, e, `Real-Debrid: ${b.status}`);
    } else if (Date.now() - e.progressAt > STALL_MS) {
        await drop(token, e, `no progress for a day at ${progress}%`);
    }
}

async function check(token, e) {
    if (!catalog) catalog = require('./catalog');
    e.state = 'checking';
    let cov = null;
    try { cov = await catalog.coverage(e.id, e.snapshot || undefined); } catch { cov = null; }
    e.checkedAt = Date.now();
    if (!cov) { Object.assign(e, { state: 'none', message: 'no torrents for this title' }); return; }
    e.name = cov.name;
    if (cov.cached) { Object.assign(e, { state: 'cached', message: 'Real-Debrid already has it' }); return; }
    if (cov.healthy) { Object.assign(e, { state: 'covered', message: 'plays over P2P today' }); return; }
    const cand = cov.candidates.find((c) => !(e.tried || []).includes(c.infoHash));
    if (!cand || (e.tried || []).length >= MAX_TRIES) {
        Object.assign(e, { state: 'failed', message: cand ? 'Real-Debrid couldn’t fetch any of its releases' : 'no release Real-Debrid can fetch yet' });
        return;
    }
    if (!(await startDownload(token, e, cand))) Object.assign(e, { state: 'queued', message: 'Real-Debrid refused the torrent' });
}

async function runOnce() {
    const token = store.getRdToken();
    if (!token) return;
    // Follow running downloads.
    for (const e of active()) {
        if (e.torrentId) rd.protectHash(e.hash);
        await poll(token, e);
    }
    save();
    // Titles checked a while ago get another look (swarms fade; new releases appear).
    for (const e of entries()) {
        if ((e.state === 'covered' || e.state === 'failed') && Date.now() - (e.checkedAt || 0) > RECHECK_MS) {
            if (e.state === 'failed') e.tried = [];
            e.state = 'queued';
        }
    }
    // Start queued ones while there's room.
    for (const e of entries().filter((x) => x.state === 'queued' || x.state === 'checking')) {
        if (active().length >= MAX_ACTIVE) break;
        await check(token, e);
        save();
    }
}

function run() {
    if (!running) running = runOnce().finally(() => { running = null; });
    return running;
}

let ticker = null;
/** Start the periodic loop, and look at favorites saved before this existed. */
function init() {
    if (ticker) return;
    ticker = setInterval(() => run().catch(() => { /* next poll */ }), POLL_MS);
    if (ticker.unref) ticker.unref();
    const sweep = setTimeout(() => {
        for (const f of favorites.get().titles || []) {
            if (!load().titles[f.id]) consider(f.id, f.snapshot);
        }
        // Re-protect downloads a previous run started.
        for (const e of active()) if (e.hash) rd.protectHash(e.hash);
        kick(0);
    }, 60 * 1000);
    if (sweep.unref) sweep.unref();
}

function _reset() {
    state = { titles: {} };
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
}
function _setCatalog(c) { catalog = c; }

module.exports = { consider, forget, statusFor, torrentFor, init, run, _reset, _setCatalog, STALL_MS, MAX_ACTIVE };
