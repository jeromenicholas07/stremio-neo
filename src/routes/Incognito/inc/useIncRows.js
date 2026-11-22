// Home-page rows for the Incognito catalog.
//
// 1. GET /inc/rows → which rows to show (depends on your favorites).
// 2. GET /inc/row/<id> for each, at most 3 in flight.
//
// Rows paint from a small cache first (memory, then localStorage capped to
// the first cards of each row — row caches blew the quota once before) and
// refresh in the background. A studio-scene row the addon is still filling
// in from ThePornDB reports `pending`; it is fetched again a few times so the
// artwork appears without a reload.

const React = require('react');
const { getJson } = require('./incApi');

const LS_PREFIX = 'incognito_inc_row_v1:';
const LS_CARDS = 24;
const FRESH_MS = 15 * 60 * 1000;
const PENDING_RETRY_MS = 7000;
const PENDING_RETRIES = 4;
const CONCURRENCY = 3;

const mem = new Map(); // rowId → { ts, titles }

function readCached(rowId) {
    const m = mem.get(rowId);
    if (m) return m;
    try {
        const raw = JSON.parse(localStorage.getItem(LS_PREFIX + rowId) || 'null');
        if (raw && Array.isArray(raw.titles)) {
            mem.set(rowId, raw);
            return raw;
        }
    } catch { /* ignore */ }
    return null;
}

// A row the addon is still filling in is stored as already stale, so the
// next visit fetches it again instead of keeping placeholder cards.
function writeCached(rowId, titles, { stale = false } = {}) {
    const entry = { ts: stale ? 0 : Date.now(), titles };
    mem.set(rowId, entry);
    try {
        // Scenes carry their top releases (long torrent payloads); the
        // persisted copy only needs what a card shows.
        const slim = titles.slice(0, LS_CARDS).map((t) => (t && t.releases ? { ...t, releases: undefined } : t));
        localStorage.setItem(LS_PREFIX + rowId, JSON.stringify({ ts: entry.ts, titles: slim }));
    } catch { /* quota: memory cache still works */ }
}

function clearRowCaches() {
    mem.clear();
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
        }
    } catch { /* ignore */ }
}

async function fetchRow(rowId, signal) {
    return getJson(`/inc/row/${encodeURIComponent(rowId)}`, { signal, timeoutMs: 90000 });
}

/**
 * @param {string} favoritesKey changes when favorites change, so the row list
 *        (which has one row per favorite performer/category) is re-read.
 */
function useIncRows(favoritesKey) {
    const [rows, setRows] = React.useState(() => {
        const cachedList = readCached('__rows__');
        return cachedList ? cachedList.titles.map((r) => ({ ...r, ...rowState(r.id) })) : [];
    });
    const [error, setError] = React.useState(null);

    React.useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;
        const timers = [];
        let alive = true;

        const update = (rowId, patch) => {
            if (!alive) return;
            setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)));
        };

        const loadRow = async (row, attempt = 0) => {
            try {
                const res = await fetchRow(row.id, signal);
                const titles = Array.isArray(res.titles) ? res.titles : [];
                writeCached(row.id, titles, { stale: res.pending > 0 });
                update(row.id, { titles, status: 'ready' });
                if (res.pending > 0 && attempt < PENDING_RETRIES) {
                    timers.push(setTimeout(() => { loadRow(row, attempt + 1); }, PENDING_RETRY_MS));
                }
            } catch {
                if (signal.aborted) return;
                update(row.id, { status: readCached(row.id) ? 'ready' : 'error' });
            }
        };

        (async () => {
            let list;
            try {
                const res = await getJson('/inc/rows', { signal, timeoutMs: 10000 });
                list = Array.isArray(res.rows) ? res.rows : [];
                writeCached('__rows__', list);
            } catch (err) {
                if (signal.aborted) return;
                setError(err.message || String(err));
                return;
            }
            if (!alive) return;
            setRows(list.map((r) => ({ ...r, ...rowState(r.id) })));
            const stale = list.filter((r) => {
                const c = readCached(r.id);
                return !c || Date.now() - c.ts > FRESH_MS || r.id === 'favorites';
            });
            let next = 0;
            const worker = async () => {
                while (alive && next < stale.length) {
                    await loadRow(stale[next++]);
                }
            };
            await Promise.all(Array.from({ length: CONCURRENCY }, worker));
        })();

        return () => {
            alive = false;
            controller.abort();
            timers.forEach(clearTimeout);
        };
    }, [favoritesKey]);

    return { rows, error };
}

function rowState(rowId) {
    const c = readCached(rowId);
    return c ? { titles: c.titles, status: 'ready' } : { titles: [], status: 'loading' };
}

/** All titles of one row, page by page (the row's "see all" grid). */
function useIncRowPages(rowId) {
    const [state, setState] = React.useState(() => ({ titles: rowState(rowId).titles, page: 0, done: false, loading: true }));

    const loadPage = React.useCallback(async (page) => {
        setState((s) => ({ ...s, loading: true }));
        try {
            const res = await getJson(`/inc/row/${encodeURIComponent(rowId)}?page=${page}`, { timeoutMs: 90000 });
            const titles = Array.isArray(res.titles) ? res.titles : [];
            setState((s) => {
                const seen = new Set(page === 1 ? [] : s.titles.map((t) => t.id));
                const merged = page === 1 ? titles : [...s.titles, ...titles.filter((t) => !seen.has(t.id))];
                return { titles: merged, page, done: titles.length === 0 || rowId === 'favorites', loading: false };
            });
        } catch {
            setState((s) => ({ ...s, loading: false, done: true }));
        }
    }, [rowId]);

    React.useEffect(() => { loadPage(1); }, [loadPage]);

    const stateRef = React.useRef(state);
    stateRef.current = state;
    const more = React.useCallback(() => {
        const s = stateRef.current;
        if (!s.loading && !s.done) loadPage(s.page + 1);
    }, [loadPage]);

    return { ...state, more };
}

module.exports = { useIncRows, useIncRowPages, clearRowCaches, LS_PREFIX };
