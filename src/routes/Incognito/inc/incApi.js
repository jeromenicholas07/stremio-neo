// Client for the addon's clearnet-catalog endpoints (/inc/*).
//
// The addon URL is the same one the rest of the Incognito tab uses
// (`incognito_addon_url`, default the bundled addon on 127.0.0.1:7000), so a
// dev addon on another port is picked up everywhere at once.
//
// The web UI ships instantly but the addon only updates when the launcher
// does, so the new catalog checks the addon's /version endpoint list first
// and the tab falls back to the old torrent rows when /inc/* is missing.

const ADDON_URL_KEY = 'incognito_addon_url';
const DEFAULT_ADDON_URL = 'http://127.0.0.1:7000';

function getAddonUrl() {
    try {
        const stored = localStorage.getItem(ADDON_URL_KEY);
        if (stored && stored.trim()) return stored.trim().replace(/\/+$/, '');
    } catch { /* storage blocked */ }
    return DEFAULT_ADDON_URL;
}

// Addon responses carry addon-relative URLs ("/inc/img?…", "/inc/play/…").
function abs(url) {
    if (typeof url !== 'string' || !url) return '';
    if (url.startsWith('/')) return getAddonUrl() + url;
    return url;
}

async function getJson(path, { signal, timeoutMs = 60000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    try {
        const res = await fetch(getAddonUrl() + path, { signal: controller.signal });
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

async function postJson(path, body) {
    const res = await fetch(getAddonUrl() + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

let supportPromise = null;
let supportFor = '';

/** Resolves true when the running addon has the /inc/* catalog. */
function isSupported() {
    const url = getAddonUrl();
    if (!supportPromise || supportFor !== url) {
        supportFor = url;
        supportPromise = getJson('/version', { timeoutMs: 5000 })
            .then((v) => Array.isArray(v && v.endpoints) && v.endpoints.includes('/inc/rows'))
            .catch(() => false);
    }
    return supportPromise;
}

// The addon resolves the catalog's Real-Debrid streams itself (the Player
// opens /inc/rd/… URLs and sends no page storage), so it keeps a copy of the
// RD token from Incognito Settings. Sent on save, and once per session when
// the addon reports it has none but this page does (e.g. after an update).
async function syncRdTokenToAddon(token) {
    try { await postJson('/inc/config', { realDebridToken: token || '' }); } catch { /* addon down or too old */ }
}

let rdSyncChecked = false;
async function ensureRdTokenSynced() {
    if (rdSyncChecked) return;
    rdSyncChecked = true;
    let local = '';
    try { local = (localStorage.getItem('rd_token') || '').trim(); } catch { /* storage blocked */ }
    if (!local) return;
    try {
        const config = await getJson('/inc/config', { timeoutMs: 5000 });
        if (config && config.realDebridTokenSet === false) await syncRdTokenToAddon(local);
    } catch { /* addon down or too old */ }
}

// Same encoding as the existing #/incognito/search/<q> links: one
// encodeURIComponent here, one decodeURIComponent in Incognito.js.
const titlePath = (id) => `#/incognito/title/${encodeURIComponent(id)}`;
const rowPath = (rowId) => `#/incognito/row/${encodeURIComponent(rowId)}`;

// "perf:Maya Woulfe" → "Maya Woulfe"; fixed rows get their display names.
const ROW_NAMES = {
    favorites: 'Favorites',
    trending: 'Trending this week',
    latest: 'Latest videos',
    top: 'Top rated',
    'scenes:latest': 'Studio releases with torrents',
    'scenes:available': 'Studio releases with torrents',
    'scenes:new': 'New scenes',
    movies: 'Full movies',
    amateur: 'Amateur & clips',
};
function rowName(rowId) {
    if (ROW_NAMES[rowId]) return ROW_NAMES[rowId];
    const m = String(rowId).match(/^(?:perf|tag|studio):(.+)$/);
    return m ? m[1] : rowId;
}

module.exports = {
    getAddonUrl, abs, getJson, postJson, isSupported, titlePath, rowPath, rowName,
    syncRdTokenToAddon, ensureRdTokenSynced,
};
