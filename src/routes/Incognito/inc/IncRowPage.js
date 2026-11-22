// "See all" grid for one row: a performer, a category, Favorites, trending…
// Loads more pages as you scroll to the end.

const React = require('react');
const classnames = require('classnames');
const { default: Icon } = require('@stremio/stremio-icons/react');
const IncTitleCard = require('./IncTitleCard');
const useIncFavorites = require('./useIncFavorites');
const { useIncRowPages } = require('./useIncRows');
const { rowName } = require('./incApi');
const styles = require('./IncRowPage.less');

function IncRowPage({ rowId }) {
    const fav = useIncFavorites();
    const { titles, loading, done, more } = useIncRowPages(rowId);
    const sentinel = React.useRef(null);
    const performer = rowId.startsWith('perf:') ? rowId.slice(5) : null;
    const studio = rowId.startsWith('studio:') ? rowId.slice(7) : null;
    const tag = rowId.startsWith('tag:') ? rowId.slice(4) : null;
    const kind = performer ? 'performer' : studio ? 'studio' : tag ? 'category' : null;

    const list = rowId === 'favorites'
        ? fav.favorites.titles.map((t) => t.snapshot).filter((s) => s && s.id)
        : titles;

    React.useEffect(() => {
        const el = sentinel.current;
        if (!el || done) return undefined;
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) more();
        }, { rootMargin: '600px' });
        io.observe(el);
        return () => io.disconnect();
    }, [more, done, list.length]);

    const goBack = React.useCallback(() => {
        if (window.history.length > 1) window.history.back();
        else window.location.hash = '#/incognito';
    }, []);

    const starred = performer ? fav.isPerformer(performer) : studio ? fav.isStudio(studio) : tag ? fav.isTag(tag) : false;
    const toggleStar = () => (performer ? fav.togglePerformer(performer) : studio ? fav.toggleStudio(studio) : fav.toggleTag(tag));

    return (
        <div className={styles['page']}>
            <div className={styles['header']}>
                <button type="button" className={styles['back']} onClick={goBack}><Icon name="chevron-back" /> Back</button>
                <div className={styles['title']}>{rowName(rowId)}</div>
                {kind ? (
                    <button
                        type="button"
                        className={classnames(styles['star-button'], { [styles['on']]: starred })}
                        onClick={toggleStar}
                    >
                        {starred ? `★ Favorite ${kind}` : '☆ Add to favorites'}
                    </button>
                ) : null}
            </div>
            <div className={styles['grid']}>
                {list.map((t) => <IncTitleCard key={t.id} {...t} />)}
            </div>
            {!loading && list.length === 0 ? <div className={styles['message']}>Nothing here yet.</div> : null}
            {loading ? <div className={styles['message']}>Loading…</div> : null}
            <div ref={sentinel} />
        </div>
    );
}

module.exports = IncRowPage;
