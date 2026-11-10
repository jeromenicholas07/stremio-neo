// Hook behind the "Claude recommended" Board row.
//
// The picks are not computed here. A weekly Claude run on the user's own
// machine writes them to a local file, and the launcher serves that file at
// /_launcher/claude-recs. In return this hook hands the launcher a snapshot of
// what the user has watched/rated/queued (titles only — no tokens, no account
// name) for the next run to read.
//
// Everything is opt-in by presence of that file: with no launcher (plain
// browser, mobile) or no file (user doesn't run Claude) the fetch yields
// nothing, the row never renders and no snapshot is sent.

const React = require('react');
const traktBridge = require('stremio/services/TraktBridge');
const { isMobile } = require('stremio/common/Platform/device');
const { enrichItem } = require('./useTraktLists');

const LAUNCHER_API = 'http://127.0.0.1:12470';
const TASTE_EXPORT_KEY = 'claude_taste_exported_at';
const TASTE_EXPORT_INTERVAL = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 30;
const MAX_HISTORY = 600;

const slim = (item) => ({
    id: item.id,
    name: item.name,
    type: item.type,
    year: item.year || null,
});

function readLibrary() {
    try {
        const data = JSON.parse(localStorage.getItem('library_recent') || '{}');
        return Object.entries(data?.items || {})
            .filter(([, item]) => item?.name)
            .map(([id, item]) => ({
                id,
                name: item.name,
                type: item.type || null,
                // "removed" entries are titles played without being saved —
                // still a watch signal, just not a deliberate library add.
                saved: !item.removed,
                lastWatched: item.state?.lastWatched || null,
                timesWatched: item.state?.timesWatched || 0,
            }));
    } catch {
        return [];
    }
}

function buildTasteSnapshot() {
    return {
        exportedAt: new Date().toISOString(),
        watched: traktBridge.getWatchedItems().slice(0, MAX_HISTORY)
            .map((item) => ({ ...slim(item), watchedAt: item.watchedAt || null })),
        ratings: traktBridge.getRatings(),
        watchlist: traktBridge.getWatchlistItems().map(slim),
        notInterested: traktBridge.getNotInterestedItems().map(slim),
        library: readLibrary(),
    };
}

// At most once a day, and only after Trakt has something to say (or there is
// a local library) so an early mount doesn't overwrite a good snapshot with
// an empty one.
function exportTasteSnapshot() {
    try {
        const last = parseInt(localStorage.getItem(TASTE_EXPORT_KEY) || '0', 10);
        if (Date.now() - last < TASTE_EXPORT_INTERVAL) return;
        const snapshot = buildTasteSnapshot();
        if (snapshot.watched.length === 0 && snapshot.library.length === 0) return;
        // Trakt connected but not synced yet: wait for its onChange instead of
        // spending today's export on a library-only snapshot.
        if (traktBridge.isConfigured() && snapshot.watched.length === 0 && snapshot.ratings.length === 0) return;
        fetch(`${LAUNCHER_API}/_launcher/claude-taste`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(snapshot),
        })
            .then((res) => res.ok ? res.json() : null)
            .then((result) => {
                if (result?.ok) localStorage.setItem(TASTE_EXPORT_KEY, String(Date.now()));
            })
            .catch(() => { /* launcher not running */ });
    } catch { /* storage unavailable */ }
}

function toRawItem(pick) {
    const imdbId = typeof pick?.imdbId === 'string' && /^tt\d+$/.test(pick.imdbId) ? pick.imdbId : null;
    if (!imdbId || typeof pick.name !== 'string' || !pick.name) return null;
    return {
        id: imdbId,
        imdbId,
        name: pick.name,
        type: pick.type === 'series' ? 'series' : 'movie',
        year: pick.year || null,
    };
}

function useClaudeRecommended() {
    const [items, setItems] = React.useState([]);

    React.useEffect(() => {
        if (isMobile) return;
        let cancelled = false;
        let unsub = null;

        (async () => {
            let picks;
            try {
                const res = await fetch(`${LAUNCHER_API}/_launcher/claude-recs`);
                if (!res.ok) return;
                const data = await res.json();
                picks = data?.items;
            } catch {
                return; // no launcher
            }
            if (!Array.isArray(picks) || cancelled) return; // no file → feature off

            exportTasteSnapshot();
            unsub = traktBridge.onChange(exportTasteSnapshot);

            const raw = picks.map(toRawItem).filter(Boolean).slice(0, MAX_ITEMS);
            if (raw.length === 0) return;
            const enriched = await Promise.all(raw.map(enrichItem));
            if (!cancelled) setItems(enriched.filter((item) => item.name && item.poster));
        })();

        return () => {
            cancelled = true;
            if (unsub) unsub();
        };
    }, []);

    return items;
}

module.exports = useClaudeRecommended;
