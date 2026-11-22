// Incognito title page, built from Stremio's own details page parts so it
// looks and behaves the same: the MetaDetails layout and styles, MetaPreview
// for the title, and StreamsList for the streams (source picker, auto-pick,
// preflight, "Playing best…").
//
// The difference is where the data comes from. Nothing goes through
// stremio-core (the Incognito addon is never installed there, so nothing
// reaches Library or Continue Watching): the title and streams come from the
// addon's /inc/* endpoints, and the page builds the shapes StreamsList
// expects from core — stream groups per source, each stream with a
// `deepLinks.player` link that plays it without a library item.

const React = require('react');
const { HorizontalNavBar, Image, MetaPreview } = require('stremio/components');
const { withCoreSuspender } = require('stremio/common');
const StreamsList = require('stremio/routes/MetaDetails/StreamsList');
const mdStyles = require('stremio/routes/MetaDetails/styles');
const { getJson, abs } = require('./incApi');
const useIncFavorites = require('./useIncFavorites');
const { encodeStreamForCore } = require('../useIncognitoPlay');
const { p2pEligibility } = require('./p2pEligibility');

const SOURCES = {
    torrents: { transportUrl: 'incognito://torrents', manifest: { name: 'Torrents' } },
    clearnet: { transportUrl: 'incognito://clearnet', manifest: { name: 'Clearnet' } },
};

const rowLink = (rowId) => `stremio:///incognito/row/${encodeURIComponent(rowId)}`;

function formatRuntime(seconds) {
    if (!seconds) return undefined;
    const m = Math.round(seconds / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}min` : `${m} min`;
}

// The stream as the Player gets it: only Stremio stream fields, absolute URLs.
function playerStream(s) {
    const out = { name: s.name, description: s.description };
    if (s.url) out.url = abs(s.url);
    if (s.infoHash) out.infoHash = s.infoHash;
    if (Array.isArray(s.sources)) out.sources = s.sources;
    if (s.behaviorHints) out.behaviorHints = s.behaviorHints;
    return out;
}

// Only P2P streams auto-pick may try join its "Main add-on (P2P)" bucket;
// the rules (1080p preferred, 4K only as a fallback) are in p2pEligibility.
async function withDeepLinks(streams, titleId) {
    const healthy = p2pEligibility(streams);
    return Promise.all(streams.map(async (s) => {
        if (s.externalHref) {
            // A release without an infoHash: the existing torrent screen resolves it.
            return { ...s, deepLinks: { player: s.externalHref } };
        }
        const stream = playerStream(s);
        try {
            const encoded = await encodeStreamForCore(stream);
            // `source` only groups the list and `incognitoP2P` puts P2P streams
            // in auto-pick's "Main add-on (P2P)" bucket; the encoded copy the
            // Player gets leaves both out.
            return {
                ...stream,
                source: s.source,
                incognitoP2P: Boolean(stream.infoHash) && healthy(s),
                // ?incognito=<id> lets the Player send a failed auto-pick back here.
                deepLinks: { player: `#/player/${encodeURIComponent(encoded)}?incognito=${encodeURIComponent(titleId)}` },
            };
        } catch {
            return null;
        }
    })).then((list) => list.filter(Boolean));
}

function useIncTitle(id) {
    const [state, setState] = React.useState({ title: null, loading: true, groups: null });
    React.useEffect(() => {
        const controller = new AbortController();
        const { signal } = controller;
        setState({ title: null, loading: true, groups: null });
        getJson(`/inc/title/${encodeURIComponent(id)}`, { signal, timeoutMs: 30000 })
            .then((res) => setState((s) => ({ ...s, title: res.title || null, loading: false })))
            .catch(() => { if (!signal.aborted) setState((s) => ({ ...s, loading: false })); });
        getJson(`/inc/streams/${encodeURIComponent(id)}`, { signal, timeoutMs: 120000 })
            .then(async (res) => {
                const streams = await withDeepLinks(Array.isArray(res.streams) ? res.streams : [], id);
                if (!signal.aborted) setState((s) => ({ ...s, groups: streams }));
            })
            .catch(() => { if (!signal.aborted) setState((s) => ({ ...s, groups: [] })); });
        return () => controller.abort();
    }, [id]);
    return state;
}

