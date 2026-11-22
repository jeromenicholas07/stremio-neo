const React = require('react');
const classnames = require('classnames');
const styles = require('./IncognitoSettings.less');
const {
    listCustomRows,
    addCustomRow,
    removeCustomRow,
    refreshCustomRow,
    clearAllCustomRowCaches,
} = require('./useIncognitoCustomRows');
const { clearCatalogsCache } = require('./useIncognitoCatalogs');
const { clearSearchCache } = require('./useIncognitoSearch');
const { clearDetailsCache } = require('./useIncognitoDetails');
const { clearHistory: clearSearchHistory } = require('./incognitoSearchHistory');
const IncSettingsSection = require('./inc/IncSettingsSection');
const { syncRdTokenToAddon } = require('./inc/incApi');
const { clearRowCaches: clearIncRowCaches } = require('./inc/useIncRows');

// Bundled defaults — every endpoint is loopback and deterministic, so there
// is nothing the user needs (or should be able) to misconfigure here.
const ADDON_URL = 'http://127.0.0.1:7000';
const PROWLARR_URL = 'http://127.0.0.1:9696';

const RD_TOKEN_KEY = 'rd_token';

const IncognitoSettings = React.memo(({ onClose, onResetPin }) => {
    const [status, setStatus] = React.useState(null);
    const [checking, setChecking] = React.useState(false);
    const [rdToken, setRdToken] = React.useState(() => {
        try { return localStorage.getItem(RD_TOKEN_KEY) || ''; } catch { return ''; }
    });
    const [rdSaved, setRdSaved] = React.useState(false);
    const [clearState, setClearState] = React.useState('idle'); // idle | clearing | done | error

    // Custom rows state. `customRows` mirrors localStorage and is the
    // source of truth inside this panel; `newRowName`/`newRowQuery` are
    // the add-form inputs.
    const [customRows, setCustomRows] = React.useState(() => listCustomRows());
    const [newRowName, setNewRowName] = React.useState('');
    const [newRowQuery, setNewRowQuery] = React.useState('');

    const handleAddRow = React.useCallback(() => {
        const trimmedQuery = newRowQuery.trim();
        if (!trimmedQuery) return;
        addCustomRow({ name: newRowName.trim(), query: trimmedQuery });
        setNewRowName('');
        setNewRowQuery('');
        setCustomRows(listCustomRows());
    }, [newRowName, newRowQuery]);

    const handleRemoveRow = React.useCallback((id) => {
        removeCustomRow(id);
        setCustomRows(listCustomRows());
    }, []);

    const handleRefreshRow = React.useCallback((id) => {
        refreshCustomRow(id);
    }, []);

    // "Clear Incognito cache" nukes every cache layer so the next view
    // pulls fresh data from Prowlarr. Search history is also wiped — it's
    // the single control users will reach for when they want a clean
    // slate. Custom-row definitions are preserved (they're user config,
    // not cache), just their results are re-fetched.
    const handleClearCache = React.useCallback(async () => {
        setClearState('clearing');
        try {
            // Frontend caches (synchronous, cannot fail)
            try { clearCatalogsCache(); } catch (_e) { /* ignore */ }
            try { clearSearchCache(); } catch (_e) { /* ignore */ }
            try { clearDetailsCache(); } catch (_e) { /* ignore */ }
            try { clearIncRowCaches(); } catch (_e) { /* ignore */ }
            try { clearAllCustomRowCaches(); } catch (_e) { /* ignore */ }
            try { clearSearchHistory(); } catch (_e) { /* ignore */ }

            // Addon-side catalog LRU. Best-effort — if the addon is down
            // the frontend caches are already gone which is 90% of the win.
            try {
                await fetch(`${ADDON_URL}/cache/clear`, { method: 'POST' });
            } catch (_e) { /* ignore */ }

            setClearState('done');
            setTimeout(() => setClearState('idle'), 2000);
        } catch (_e) {
            setClearState('error');
            setTimeout(() => setClearState('idle'), 3000);
        }
    }, []);

    const handleRdTokenChange = React.useCallback((e) => {
        setRdToken(e.target.value);
        setRdSaved(false);
    }, []);

    const handleSaveRdToken = React.useCallback(() => {
        try {
            const trimmed = rdToken.trim();
            if (trimmed) localStorage.setItem(RD_TOKEN_KEY, trimmed);
            else localStorage.removeItem(RD_TOKEN_KEY);
            setRdSaved(true);
            // The catalog's Real-Debrid streams resolve in the addon, which
            // needs its own copy (the Player sends no page storage).
            syncRdTokenToAddon(trimmed);
        } catch (_e) { /* ignore */ }
    }, [rdToken]);

    // Probe the addon on mount so the user gets immediate feedback about
    // whether bundled services are up.
    React.useEffect(() => {
        let cancelled = false;
        setChecking(true);
        (async () => {
            try {
                const res = await fetch(`${ADDON_URL}/status`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (cancelled) return;
                if (data.prowlarrApiKeySet) {
                    setStatus({ ok: true, message: 'Bundled services running — Prowlarr connected.' });
                } else {
                    setStatus({
                        ok: false,
                        message: 'Addon is up but no Prowlarr API key found yet. Open Prowlarr to finish first-run setup.',
                    });
                }
            } catch (_err) {
                if (cancelled) return;
                setStatus({
                    ok: false,
                    message: 'Cannot reach the bundled addon. Make sure you launched StremioNeo.exe.',
                });
            } finally {
                if (!cancelled) setChecking(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const handleOpenProwlarr = React.useCallback(() => {
        window.open(PROWLARR_URL, '_blank', 'noopener,noreferrer');
    }, []);

    const handleOverlayClick = React.useCallback((event) => {
        if (event.target === event.currentTarget) {
            onClose(false);
        }
    }, [onClose]);

    // Esc closes the dialog (unless a suggestion list is open in an input).
    React.useEffect(() => {
        const onKey = (event) => {
            if (event.key === 'Escape' && !event.defaultPrevented) onClose(false);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const button = (kind) => classnames(styles['settings-button'], styles[kind]);

    return (
        <div className={styles['settings-overlay']} onClick={handleOverlayClick}>
            <div className={styles['settings-panel']} role="dialog" aria-modal="true" aria-label="Incognito Settings">
                <div className={styles['settings-header']}>
                    <div className={styles['settings-title']}>Incognito Settings</div>
                    <button className={styles['settings-close']} onClick={() => onClose(false)} type="button" title="Close" aria-label="Close">
                        {'×'}
                    </button>
                </div>

                <div className={styles['settings-body']}>
                    <section className={styles['settings-section']}>
                        <div className={classnames(styles['settings-status'], {
                            [styles['connected']]: !checking && status && status.ok,
                            [styles['disconnected']]: !checking && status && !status.ok,
                        })}>
                            {checking || !status ? 'Checking bundled services…' : status.message}
                        </div>
                        <div className={styles['settings-description']}>
                            Incognito runs on services bundled with Stremio Neo, so there are no URLs to set up.
                            Torrent indexers are managed in Prowlarr.
                        </div>
                    </section>

                    <IncSettingsSection styles={styles} />

                    <section className={styles['settings-section']}>
                        <div className={styles['settings-section-title']}>Custom rows</div>
                        <div className={styles['settings-description']}>
                            Your own rows on the Incognito home, each showing the torrent results for a query.
                            Results are kept for 24 hours.
                        </div>
                        {customRows.length > 0 ? (
                            <div className={styles['custom-rows-list']}>
                                {customRows.map((row) => (
                                    <div key={row.id} className={styles['custom-row-item']}>
                                        <div className={styles['custom-row-text']}>
                                            <div className={styles['custom-row-name']}>{row.name}</div>
                                            <div className={styles['custom-row-query']}>query: {row.query}</div>
                                        </div>
                                        <button
                                            className={classnames(button('secondary'), styles['small'])}
                                            onClick={() => handleRefreshRow(row.id)}
                                            title="Fetch this row again on the next visit"
                                            type="button"
                                        >
                                            Refresh
                                        </button>
                                        <button
                                            className={classnames(button('danger'), styles['small'])}
                                            onClick={() => handleRemoveRow(row.id)}
                                            type="button"
                                        >
                                            Remove
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className={styles['settings-empty']}>No custom rows yet.</div>
                        )}
                        <div className={styles['settings-form-row']}>
                            <input
                                type="text"
                                placeholder="Row title (optional)"
                                value={newRowName}
                                onChange={(e) => setNewRowName(e.target.value)}
                                className={styles['settings-input']}
                            />
                            <input
                                type="text"
                                placeholder="Search query"
                                value={newRowQuery}
                                onChange={(e) => setNewRowQuery(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleAddRow(); }}
                                className={styles['settings-input']}
                            />
                            <button className={button('primary')} onClick={handleAddRow} disabled={!newRowQuery.trim()} type="button">
                                Add row
                            </button>
                        </div>
                    </section>

                    <section className={styles['settings-section']}>
                        <div className={styles['settings-section-title']}>Accounts</div>
                        <div className={styles['settings-description']}>
                            <strong>Real-Debrid</strong> (optional, {rdToken.trim() ? 'token set' : 'no token set'}): streams
                            cached torrents instantly over HTTPS. Paste your token from real-debrid.com/apitoken.
                        </div>
                        <div className={styles['settings-form-row']}>
                            <input
                                className={styles['settings-input']}
                                type="password"
                                placeholder="Real-Debrid API token"
                                value={rdToken}
                                onChange={handleRdTokenChange}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleSaveRdToken(); }}
                                autoComplete="off"
                            />
                            <button className={button('primary')} onClick={handleSaveRdToken} type="button">
                                {rdSaved ? 'Saved' : 'Save'}
                            </button>
                        </div>
                        <IncSettingsSection.ThePornDb styles={styles} />
                    </section>
                </div>

                <div className={styles['settings-footer']}>
                    <button
                        className={button('danger')}
                        onClick={onResetPin}
                        type="button"
                    >
                        Reset PIN
                    </button>
                    <button
                        className={button('secondary')}
                        onClick={handleClearCache}
                        disabled={clearState === 'clearing'}
                        title="Drop all cached catalogs, searches, details and search history. Favorites, custom rows and tokens are kept."
                        type="button"
                    >
                        {clearState === 'clearing' ? 'Clearing…' :
                            clearState === 'done' ? 'Cleared ✓' :
                                clearState === 'error' ? 'Clear failed' : 'Clear cache'}
                    </button>
                    <div className={styles['settings-footer-spacer']} />
                    <button className={button('secondary')} onClick={handleOpenProwlarr} type="button">
                        Open Prowlarr
                    </button>
                    <button className={button('primary')} onClick={() => onClose(false)} type="button">
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
});

IncognitoSettings.displayName = 'IncognitoSettings';

module.exports = IncognitoSettings;
