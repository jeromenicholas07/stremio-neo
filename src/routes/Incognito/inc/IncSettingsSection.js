// Settings for the clearnet catalog, shown inside Incognito Settings:
//   - ThePornDB token (stored by the addon in the shared data folder; the
//     page never reads it back, it only learns whether one is set)
//   - favorite performers and categories (add, remove, reorder)

const React = require('react');
const classnames = require('classnames');
const { getJson, postJson } = require('./incApi');
const useIncFavorites = require('./useIncFavorites');
const PORNSTARS = require('../pornstars');

function searchPornstars(query, limit) {
    const q = String(query || '').trim().toLowerCase();
    if (!q || !Array.isArray(PORNSTARS)) return [];
    const starts = PORNSTARS.filter((n) => n.toLowerCase().startsWith(q));
    const contains = PORNSTARS.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, limit);
}

function FavoriteList({ styles, items, onRemove, onMove, empty }) {
    if (!items.length) return <div className={styles['settings-description']}>{empty}</div>;
    return (
        <div className={styles['custom-rows-list']}>
            {items.map((item, i) => (
                <div key={item.name} className={styles['custom-row-item']}>
                    <div className={styles['custom-row-text']}>
                        <div className={styles['custom-row-name']}>{item.name}</div>
                    </div>
                    <button
                        className={classnames(styles['settings-button'], styles['secondary'])}
                        onClick={() => onMove(item.name, i - 1)}
                        disabled={i === 0}
                        type="button"
                        title="Move up"
                    >
                        {'↑'}
                    </button>
                    <button
                        className={classnames(styles['settings-button'], styles['danger'])}
                        onClick={() => onRemove(item.name)}
                        type="button"
                    >
                        Remove
                    </button>
                </div>
            ))}
        </div>
    );
}

