// Hybrid torrent search — fast direct sources + Prowlarr supplement.
//
// Runs every direct adapter (apibay, Knaben, Torrents-CSV) AND Prowlarr in
// parallel. Direct adapters are fast (~1-2s) and reliable; Prowlarr adds
// niche breadth but is slow, so it only gets whatever's left of a hard
// ~6s budget — a slow Prowlarr (or any dead adapter) never blocks the
// response. Prowlarr is asked per indexer, so the fast ones (PornoLab)
// make the budget even when a slow one (XXXClub) doesn't. Results are
// merged, deduped, and sorted by seeders.

const { LRUCache } = require('lru-cache');
const { SOURCES } = require('./directSources');
const { searchProwlarr, listSearchIndexers } = require('./prowlarr');
const { fingerprint } = require('./dedup');

// Total wall-clock budget for a search. Direct adapters resolve well
// inside this; Prowlarr gets the remainder as a grace window. Callers with
// more patience (a title page) pass a longer `deadlineMs`.
const HARD_DEADLINE_MS = 6000;

// Prowlarr answers that arrived after the budget are kept for a while, so
// the next search for the same query (a refetch, the title page after the
// search page) gets them at once instead of waiting again.
const prowlarrRecent = new LRUCache({ max: 1000, ttl: 10 * 60 * 1000 });
// Searches still running, so a second request for the same query (the
// page asking again while matches are pending) joins it instead of
// queueing another one behind it in Prowlarr.
const prowlarrInFlight = new Map();

// One Prowlarr search (one indexer, or all), shared and remembered.
function prowlarrJob(opts) {
    const key = JSON.stringify(opts || {});
    const recent = prowlarrRecent.get(key);
    if (recent) return Promise.resolve(recent);
    if (prowlarrInFlight.has(key)) return prowlarrInFlight.get(key);
    const p = safeArray(() => searchProwlarr(opts)).then((r) => {
        prowlarrInFlight.delete(key);
        // Only answers with results: a failed search also comes back empty.
        if (r.length) prowlarrRecent.set(key, r);
        return r;
    });
    prowlarrInFlight.set(key, p);
    return p;
}

function delay(ms, value) {
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// Run a producer, never throw, always resolve to an array.
async function safeArray(producer) {
    try {
        const r = await producer();
        return Array.isArray(r) ? r : [];
    } catch (err) {
        return [];
    }
}

/**
 * @param {Object}  opts
 * @param {string}  opts.query        search query
 * @param {number}  opts.cat          0 = all, 500 = adult (for direct adapters)
 * @param {Object}  opts.prowlarrOpts options forwarded verbatim to searchProwlarr
 * @param {number}  [opts.deadlineMs] total budget (default HARD_DEADLINE_MS)
 * @returns {Promise<Array>} merged, deduped, seeders-sorted normalized items;
 *   the array's `prowlarrLate` is true when Prowlarr missed the budget
 */
async function hybridSearch({ query, cat, prowlarrOpts, deadlineMs = HARD_DEADLINE_MS }) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) return [];

    const start = Date.now();

    // Fire all direct adapters in parallel — each failure-isolated.
    const directPromise = Promise.all(
        SOURCES.map((src) => safeArray(() => src.search({ query: q, cat })))
    ).then((lists) => lists.flat());

    // Prowlarr runs alongside, one search per indexer: its combined search
    // waits for the slowest indexer (XXXClub spaces its requests 3 s apart,
    // so a few concurrent searches queue for many seconds), which held back
    // PornoLab's sub-2 s answers. Whatever indexers answer within the budget
    // are used; the rest are remembered for the next search.
    // Indexers a direct adapter already covers (XXXClub) aren't asked twice.
    // When Prowlarr's indexer list can't be read, one combined search.
    const coveredByDirect = new Set(SOURCES.map((s) => s.prowlarrName).filter(Boolean).map((n) => n.toLowerCase()));
    const listed = await listSearchIndexers().catch(() => null);
    const jobs = listed
        ? listed
            .filter((ix) => !coveredByDirect.has(String(ix.name).toLowerCase()))
            .map((ix) => ({ ...prowlarrOpts, indexerIds: [ix.id], timeoutMs: 30000 }))
        : [prowlarrOpts];
    const settled = [];
    const prowlarrPromises = jobs.map((opts) => prowlarrJob(opts).then((r) => { settled.push(r); }));

    // Await the fast tier first, then hand Prowlarr only the leftover budget.
    const direct = await directPromise;
    const remaining = Math.max(0, deadlineMs - (Date.now() - start));
    await Promise.race([Promise.all(prowlarrPromises), delay(remaining)]);
    const prowlarr = settled.flat();
    const answered = settled.length === jobs.length ? true : null;

    // Merge + dedupe. Key on infoHash when present, else a title/url
    // fingerprint. On collision keep the higher-seeder copy.
    const byKey = new Map();
    for (const item of [...direct, ...prowlarr]) {
        if (!item) continue;
        const hash = typeof item.infoHash === 'string' ? item.infoHash.toLowerCase() : '';
        const key = /^[a-f0-9]{40}$/.test(hash)
            ? `h:${hash}`
            : `f:${fingerprint(item.downloadUrl || '', item.title || '')}`;
        const existing = byKey.get(key);
        if (!existing || (Number(item.seeders) || 0) > (Number(existing.seeders) || 0)) {
            byKey.set(key, item);
        }
    }

    const merged = Array.from(byKey.values());
    merged.sort((a, b) => (Number(b.seeders) || 0) - (Number(a.seeders) || 0));
    if (answered === null) merged.prowlarrLate = true;
    return merged;
}

module.exports = { hybridSearch };
