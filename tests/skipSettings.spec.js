// Skip Intro's stored preferences: defaults, and the one-time move of configs
// saved under the first defaults.
const memory = new Map();
global.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
};

const { getSkipSettings, setSkipSettings } = require('../src/services/skipSegments/settings');

const KEY = 'netflix_ui_skip_config';
const stored = () => JSON.parse(memory.get(KEY));

describe('skip settings', () => {
    beforeEach(() => memory.clear());

    it('has everything on by default, without saving anything', () => {
        expect(getSkipSettings()).toEqual({ mode: 'auto', useDatabases: true, backgroundAnalysis: true, autoNext: true });
        expect(memory.has(KEY)).toBe(false);
    });

    it('moves a config saved under the first defaults to the current ones, once', () => {
        memory.set(KEY, JSON.stringify({ mode: 'button', useDatabases: true, backgroundAnalysis: false, autoNext: false }));
        expect(getSkipSettings()).toEqual({ mode: 'auto', useDatabases: true, backgroundAnalysis: false, autoNext: true });
        expect(stored().version).toBe(2);
        // A choice made after the move stays.
        setSkipSettings({ mode: 'button', autoNext: false });
        expect(getSkipSettings()).toMatchObject({ mode: 'button', autoNext: false });
    });

    it('keeps Skip Intro off for a config that turned it off', () => {
        memory.set(KEY, JSON.stringify({ mode: 'off', useDatabases: true, backgroundAnalysis: true, autoNext: false }));
        expect(getSkipSettings().mode).toBe('off');
    });
});
