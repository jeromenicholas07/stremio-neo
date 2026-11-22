// Incognito home: Favorites, one row per favorite performer and category,
// then trending / studio scenes / latest / top rated.

const React = require('react');
const classnames = require('classnames');
const { MetaRow } = require('stremio/components');
const MetaRowPlaceholder = require('stremio/components/MetaRow/MetaRowPlaceholder');
const IncTitleCard = require('./IncTitleCard');
const useIncFavorites = require('./useIncFavorites');
const { useIncRows } = require('./useIncRows');
const { rowPath, ensureRdTokenSynced } = require('./incApi');
const styles = require('./IncHome.less');

const ROW_CARDS = 40;

function IncHome({ rowClassName }) {
    const { favorites } = useIncFavorites();
    // Re-read the row list when the set of favorite performers/categories
    // (or whether there are any favorite titles) changes.
    // (Not the title count: the Favorites row renders from live state, and
    // re-running the effect on every ♥ would cancel pending row refreshes.)
    const favoritesKey = React.useMemo(() => JSON.stringify([
        favorites.titles.length > 0,
        favorites.performers.map((p) => p.name),
        (favorites.studios || []).map((x) => x.name),
        favorites.tags.map((t) => t.name),
    ]), [favorites]);
    const { rows, error } = useIncRows(favoritesKey);
    React.useEffect(() => { ensureRdTokenSynced(); }, []);

    // The Favorites row always shows the live list (optimistic ♥ changes
    // included), not the last fetched copy.
    const favoriteCards = React.useMemo(
        () => favorites.titles.map((t) => t.snapshot).filter((s) => s && s.id),
        [favorites]
    );

    if (error && rows.length === 0) {
        return <div className={styles['message']}>Couldn&rsquo;t reach the Incognito addon ({error}).</div>;
    }

    return (
        <React.Fragment>
            {favoriteCards.length && !rows.some((r) => r.id === 'favorites') ? (
                <IncRow row={{ id: 'favorites', name: 'Favorites', titles: favoriteCards, status: 'ready' }} className={rowClassName} />
            ) : null}
            {rows.map((row) => {
                if (row.id === 'favorites') {
                    if (!favoriteCards.length) return null;
                    return <IncRow key={row.id} row={{ ...row, titles: favoriteCards, status: 'ready' }} className={rowClassName} />;
                }
                return <IncRow key={row.id} row={row} className={rowClassName} />;
            })}
        </React.Fragment>
    );
}

function IncRow({ row, className }) {
    const title = row.kind === 'performer' || row.kind === 'studio' || row.kind === 'tag' ? `★ ${row.name}` : row.name;
    if (row.status === 'loading' && !(row.titles && row.titles.length)) {
        return <MetaRowPlaceholder className={classnames(className, 'animation-fade-in')} title={title} />;
    }
    if (!row.titles || row.titles.length === 0) return null;
    const catalog = {
        id: row.id,
        name: title,
        content: { type: 'Ready', content: row.titles.slice(0, ROW_CARDS) },
        deepLinks: { discover: rowPath(row.id) },
    };
    return (
        <MetaRow
            className={classnames(className, 'animation-fade-in')}
            title={title}
            catalog={catalog}
            itemComponent={IncTitleCard}
        />
    );
}

module.exports = IncHome;
