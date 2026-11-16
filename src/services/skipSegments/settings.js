// Skip Intro preferences: one global config plus per-show overrides, stored
// the same way as the auto-pick settings.

const CONFIG_KEY = 'netflix_ui_skip_config';
const OVERRIDES_KEY = 'netflix_ui_skip_overrides';
const CHANGE_EVENT = 'skip-settings-changed';

// off: nothing is shown. button: a Skip button. auto: skip by itself when the
// timing is confirmed by more than one source, otherwise fall back to the button.
const MODES = ['off', 'button', 'auto'];

const DEFAULTS = {
    mode: 'button',
    useDatabases: true,
    backgroundAnalysis: true,
    // Play the next episode once confidently detected credits start.
    autoNext: false,
};

function read(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
        return fallback;
    }
}

function write(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGE_EVENT));
        return true;
    } catch {
        return false;
    }
}

function getSkipSettings() {
    const stored = read(CONFIG_KEY, {});
    return {
        mode: MODES.includes(stored.mode) ? stored.mode : DEFAULTS.mode,
        useDatabases: typeof stored.useDatabases === 'boolean' ? stored.useDatabases : DEFAULTS.useDatabases,
        backgroundAnalysis: typeof stored.backgroundAnalysis === 'boolean' ? stored.backgroundAnalysis : DEFAULTS.backgroundAnalysis,
        autoNext: typeof stored.autoNext === 'boolean' ? stored.autoNext : DEFAULTS.autoNext,
    };
}

function setSkipSettings(partial) {
    return write(CONFIG_KEY, { ...getSkipSettings(), ...partial });
}

function getSkipOverride(metaId) {
    const mode = metaId ? read(OVERRIDES_KEY, {})[metaId] : null;
    return MODES.includes(mode) ? mode : null;
}

// Pass null to go back to the global setting.
function setSkipOverride(metaId, mode) {
    if (!metaId) return false;
    const overrides = { ...read(OVERRIDES_KEY, {}) };
    if (MODES.includes(mode)) overrides[metaId] = mode;
    else delete overrides[metaId];
    return write(OVERRIDES_KEY, overrides);
}

function getEffectiveSkipMode(metaId) {
    return getSkipOverride(metaId) || getSkipSettings().mode;
}

module.exports = {
    MODES,
    DEFAULTS,
    CHANGE_EVENT,
    getSkipSettings,
    setSkipSettings,
    getSkipOverride,
    setSkipOverride,
    getEffectiveSkipMode,
};
