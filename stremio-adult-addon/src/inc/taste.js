// Recommendations input: what you play, what you favorite, and Claude's
// weekly picks. Three plain JSON files in the Incognito data dir:
//
//   plays.json           written here: the last 200 Incognito plays
//                        (title, studio, performers, tags; no stream data)
//   claude-picks.json    written by a weekly Claude run on this PC (read here)
//   claude-taste.json    written here for that run to read
//
// The picks file is the opt-in, as with the Board's "Claude recommended"
// row: until something creates it, no taste snapshot is written and the
// "Claude picks" row doesn't exist. The local "More like what you like" row
// needs nothing but plays.json and favorites.json.

const store = require('./store');
const favorites = require('./favorites');
const searchHistory = require('./searchHistory');

const PLAYS_FILE = 'plays.json';
const PICKS_FILE = 'claude-picks.json';
const TASTE_FILE = 'claude-taste.json';
const MAX_PLAYS = 200;
// A replay of the same title within this window updates the entry instead of
// adding another (seeks, retries and reopenings aren't new plays).
const REPLAY_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_PICKS = 20;
// Order matters: a scene pick may also name its studio, so `scene` is
// checked before `studio`.
const PICK_KINDS = ['scene', 'performer', 'studio', 'tag', 'query'];

const clean = (s, n = 120) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const names = (list, n) => (Array.isArray(list) ? list : []).map((x) => clean(typeof x === 'string' ? x : x && x.name, 80)).filter(Boolean).slice(0, n);
const lower = (s) => clean(s).toLowerCase();

let playsCache = null;
function plays() {
    if (!playsCache) {
        const data = store.readJson(PLAYS_FILE, null);
        playsCache = data && Array.isArray(data.plays) ? data.plays : [];
    }
    return playsCache;
}

function slimTitle(t) {
    return {
        id: clean(t.id, 300),
        name: clean(t.name),
        studio: clean(t.studio, 80),
        performers: names(t.performers, 8),
        tags: names(t.tags, 10),
    };
}

/** Record that an Incognito title started playing. `title` is its card data. */
function recordPlay(title, now = Date.now()) {
    if (!title || !title.id || !title.name) return false;
    const entry = { ...slimTitle(title), at: now };
    const list = plays().slice();
    const i = list.findIndex((p) => p.id === entry.id);
    if (i !== -1 && now - (list[i].at || 0) < REPLAY_WINDOW_MS) {
        list.splice(i, 1);
    } else if (i !== -1) {
        entry.count = (list[i].count || 1) + 1;
        list.splice(i, 1);
    }
    list.unshift(entry);
    playsCache = list.slice(0, MAX_PLAYS);
    store.writeJson(PLAYS_FILE, { version: 1, plays: playsCache });
    exportTaste();
    return true;
}

function optedIn() {
    return readPicks() !== null;
}

/**
 * The picks file, validated, or null when it doesn't exist (feature off).
 * Shape: { generatedAt, picks: [{ performer|studio|tag|query|scene: "...",
 * studio?: "...", reason: "..." }] }. Unknown kinds and empty values are
 * dropped; the file is data only.
 */
function readPicks() {
    const data = store.readJson(PICKS_FILE, null);
    if (!data || typeof data !== 'object' || !Array.isArray(data.picks)) return null;
    const picks = [];
    for (const p of data.picks) {
        if (!p || typeof p !== 'object') continue;
        const kind = PICK_KINDS.find((k) => typeof p[k] === 'string' && clean(p[k]));
        if (!kind) continue;
        picks.push({
            kind,
            value: clean(p[kind], 120),
            studio: kind === 'scene' ? clean(p.studio, 80) : '',
            reason: clean(p.reason, 200),
        });
        if (picks.length >= MAX_PICKS) break;
    }
    return { generatedAt: clean(data.generatedAt, 40), picks };
}

function tasteSnapshot() {
    const fav = favorites.get();
    return {
        exportedAt: new Date().toISOString(),
        favorites: {
            titles: fav.titles.map((f) => f.snapshot && slimTitle(f.snapshot)).filter(Boolean).slice(0, 300),
            performers: fav.performers.map((p) => p.name),
            studios: (fav.studios || []).map((s) => s.name),
            tags: fav.tags.map((t) => t.name),
        },
        // Ids are addon-internal; the picks run only needs names.
        plays: plays().map((p) => ({ ...p, id: undefined })),
        // What you searched for (queries and recognised names only).
        searches: searchHistory.recent(50).map((s) => ({ q: s.q, at: s.at, entities: s.entities })),
    };
}

/** Write claude-taste.json, only when the picks file exists (opt-in). */
function exportTaste() {
    if (!optedIn()) return false;
    try {
        store.writeJson(TASTE_FILE, tasteSnapshot());
        return true;
    } catch {
        return false;
    }
}

/**
 * Local "more like what you like": performers, studios and categories that
 * keep coming up in your favorites (weight 2) and plays (weight 1), minus
 * the ones you already follow (they have rows of their own). A thing needs
 * a score of at least 2 to count, so one stray play doesn't make a row.
 */
function localSignals({ performers = 4, studios = 1, tags = 2 } = {}) {
    const fav = favorites.get();
    const followed = new Set([
        ...fav.performers.map((p) => `performer:${lower(p.name)}`),
        ...(fav.studios || []).map((s) => `studio:${lower(s.name)}`),
        ...fav.tags.map((t) => `tag:${lower(t.name)}`),
    ]);
    const scores = new Map();
    const bump = (kind, name, w) => {
        const key = `${kind}:${lower(name)}`;
        if (!lower(name) || followed.has(key)) return;
        const cur = scores.get(key) || { kind, name: clean(name, 80), score: 0 };
        cur.score += w;
        scores.set(key, cur);
    };
    const add = (t, w) => {
        for (const p of names(t.performers, 8)) bump('performer', p, w);
        if (t.studio) bump('studio', t.studio, w);
        for (const g of names(t.tags, 10)) bump('tag', g, w * 0.5);
    };
    for (const f of fav.titles) if (f.snapshot) add(f.snapshot, 2);
    for (const p of plays()) add(p, 1);
    const ranked = [...scores.values()].filter((s) => s.score >= 2).sort((a, b) => b.score - a.score);
    const top = (kind, n) => ranked.filter((s) => s.kind === kind).slice(0, n);
    return [...top('performer', performers), ...top('studio', studios), ...top('tag', tags)];
}

/** Ids already favorited or played: recommendation rows leave them out. */
function seenIds() {
    return new Set([...favorites.get().titles.map((f) => f.id), ...plays().map((p) => p.id)]);
}

function _reset() { playsCache = null; }

module.exports = { recordPlay, readPicks, exportTaste, tasteSnapshot, localSignals, seenIds, plays, _reset };
