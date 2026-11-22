// Clearnet search: the addon's /inc/search (ThePornDB scenes and movies,
// torrent releases matched to scenes, tube videos) as catalog cards. Each
// card opens the Stremio-style title page, whose stream list auto-picks
// across every release found for that scene.
//
// Results stay in memory per query, so going back from a title page shows
// them at once. Scenes whose releases were still being matched when the
// answer came back ("pending") are fetched again a couple of times.

const React = require('react');
const IncTitleCard = require('./IncTitleCard');
const { getJson } = require('./incApi');
const sections = require('./searchSections');
const styles = require('./IncSearchResults.less');

const PENDING_RETRY_MS = 8000;
const PENDING_RETRIES = 2;
const MAX_CACHED_QUERIES = 20;
const cache = new Map(); // query → { titles, pending }

function remember(query, value) {
    cache.delete(query);
    cache.set(query, value);
    while (cache.size > MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value);
}

function useIncSearch(query) {
    const q = String(query || '').trim();
    const [state, setState] = React.useState(() => ({ ...(cache.get(q) || { titles: [], pending: 0 }), loading: !cache.has(q), error: false }));

    React.useEffect(() => {
        if (!q) return undefined;
        const controller = new AbortController();
        let timer = null;
        const cached = cache.get(q);
        setState({ ...(cached || { titles: [], pending: 0 }), loading: !cached, error: false });
        const load = async (attempt) => {
            try {
                const res = await getJson(`/inc/search?q=${encodeURIComponent(q)}`, { signal: controller.signal, timeoutMs: 90000 });
                const value = { titles: Array.isArray(res.titles) ? res.titles : [], pending: res.pending || 0 };
                remember(q, value);
                setState({ ...value, loading: false, error: false });
                if (value.pending > 0 && attempt < PENDING_RETRIES) {
                    timer = setTimeout(() => load(attempt + 1), PENDING_RETRY_MS);
                }
            } catch {
                if (controller.signal.aborted) return;
                setState((s) => ({ ...s, loading: false, error: s.titles.length === 0 }));
            }
        };
        // A cached answer with nothing pending is final for this visit.
        if (!cached || cached.pending > 0) load(0);
        return () => { controller.abort(); clearTimeout(timer); };
    }, [q]);

    return state;
}

function IncSearchResults({ query }) {
    const { titles, loading, error, pending } = useIncSearch(query);
    const { pro, tube, playable } = React.useMemo(() => sections(titles), [titles]);

    return (
        <div className={styles['root']}>
            <div className={styles['header']}>
                <div className={styles['title']}>Results for &ldquo;{query}&rdquo;</div>
                {!loading && pro.length ? (
                    <div className={styles['meta']}>
                        {playable} of {pro.length} studio titles ready to play over P2P{pending > 0 ? ' · still matching torrents…' : ''}
                    </div>
                ) : null}
            </div>
            {loading ? (
                <div className={styles['message']}>Searching studios, sites and torrents… (this can take 10–20 s)</div>
            ) : error ? (
                <div className={styles['message']}>Search failed. Is the Incognito addon running?</div>
            ) : titles.length === 0 ? (
                <div className={styles['message']}>No catalog results for &ldquo;{query}&rdquo;.</div>
            ) : (
                <React.Fragment>
                    {pro.length ? (
                        <section className={styles['section']}>
                            <div className={styles['section-title']}>Studio scenes &amp; movies</div>
                            <div className={styles['grid']}>
                                {pro.map((t) => <IncTitleCard key={t.id} {...t} />)}
                            </div>
                        </section>
                    ) : null}
                    {tube.length ? (
                        <section className={styles['section']}>
                            <div className={styles['section-title']}>Amateur &amp; clips</div>
                            <div className={styles['grid']}>
                                {tube.map((t) => <IncTitleCard key={t.id} {...t} />)}
                            </div>
                        </section>
                    ) : null}
                </React.Fragment>
            )}
        </div>
    );
}

module.exports = IncSearchResults;
