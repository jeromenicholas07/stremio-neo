// Incognito search history, kept on this PC only: search-history.json in the
// Incognito data dir (next to favorites.json). Nothing is sent anywhere; it
// exists so searches can be improved later from what you actually typed and
// which result you opened.
//
// One entry per search: the query, what came back (counts, recognised
// performers/studio, a typo correction) and the results you opened, with
// their position. The same query again within REPEAT_WINDOW_MS updates the
// entry (the page re-asks while releases are still being matched).

const store = require('./store');

const FILE = 'search-history.json';
const MAX_ENTRIES = 1000;
const MAX_CLICKS = 20;
const REPEAT_WINDOW_MS = 30 * 60 * 1000;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const clip = (s, n) => String(s || '').slice(0, n);

let cache = null;
function entries() {
    if (!cache) {
        const data = store.readJson(FILE, null);
        cache = data && Array.isArray(data.searches) ? data.searches : [];
    }
    return cache;
}

function save() {
    try { store.writeJson(FILE, { version: 1, searches: cache }); } catch { /* disk full: history is best-effort */ }
}

/** Record a search and what it returned. */
function recordSearch(query, result, now = Date.now()) {
    const q = clip(norm(query), 200);
    if (!q) return null;
    const titles = (result && result.titles) || [];
    const pro = titles.filter((t) => t && (t.kind === 'scene' || t.kind === 'movie'));
    const summary = {
        results: titles.length,
        scenes: pro.length,
        playable: pro.filter((t) => t.releaseCount > 0 && t.seeders >= 5).length,
        entities: ((result && result.entities) || []).map((e) => ({ kind: e.kind, name: clip(e.name, 80) })),
        correctedTo: result && result.correctedTo ? clip(result.correctedTo, 200) : null,
        pending: (result && result.pending) || 0,
    };
    const list = entries().slice();
    const i = list.findIndex((e) => e.q === q && now - (e.at || 0) < REPEAT_WINDOW_MS);
    let entry;
    if (i !== -1) {
        entry = { ...list[i], ...summary, at: now, asked: (list[i].asked || 1) + 1 };
        list.splice(i, 1);
    } else {
        entry = { q, ...summary, at: now, asked: 1, clicks: [] };
    }
    list.unshift(entry);
    cache = list.slice(0, MAX_ENTRIES);
    save();
    return entry;
}

/** Record that a search result was opened (its 0-based position). */
function recordClick(query, title, rank, now = Date.now()) {
    const q = clip(norm(query), 200);
    if (!q || !title || typeof title.id !== 'string') return false;
    const list = entries().slice();
    const i = list.findIndex((e) => e.q === q);
    if (i === -1) return false;
    const click = {
        id: clip(title.id, 300),
        name: clip(title.name, 160),
        rank: Number.isInteger(rank) && rank >= 0 ? rank : null,
        at: now,
    };
    list[i] = { ...list[i], clicks: [click, ...(list[i].clicks || [])].slice(0, MAX_CLICKS) };
    cache = list;
    save();
    return true;
}

function recent(n = 50) {
    return entries().slice(0, n);
}

function _reset() { cache = null; }

module.exports = { recordSearch, recordClick, recent, _reset };
