// ThePornDB — studio-scene metadata (artwork, performers, tags) for scenes
// built from torrent releases. Needs the user's own API token, read from the
// shared data dir; nothing here runs without one.
//
// Verified 2026-11-21 with the user's token:
//   - GET /scenes?parse=<release name> recognised 40 of 50 real release names
//     (23/25 already in "<Studio> yy mm dd" form, 17/25 not). Median ~0.9 s.
//   - Scene fields used: id, title, date, description, duration, background
//     (16:9 artwork), poster, image, performers[{name, face}], tags[{name}],
//     site{name}.
//   - No rate-limit headers are sent; `performers=` as a filter returns 422.
//   - The unfiltered latest list is mostly clip-site entries, so rows are
//     built from torrent releases, not from ThePornDB's own listing.
//
// Every lookup (hit or miss) is cached on disk: scene data barely changes and
// a lookup costs about a second.

const net = require('../net');
const store = require('../store');
const { cleanName } = require('../titles');

const API = 'https://api.theporndb.net';
const PARSE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SCENE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONCURRENCY = 3;

let active = 0;
const waiting = [];
let pausedUntil = 0;

async function slot() {
    if (active < CONCURRENCY) { active++; return; }
    await new Promise((resolve) => waiting.push(resolve));
}
function release() {
    const next = waiting.shift();
    if (next) next(); else active--;
}

function hasToken() {
    return Boolean(store.getTpdbToken());
}

async function apiGet(path) {
    const token = store.getTpdbToken();
    if (!token) return null;
    await slot();
    try {
        const wait = pausedUntil - Date.now();
        if (wait > 0) await net.sleep(wait);
        const r = await net.fetchText(API + path, {
            tries: 4,
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': 'incognito-addon/1.0' },
        });
        if (r.status === 429) {
            pausedUntil = Date.now() + 30000;
            throw new Error('rate limited');
        }
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        return JSON.parse(r.body);
    } finally {
        release();
    }
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set('the a an and of in on with for to my her his your is at by xxx'.split(' '));
const words = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w));

