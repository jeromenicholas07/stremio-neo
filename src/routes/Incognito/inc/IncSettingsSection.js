// Settings for the clearnet catalog, shown inside Incognito Settings:
//   - favorite performers, studios and categories (add, remove, reorder),
//     each one a row on the Incognito home, in this order
//   - the ThePornDB token (IncSettingsSection.ThePornDb; stored by the addon
//     in the shared data folder; the page never reads it back, it only
//     learns whether one is set)

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

// The addon's /inc/config answers only on addons with the clearnet catalog.
function useIncConfig() {
    const [config, setConfig] = React.useState({ supported: null, theporndbTokenSet: false });
    React.useEffect(() => {
        let alive = true;
        getJson('/inc/config', { timeoutMs: 5000 })
            .then((c) => { if (alive) setConfig({ supported: true, theporndbTokenSet: Boolean(c.theporndbTokenSet) }); })
            .catch(() => { if (alive) setConfig({ supported: false, theporndbTokenSet: false }); });
        return () => { alive = false; };
    }, []);
    return [config, setConfig];
}

function FavoriteGroup({ styles, title, description, items, onRemove, onMove, empty, placeholder, onAdd, listId, options }) {
    const [value, setValue] = React.useState('');
    const add = () => {
        const n = value.trim();
        if (n) onAdd(n);
        setValue('');
    };
    return (
        <section className={styles['settings-section']}>
            <div className={styles['settings-section-title']}>{title}</div>
            {description ? <div className={styles['settings-description']}>{description}</div> : null}
            {items.length ? (
                <div className={styles['chips']}>
                    {items.map((item, i) => (
                        <span key={item.name} className={styles['chip']}>
                            <span className={styles['chip-name']} title={item.name}>{item.name}</span>
                            <button
                                className={styles['chip-button']}
                                onClick={() => onMove(item.name, i - 1)}
                                disabled={i === 0}
                                type="button"
                                title="Move earlier"
                                aria-label={`Move ${item.name} earlier`}
                            >
                                {'‹'}
                            </button>
                            <button
                                className={styles['chip-button']}
                                onClick={() => onRemove(item.name)}
                                type="button"
                                title="Remove"
                                aria-label={`Remove ${item.name}`}
                            >
                                {'✕'}
                            </button>
                        </span>
                    ))}
                </div>
            ) : (
                <div className={styles['settings-empty']}>{empty}</div>
            )}
            <div className={styles['settings-form-row']}>
                <input
                    className={styles['settings-input']}
                    placeholder={placeholder}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
                    list={options ? listId : undefined}
                />
                {options ? (
                    <datalist id={listId}>
                        {options(value).map((s) => <option key={s} value={s} />)}
                    </datalist>
                ) : null}
                <button
                    className={classnames(styles['settings-button'], styles['primary'])}
                    onClick={add}
                    disabled={!value.trim()}
                    type="button"
                >
                    Add
                </button>
            </div>
        </section>
    );
}

function IncSettingsSection({ styles }) {
    const fav = useIncFavorites();
    const [{ supported }] = useIncConfig();
    const [tags, setTags] = React.useState([]);

    React.useEffect(() => {
        let alive = true;
        getJson('/inc/tags', { timeoutMs: 15000 })
            .then((r) => { if (alive) setTags(Array.isArray(r.tags) ? r.tags : []); })
            .catch(() => { /* picker falls back to free text */ });
        return () => { alive = false; };
    }, []);

    if (supported === false) return null; // older addon: nothing to configure here

    return (
        <React.Fragment>
            <FavoriteGroup
                styles={styles}
                title="Favorite performers"
                description="Each one gets a row with their scenes, the ones with torrents first. You can also tap ★ next to a name on any title."
                items={fav.favorites.performers}
                onRemove={(n) => fav.togglePerformer(n)}
                onMove={(n, to) => fav.move('performer', n, to)}
                onAdd={(n) => { if (!fav.isPerformer(n)) fav.togglePerformer(n); }}
                empty="No favorite performers yet."
                placeholder="Add a performer"
                listId="inc-performer-suggestions"
                options={(q) => (q.trim() ? searchPornstars(q, 6).filter((n) => !fav.isPerformer(n)) : [])}
            />
            <FavoriteGroup
                styles={styles}
                title="Favorite studios"
                description="Each one gets a row with the studio’s scenes. You can also star a studio from its page."
                items={fav.favorites.studios || []}
                onRemove={(n) => fav.toggleStudio(n)}
                onMove={(n, to) => fav.move('studio', n, to)}
                onAdd={(n) => { if (!fav.isStudio(n)) fav.toggleStudio(n); }}
                empty="No favorite studios yet."
                placeholder="Add a studio (e.g. Blacked)"
            />
            <FavoriteGroup
                styles={styles}
                title="Favorite categories"
                items={fav.favorites.tags}
                onRemove={(n) => fav.toggleTag(n)}
                onMove={(n, to) => fav.move('tag', n, to)}
                onAdd={(n) => { if (!fav.isTag(n)) fav.toggleTag(n); }}
                empty="No favorite categories yet."
                placeholder="Add a category"
                listId="inc-tag-suggestions"
                options={() => tags.filter((t) => !fav.isTag(t))}
            />
        </React.Fragment>
    );
}

function ThePornDb({ styles }) {
    const [{ supported, theporndbTokenSet: tokenSet }, setConfig] = useIncConfig();
    const [token, setToken] = React.useState('');
    const [tokenState, setTokenState] = React.useState('idle'); // idle | saving | saved | error

    const saveToken = React.useCallback(async (value) => {
        setTokenState('saving');
        try {
            const c = await postJson('/inc/config', { theporndbToken: value });
            setConfig({ supported: true, theporndbTokenSet: Boolean(c.theporndbTokenSet) });
            setToken('');
            setTokenState('saved');
        } catch {
            setTokenState('error');
        }
    }, []);

    if (supported === false) return null;

    return (
        <React.Fragment>
            <div className={styles['settings-description']}>
                <strong>ThePornDB</strong> ({tokenSet ? 'token set' : 'no token set'}): artwork, performers and
                descriptions for studio scenes. Paste your API token from theporndb.net (profile → API Tokens).
                It&rsquo;s saved on this PC only and never shown again.
            </div>
            <div className={styles['settings-form-row']}>
                <input
                    className={styles['settings-input']}
                    type="password"
                    placeholder={tokenSet ? 'Replace ThePornDB token' : 'ThePornDB API token'}
                    value={token}
                    onChange={(e) => { setToken(e.target.value); setTokenState('idle'); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && token.trim()) saveToken(token); }}
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

IncSettingsSection.ThePornDb = ThePornDb;

module.exports = IncSettingsSection;