function IncMetaDetails({ id, queryParams: routeQueryParams }) {
    const { title, loading, groups } = useIncTitle(id);
    const fav = useIncFavorites();
    // Carries ?autopickRetry=… when the Player sends a failed pick back.
    const queryParams = React.useMemo(() => routeQueryParams || new URLSearchParams(), [routeQueryParams]);
    // A stand-in "video" so StreamsList keys auto-pick picks and failures to
    // this title (titles have no episodes); the Player looks them up the same way.
    const video = React.useMemo(() => ({ id }), [id]);
    const isTube = id.startsWith('inc:tube:');

    // StreamsList shows one picker entry per "addon"; here, per source.
    const streams = React.useMemo(() => {
        const order = isTube ? ['clearnet'] : ['torrents', 'clearnet'];
        if (groups === null) {
            return order.map((key) => ({ addon: SOURCES[key], content: { type: 'Loading' } }));
        }
        // Sources with nothing found are left out. With none at all, an errored
        // group makes StreamsList show its own "no streams" message.
        const found = order
            .map((key) => ({ addon: SOURCES[key], content: { type: 'Ready', content: groups.filter((s) => s.source === key) } }))
            .filter((g) => g.content.content.length > 0);
        return found.length ? found : [{ addon: SOURCES[order[0]], content: { type: 'Err', content: 'No streams found' } }];
    }, [groups, isTube]);

    const links = React.useMemo(() => {
        if (!title) return [];
        const out = [];
        for (const p of title.performers || []) out.push({ category: 'Cast', name: p, url: rowLink(`perf:${p}`) });
        if (title.studio && title.kind !== 'tube') out.push({ category: 'Studio', name: title.studio, url: rowLink(`studio:${title.studio}`) });
        for (const t of (title.tags || []).slice(0, 12)) out.push({ category: 'Genres', name: t, url: rowLink(`tag:${t}`) });
        return out;
    }, [title]);

    const released = React.useMemo(() => {
        const d = title && title.date ? new Date(title.date) : null;
        return d && !isNaN(d.getTime()) ? d : undefined;
    }, [title]);

    const background = title ? abs(title.backdrop || title.thumbnail) : '';
    const isFav = title ? fav.isTitle(title.id) : false;
    const toggleFavorite = React.useCallback(() => { if (title) fav.toggleTitle(title); }, [title, fav]);
    const renderNull = React.useCallback(() => null, []);
    const noop = React.useCallback(() => { /* titles have no episodes */ }, []);

    return (
        <div className={mdStyles['metadetails-container']}>
            {background ? (
                <div className={mdStyles['background-image-layer']}>
                    <Image className={mdStyles['background-image']} src={background} renderFallback={renderNull} alt={' '} />
                </div>
            ) : null}
            <HorizontalNavBar
                className={mdStyles['nav-bar']}
                backButton={true}
                fullscreenButton={true}
                navMenu={true}
            />
            <div className={mdStyles['metadetails-content']}>
                {loading ? (
                    <MetaPreview.Placeholder className={mdStyles['meta-preview']} />
                ) : title ? (
                    <MetaPreview
                        className={mdStyles['meta-preview']}
                        name={title.name}
                        runtime={formatRuntime(title.duration)}
                        releaseInfo={title.kind === 'tube' ? title.siteName : (title.kind === 'movie' ? 'Movie' : title.studio)}
                        released={released}
                        description={title.description || undefined}
                        links={links}
                        inLibrary={isFav}
                        toggleInLibrary={toggleFavorite}
                        libraryLabels={{ add: 'Add to Favorites', remove: 'Remove from Favorites' }}
                        ratingInfo={null}
                    />
                ) : (
                    <div className={mdStyles['meta-message-container']}>
                        <div className={mdStyles['message-label']}>This title is no longer available.</div>
                    </div>
                )}
                <StreamsList
                    className={mdStyles['streams-list']}
                    streams={streams}
                    video={video}
                    type={'movie'}
                    metaId={id}
                    metaLoading={loading}
                    isResumeVideo={false}
                    onEpisodeSearch={noop}
                    queryParams={queryParams}
                    privateMode={true}
                />
            </div>
        </div>
    );
}

// Like MetaDetails: StreamsList reads core state (profile, streaming server)
// that may suspend, so the page gets its own core-suspense boundary.
// Without it the whole route suspends and remounts in a loop.
const IncMetaDetailsFallback = () => (
    <div className={mdStyles['metadetails-container']}>
        <div className={mdStyles['metadetails-content']}>
            <MetaPreview.Placeholder className={mdStyles['meta-preview']} />
        </div>
    </div>
);

module.exports = withCoreSuspender(IncMetaDetails, IncMetaDetailsFallback);