// "yy mm dd" near the start, or a trailing "dd mm yyyy".
function releaseDate(name) {
    const n = norm(name);
    let m = n.match(/\b(\d{2}) (\d{2}) (\d{2})\b/);
    if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `20${m[1]}-${m[2]}-${m[3]}`;
    m = n.match(/\b(\d{2}) (\d{2}) (20\d{2})\b/);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[3]}-${m[2]}-${m[1]}`;
    return '';
}

// ?parse= always returns *something* for a bare performer name. Accept the
// match only when the release names the scene's date, or most of the scene
// title's own words (not counting the performers' names).
function plausible(releaseName, scene) {
    if (!scene) return false;
    const rdate = releaseDate(releaseName);
    if (rdate && scene.date === rdate) return true;
    if (rdate && scene.date && scene.date !== rdate) return false;
    const perfWords = new Set(words((scene.performers || []).map((p) => p.name).join(' ')));
    const want = words(scene.title).filter((w) => !perfWords.has(w));
    if (want.length === 0) return false;
    const have = new Set(words(releaseName));
    return want.filter((w) => have.has(w)).length / want.length >= 0.5;
}

function sceneToTitle(s, kind = 'scene') {
    if (!s || !s.id) return null;
    const bg = s.background || {};
    const performers = (s.performers || []).map((p) => cleanName(p && p.name)).filter(Boolean);
    const faces = {};
    for (const p of s.performers || []) {
        if (p && p.name && (p.face || p.image)) faces[cleanName(p.name)] = p.face || p.image;
    }
    return {
        id: `inc:${kind}:${s.id}`,
        kind,
        tpdbId: s.id,
        // The studio's own short name ("freeusefantasy") is how release names
        // spell it ("FreeUseFantasy"), so torrent searches use it.
        studioShort: (s.site && s.site.short_name) || '',
        name: cleanName(s.title),
        // Cards use the medium cut (~small file); the title page uses the large one.
        thumbnail: bg.medium || bg.large || bg.full || s.image || s.poster || '',
        backdrop: bg.large || bg.full || s.image || '',
        poster: s.poster || '',
        snapshots: [bg.full || bg.large, s.image].filter((x, i, a) => x && a.indexOf(x) === i),
        duration: Number(s.duration) || 0,
        date: s.date || '',
        studio: cleanName(s.site && s.site.name),
        network: cleanName(s.site && s.site.network && s.site.network.name),
        performers,
        performerImages: faces,
        tags: (s.tags || []).map((t) => cleanName(t && t.name)).filter(Boolean).slice(0, 15),
        description: cleanName(s.description),
    };
}

/**
 * Release name → scene title, or null. `cachedOnly` answers from disk without
 * a network call (undefined = not looked up yet).
 */
async function parseRelease(name, { cachedOnly = false } = {}) {
    const key = norm(name);
    if (!key) return null;
    const hit = store.cacheGet('tpdb-parse', key, PARSE_TTL_MS);
    if (hit !== undefined) {
        if (hit && hit.miss) {
            // Misses expire sooner: ThePornDB adds scenes over time.
            if (hit.t && Date.now() - hit.t < MISS_TTL_MS) return null;
        } else {
            return hit;
        }
    }
    if (cachedOnly || !hasToken()) return undefined;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
        let title = null;
        try {
            const data = await apiGet('/scenes?parse=' + encodeURIComponent(name) + '&per_page=1');
            const scene = data && Array.isArray(data.data) ? data.data[0] : null;
            if (plausible(name, scene)) title = sceneToTitle(scene);
        } catch {
            return undefined; // network trouble: don't cache, try again later
        }
        store.cacheSet('tpdb-parse', key, title || { miss: true, t: Date.now() });
        if (title) store.cacheSet('tpdb-scene', title.tpdbId, title);
        return title;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
}

const inflight = new Map();

async function getScene(uuid) {
    const hit = store.cacheGet('tpdb-scene', uuid, SCENE_TTL_MS);
    if (hit) return hit;
    if (!hasToken()) return null;
    try {
        const data = await apiGet('/scenes/' + encodeURIComponent(uuid));
        const title = sceneToTitle(data && data.data);
        if (title) store.cacheSet('tpdb-scene', uuid, title);
        return title;
    } catch {
        return null;
    }
}

// ── Listings: ThePornDB as the master index of professional scenes ──
//
// Verified 2026-11-22: /scenes?sort=date (newest), /performers/{id}/scenes
// (a filmography), /sites/{id}/scenes (a studio), /movies, /scenes?q=.
// `tags[]=<name>` returns nothing, so categories run as searches.

const LIST_TTL_MS = 30 * 60 * 1000;
const ID_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Clip stores and fan sites: kept in a performer's filmography, left out of
// "newest scenes", which is meant to be studio work.
const CLIP_NETWORKS = /clips|manyvids|onlyfans|fansly|iwantclips|clips4sale|loyalfans|modelhub|pornhub|xvideos|justfor\.?fans|fancentro|avn stars|niteflirt/i;

function isClipSite(scene) {
    const site = scene && scene.site;
    const names = [site && site.name, site && site.network && site.network.name, site && site.parent && site.parent.name].filter(Boolean).join(' ');
    return CLIP_NETWORKS.test(names);
}

async function cachedList(path, kind, { filter } = {}) {
    const hit = store.cacheGet('tpdb-list', path, LIST_TTL_MS);
    if (hit) return hit;
    const data = await apiGet(path);
    let items = (data && Array.isArray(data.data)) ? data.data : [];
    if (filter) items = items.filter(filter);
    const titles = items.map((s) => sceneToTitle(s, kind)).filter(Boolean);
    for (const t of titles) store.cacheSet('tpdb-scene', t.tpdbId, t);
    const result = { titles, total: (data && data.meta && data.meta.total) || titles.length };
    store.cacheSet('tpdb-list', path, result);
    return result;
}

// Name → ThePornDB id for performers and sites (exact name match preferred).
async function findId(kind, name) {
    const key = `${kind}:${norm(name)}`;
    const hit = store.cacheGet('tpdb-id', key, ID_TTL_MS);
    if (hit !== undefined) return hit;
    const data = await apiGet(`/${kind}?q=${encodeURIComponent(name)}&per_page=5`);
    const list = (data && Array.isArray(data.data)) ? data.data : [];
    const exact = list.find((x) => norm(x.name) === norm(name) || norm(x.short_name) === norm(name).replace(/ /g, ''));
    const pick = exact || list[0] || null;
    const id = pick ? pick.id : null;
    store.cacheSet('tpdb-id', key, id);
    return id;
}

const PER_PAGE = 40;

async function latestScenes(page = 1) {
    if (!hasToken()) return { titles: [], total: 0 };
    // Clip stores make up much of each page, so ask for two pages' worth.
    return cachedList(`/scenes?sort=date&per_page=${PER_PAGE * 2}&page=${page}`, 'scene', { filter: (s) => !isClipSite(s) });
}

async function performerScenes(name, page = 1) {
    if (!hasToken()) return { titles: [], total: 0 };
    const id = await findId('performers', name);
    if (!id) return { titles: [], total: 0 };
    return cachedList(`/performers/${encodeURIComponent(id)}/scenes?per_page=${PER_PAGE}&page=${page}`, 'scene');
}

async function siteScenes(name, page = 1) {
    if (!hasToken()) return { titles: [], total: 0 };
    const id = await findId('sites', name);
    if (!id) return { titles: [], total: 0 };
    return cachedList(`/sites/${encodeURIComponent(id)}/scenes?per_page=${PER_PAGE}&page=${page}`, 'scene');
}

async function movies(page = 1) {
    if (!hasToken()) return { titles: [], total: 0 };
    return cachedList(`/movies?per_page=${PER_PAGE}&page=${page}`, 'movie');
}

async function searchScenes(q, page = 1) {
    if (!hasToken()) return { titles: [], total: 0 };
    return cachedList(`/scenes?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}&page=${page}`, 'scene');
}

async function getMovie(uuid) {
    const hit = store.cacheGet('tpdb-scene', uuid, SCENE_TTL_MS);
    if (hit) return hit;
    if (!hasToken()) return null;
    try {
        const data = await apiGet('/movies/' + encodeURIComponent(uuid));
        const title = sceneToTitle(data && data.data, 'movie');
        if (title) store.cacheSet('tpdb-scene', uuid, title);
        return title;
    } catch {
        return null;
    }
}

module.exports = {
    hasToken, parseRelease, getScene, getMovie, sceneToTitle, plausible, releaseDate,
    latestScenes, performerScenes, siteScenes, movies, searchScenes, isClipSite,
};