function IncSettingsSection({ styles }) {
    const fav = useIncFavorites();
    const [supported, setSupported] = React.useState(null);
    const [tokenSet, setTokenSet] = React.useState(false);
    const [token, setToken] = React.useState('');
    const [tokenState, setTokenState] = React.useState('idle'); // idle | saving | saved | error
    const [performer, setPerformer] = React.useState('');
    const [tag, setTag] = React.useState('');
    const [studio, setStudio] = React.useState('');
    const [tags, setTags] = React.useState([]);

    React.useEffect(() => {
        let alive = true;
        getJson('/inc/config', { timeoutMs: 5000 })
            .then((c) => { if (alive) { setSupported(true); setTokenSet(Boolean(c.theporndbTokenSet)); } })
            .catch(() => { if (alive) setSupported(false); });
        getJson('/inc/tags', { timeoutMs: 15000 })
            .then((r) => { if (alive) setTags(Array.isArray(r.tags) ? r.tags : []); })
            .catch(() => { /* picker falls back to free text */ });
        return () => { alive = false; };
    }, []);

    const saveToken = React.useCallback(async (value) => {
        setTokenState('saving');
        try {
            const c = await postJson('/inc/config', { theporndbToken: value });
            setTokenSet(Boolean(c.theporndbTokenSet));
            setToken('');
            setTokenState('saved');
        } catch {
            setTokenState('error');
        }
    }, []);

    const suggestions = React.useMemo(() => {
        if (!performer.trim()) return [];
        return searchPornstars(performer, 6).filter((n) => !fav.isPerformer(n));
    }, [performer, fav]);

    if (supported === false) return null; // older addon: nothing to configure here

    const addPerformer = (name) => {
        const n = String(name || '').trim();
        if (n && !fav.isPerformer(n)) fav.togglePerformer(n);
        setPerformer('');
    };
    const addStudio = (name) => {
        const n = String(name || '').trim();
        if (n && !fav.isStudio(n)) fav.toggleStudio(n);
        setStudio('');
    };
    const addTag = (name) => {
        const n = String(name || '').trim();
        if (n && !fav.isTag(n)) fav.toggleTag(n);
        setTag('');
    };

    const inputStyle = { flex: 1, padding: '0.5rem', background: 'rgba(255,255,255,0.08)', color: '#fff', border: '1px solid rgba(255,255,255,0.15)', borderRadius: '4px' };

    return (
        <React.Fragment>
            <div className={styles['settings-divider']} />
            <div className={styles['settings-title']} style={{ fontSize: '1rem' }}>Favorite performers</div>
            <div className={styles['settings-description']}>
                Each one gets a row with their filmography, scenes with torrents first.
                You can also tap ★ next to a name on any title.
            </div>
            <FavoriteList
                styles={styles}
                items={fav.favorites.performers}
                onRemove={(n) => fav.togglePerformer(n)}
                onMove={(n, to) => fav.move('performer', n, to)}
                empty="No favorite performers yet."
            />
            <div className={styles['custom-row-add']}>
                <input
                    className={styles['settings-input']}
                    placeholder="Add a performer"
                    value={performer}
                    onChange={(e) => setPerformer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addPerformer(performer); }}
                    list="inc-performer-suggestions"
                />
                <datalist id="inc-performer-suggestions">
                    {suggestions.map((s) => <option key={s} value={s} />)}
                </datalist>
                <button className={classnames(styles['settings-button'], styles['primary'])} onClick={() => addPerformer(performer)} type="button">
                    Add
                </button>
            </div>

            <div className={styles['settings-divider']} />
            <div className={styles['settings-title']} style={{ fontSize: '1rem' }}>Favorite studios</div>
            <div className={styles['settings-description']}>
                Each one gets a row with the studio&rsquo;s catalogue. You can also star a studio from its page.
            </div>
            <FavoriteList
                styles={styles}
                items={fav.favorites.studios || []}
                onRemove={(n) => fav.toggleStudio(n)}
                onMove={(n, to) => fav.move('studio', n, to)}
                empty="No favorite studios yet."
            />
            <div className={styles['custom-row-add']}>
                <input
                    className={styles['settings-input']}
                    placeholder="Add a studio (e.g. Blacked)"
                    value={studio}
                    onChange={(e) => setStudio(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addStudio(studio); }}
                />
                <button className={classnames(styles['settings-button'], styles['primary'])} onClick={() => addStudio(studio)} type="button">
                    Add
                </button>
            </div>

            <div className={styles['settings-divider']} />
            <div className={styles['settings-title']} style={{ fontSize: '1rem' }}>Favorite categories</div>
            <FavoriteList
                styles={styles}
                items={fav.favorites.tags}
                onRemove={(n) => fav.toggleTag(n)}
                onMove={(n, to) => fav.move('tag', n, to)}
                empty="No favorite categories yet."
            />
            <div className={styles['custom-row-add']}>
                <input
                    className={styles['settings-input']}
                    placeholder="Add a category"
                    value={tag}
                    onChange={(e) => setTag(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addTag(tag); }}
                    list="inc-tag-suggestions"
                />
                <datalist id="inc-tag-suggestions">
                    {tags.filter((t) => !fav.isTag(t)).map((t) => <option key={t} value={t} />)}
                </datalist>
                <button className={classnames(styles['settings-button'], styles['primary'])} onClick={() => addTag(tag)} type="button">
                    Add
                </button>
            </div>

            <div className={styles['settings-divider']} />
            <div className={styles['settings-title']} style={{ fontSize: '1rem' }}>ThePornDB</div>
            <div className={styles['settings-description']}>
                Artwork, performers and descriptions for studio scenes. Paste your API token from
                theporndb.net (profile → API Tokens). It&rsquo;s saved on this PC only and never shown again.
                {' '}{tokenSet ? 'A token is set.' : 'No token set.'}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', margin: '0.5rem 0 1rem' }}>
                <input
                    type="password"
                    placeholder={tokenSet ? 'Replace token' : 'ThePornDB API token'}
                    value={token}
                    onChange={(e) => { setToken(e.target.value); setTokenState('idle'); }}
                    style={inputStyle}
                    autoComplete="off"
                />
                <button
                    className={classnames(styles['settings-button'], styles['primary'])}
                    onClick={() => saveToken(token)}
                    disabled={!token.trim() || tokenState === 'saving'}
                    type="button"
                >
                    {tokenState === 'saved' ? 'Saved' : tokenState === 'error' ? 'Retry' : 'Save'}
                </button>
                {tokenSet ? (
                    <button
                        className={classnames(styles['settings-button'], styles['danger'])}
                        onClick={() => saveToken('')}
                        type="button"
                    >
                        Remove
                    </button>
                ) : null}
            </div>
        </React.Fragment>
    );
}

module.exports = IncSettingsSection;
