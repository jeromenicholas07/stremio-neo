// Favorites (titles, performers, categories) for the Incognito catalog.
//
// The addon's favorites.json is the source of truth (it survives addon
// updates and localStorage pruning). A small localStorage mirror — ids and
// names only, plus the first few title cards — lets the page paint ♥ states
// and the Favorites row before the addon answers.

const React = require('react');
const { getJson, postJson } = require('./incApi');

const MIRROR_KEY = 'incognito_inc_favorites_v1';
const MIRROR_CARDS = 30;

let state = readMirror();
let loaded = false;
let loading = null;
const listeners = new Set();

function readMirror() {
    try {
        const raw = JSON.parse(localStorage.getItem(MIRROR_KEY) || 'null');
        if (raw && Array.isArray(raw.titles)) return raw;
    } catch { /* ignore */ }
    return { titles: [], performers: [], studios: [], tags: [] };
}

function writeMirror(fav) {
    try {
        localStorage.setItem(MIRROR_KEY, JSON.stringify({
            titles: fav.titles.map((t, i) => (i < MIRROR_CARDS
                ? { ...t, snapshot: t.snapshot && t.snapshot.releases ? { ...t.snapshot, releases: undefined } : t.snapshot }
                : { id: t.id })),
            performers: fav.performers,
            studios: fav.studios,
            tags: fav.tags,
        }));
    } catch { /* quota: the addon still has everything */ }
}

function set(fav) {
    state = {
        titles: Array.isArray(fav.titles) ? fav.titles : [],
        performers: Array.isArray(fav.performers) ? fav.performers : [],
        studios: Array.isArray(fav.studios) ? fav.studios : [],
        tags: Array.isArray(fav.tags) ? fav.tags : [],
    };
    writeMirror(state);
    listeners.forEach((fn) => fn(state));
}

function load() {
    if (loading) return loading;
    loading = getJson('/inc/favorites', { timeoutMs: 8000 })
        .then((fav) => { loaded = true; set(fav); })
        .catch(() => { /* addon down: keep the mirror */ })
        .finally(() => { loading = null; });
    return loading;
}

async function change(body) {
    try {
        set(await postJson('/inc/favorites', body));
    } catch (err) {
        console.warn('[incognito] favorite change failed', err);
    }
}

const sameName = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

const actions = {
    isTitle: (id) => state.titles.some((t) => t.id === id),
    isPerformer: (name) => state.performers.some((p) => sameName(p.name, name)),
    isStudio: (name) => (state.studios || []).some((x) => sameName(x.name, name)),
    isTag: (name) => state.tags.some((t) => sameName(t.name, name)),
    toggleTitle: (title) => {
        if (!title || !title.id) return;
        const on = actions.isTitle(title.id);
        // Optimistic: flip the ♥ immediately.
        set({
            ...state,
            titles: on
                ? state.titles.filter((t) => t.id !== title.id)
                : [{ id: title.id, addedAt: Date.now(), snapshot: title }, ...state.titles],
        });
        return change({ op: on ? 'remove' : 'add', type: 'title', value: on ? title.id : title });
    },
    togglePerformer: (name) => change({ op: actions.isPerformer(name) ? 'remove' : 'add', type: 'performer', value: name }),
    toggleStudio: (name) => change({ op: actions.isStudio(name) ? 'remove' : 'add', type: 'studio', value: name }),
    toggleTag: (name) => change({ op: actions.isTag(name) ? 'remove' : 'add', type: 'tag', value: name }),
    move: (type, name, to) => change({ op: 'move', type, value: name, to }),
};

function useIncFavorites() {
    const [fav, setFav] = React.useState(state);
    React.useEffect(() => {
        listeners.add(setFav);
        if (!loaded) load();
        return () => { listeners.delete(setFav); };
    }, []);
    return { favorites: fav, ...actions, reload: () => { loaded = false; return load(); } };
}

module.exports = useIncFavorites;
module.exports.favoritesActions = actions;
module.exports.MIRROR_KEY = MIRROR_KEY;
