// Favorites: titles (tube videos and studio scenes), performers and
// categories. Stored in favorites.json in the shared data dir, so they
// survive addon updates and the web UI's localStorage pruning.
//
// Each favorite title keeps a snapshot of its card data, so the Favorites row
// renders even when a site is down — and, for scenes, the release keys and a
// search hint needed to find its streams again after a restart.

const store = require('./store');

const FILE = 'favorites.json';
const MAX_TITLES = 1000;
const SNAPSHOT_FIELDS = [
    'id', 'kind', 'site', 'siteId', 'siteName', 'tpdbId', 'studioShort', 'name', 'thumbnail', 'snapshots', 'duration',
    'views', 'rating', 'date', 'studio', 'performers', 'tags', 'releaseCount', 'seeders', 'qualities',
    'releases', 'searchHint', 'backdrop', 'description', 'performerImages',
];
const RELEASE_FIELDS = ['key', 'name', 'displayName', 'infoHash', 'seeders', 'peers', 'size', 'sizeLabel', 'quality', 'indexer', 'href', 'torrentId'];

function empty() {
    return { version: 1, titles: [], performers: [], studios: [], tags: [] };
}

let cache = null;

function get() {
    if (cache) return cache;
    const data = store.readJson(FILE, null);
    cache = data && Array.isArray(data.titles) ? { ...empty(), ...data } : empty();
    return cache;
}

function snapshotOf(title) {
    const out = {};
    for (const k of SNAPSHOT_FIELDS) if (title[k] !== undefined) out[k] = title[k];
    if (Array.isArray(out.snapshots)) out.snapshots = out.snapshots.slice(0, 15);
    if (Array.isArray(out.releases)) {
        out.releases = out.releases.slice(0, 8).map((r) => {
            const slim = {};
            for (const k of RELEASE_FIELDS) if (r && r[k] !== undefined) slim[k] = r[k];
            return slim;
        });
    }
    return out;
}

const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

/**
 * body: { op: 'add'|'remove'|'move', type: 'title'|'performer'|'tag', value, to? }
 *   title add    → value is the title object (snapshotted)
 *   title remove → value is the id (or the object)
 *   performer/tag → value is the name
 *   move         → reorder a performer/tag to index `to`
 */
function apply(body) {
    const fav = { ...get() };
    const { op, type } = body || {};
    const value = body && body.value;
    if (type === 'title') {
        const id = typeof value === 'string' ? value : value && value.id;
        if (!id) return fav;
        fav.titles = fav.titles.filter((t) => t.id !== id);
        if (op === 'add' && value && typeof value === 'object') {
            fav.titles.unshift({ id, addedAt: Date.now(), snapshot: snapshotOf(value) });
            fav.titles = fav.titles.slice(0, MAX_TITLES);
        }
    } else if (type === 'performer' || type === 'studio' || type === 'tag') {
        const key = { performer: 'performers', studio: 'studios', tag: 'tags' }[type];
        const name = String(value || '').trim().slice(0, 80);
        if (!name) return fav;
        const list = fav[key].filter((x) => !sameName(x.name, name));
        if (op === 'add') list.push({ name, addedAt: Date.now() });
        if (op === 'move') {
            const existing = fav[key].find((x) => sameName(x.name, name));
            if (existing) {
                const to = Math.max(0, Math.min(list.length, Number(body.to) || 0));
                list.splice(to, 0, existing);
            }
        }
        fav[key] = list;
    } else {
        return fav;
    }
    cache = fav;
    store.writeJson(FILE, fav);
    return fav;
}

module.exports = { get, apply };
