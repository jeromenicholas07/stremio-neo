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
const { getJson, postJson, rowPath } = require('./incApi');
const sections = require('./searchSections');
const useGridZoom = require('./useGridZoom');
const styles = require('./IncSearchResults.less');

// A cold search (empty release cache) needs about a minute to match all its
// torrent releases to scenes: measured 2026-11-22 on "Angela White",
// healthy titles went 0 → 5 → 8 → 14 → 15 → 19 at 8 s steps. Keep asking
// while anything is pending, for up to ~70 s.
const PENDING_RETRY_MS = 8000;
const PENDING_RETRIES = 9;
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
                const value = {
                    titles: Array.isArray(res.titles) ? res.titles : [],
                    pending: res.pending || 0,
                    // A typo the addon corrected ("lena pual" → "Lena Paul"),
                    // the performers / studio it recognised, and how many
                    // leading results feature every named performer.
                    correctedTo: typeof res.correctedTo === 'string' ? res.correctedTo : null,
                    entities: Array.isArray(res.entities)
                        ? res.entities.filter((e) => e && typeof e.name === 'string')
                        : (res.entity && typeof res.entity.name === 'string' ? [res.entity] : []),
                    together: Number(res.together) || 0,
                };
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

const nameList = (names) => (names.length <= 2 ? names.join(' & ') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`);

function IncSearchResults({ query }) {
    const { titles, loading, error, pending, correctedTo, entities = [], together: togetherCount } = useIncSearch(query);
    const { together, pro, tube, playable, scenes } = React.useMemo(() => sections(titles, togetherCount), [titles, togetherCount]);
    const performers = entities.filter((e) => e.kind === 'performer').map((e) => e.name);
    const [zoomRef, gridStyle] = useGridZoom();

    // Search history (kept by the local addon only): which result was opened,
    // and at what position on the page.
    const shown = React.useMemo(() => [...together, ...pro, ...tube], [together, pro, tube]);
    const onClickCapture = React.useCallback((event) => {
        const a = event.target && event.target.closest && event.target.closest('a[href*="#/incognito/title/"]');
        if (!a || (event.target.closest && event.target.closest('button'))) return;
        const id = decodeURIComponent(a.getAttribute('href').split('#/incognito/title/')[1] || '');
        const rank = shown.findIndex((t) => t.id === id);
        const title = shown[rank];
        if (!title) return;
        postJson('/inc/search-click', { q: query, title: { id: title.id, name: title.name }, rank }).catch(() => { /* older addon */ });
    }, [shown, query]);

    return (
        <div ref={zoomRef} className={styles['root']} onClickCapture={onClickCapture}>
            <div className={styles['header']}>
                <div className={styles['title']}>Results for &ldquo;{query}&rdquo;</div>
                {!loading && scenes ? (
                    <div className={styles['meta']}>
                        {playable} of {scenes} studio titles ready to play over P2P{pending > 0 ? ' · still matching torrents…' : ''}
                    </div>
                ) : null}
            </div>
            {!loading && (correctedTo || entities.length) ? (
                <div className={styles['entity']}>
                    {correctedTo ? <span>Showing results for &ldquo;{correctedTo}&rdquo;. </span> : null}
                    {entities.map((e) => (
                        <a key={`${e.kind}:${e.name}`} href={rowPath(e.kind === 'performer' ? `perf:${e.name}` : `studio:${e.name}`)}>
                            {e.kind === 'performer' ? 'All scenes with' : 'All scenes from'} {e.name} ›
                        </a>
                    ))}
                </div>
            ) : null}
            {loading ? (
                <div className={styles['message']}>Searching studios, sites and torrents… (this can take 10–20 s)</div>
            ) : error ? (
                <div className={styles['message']}>Search failed. Is the Incognito addon running?</div>
            ) : titles.length === 0 ? (
                <div className={styles['message']}>No catalog results for &ldquo;{query}&rdquo;.</div>
            ) : (
                <React.Fragment>
                    {performers.length > 1 ? (
                        <section className={styles['section']}>
                            <div className={styles['section-title']}>Scenes with {nameList(performers)}</div>
                            {together.length ? (
                                <div className={styles['grid']} style={gridStyle}>
                                    {together.map((t) => <IncTitleCard key={t.id} {...t} />)}
                                </div>
                            ) : (
                                <div className={styles['note']}>No scene with all of them found; their own scenes are below.</div>
                            )}
                        </section>
                    ) : null}
                    {pro.length ? (
                        <section className={styles['section']}>
                            <div className={styles['section-title']}>
                                {performers.length > 1 ? `More with ${nameList(performers)}` : 'Studio scenes & movies'}
                            </div>
                            <div className={styles['grid']} style={gridStyle}>
                                {pro.map((t) => <IncTitleCard key={t.id} {...t} />)}
                            </div>
                        </section>
                    ) : null}
                    {tube.length ? (
                        <section className={styles['section']}>
                            <div className={styles['section-title']}>Amateur &amp; clips</div>
                            <div className={styles['grid']} style={gridStyle}>
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
