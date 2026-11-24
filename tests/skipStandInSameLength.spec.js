// A 4K file's end read on a lighter stand-in release: when the audio match
// at the end fails but both files are the same length (same cut), the story
// end still counts as heard, so auto-next works (Ted Lasso S04E01: popup
// shown, no auto-next). Stored "seen" results from before are redone once.
const mockMemory = new Map();
jest.mock('../src/common/idbKeyval', () => ({
    available: () => true,
    get: async (db, store, key) => mockMemory.get(key),
    set: async (db, store, key, value) => { mockMemory.set(key, value); return true; },
    del: async (db, store, key) => mockMemory.delete(key),
    keys: async () => [...mockMemory.keys()],
    delMany: async (db, store, list) => { list.forEach((key) => mockMemory.delete(key)); return true; },
}));
jest.mock('../src/services/subtitleSync/audioExtractor', () => ({
    checkExtractServer: async () => true,
    resolveMediaUrl: async () => ({ url: 'http://127.0.0.1:11470/hash/0' }),
    extractChunkDirect: async (url, start, seconds) => ({ audio: new Float32Array(Math.round(seconds * 16000)) }),
}));
const store = require('../src/services/skipSegments/store');
const analyzer = require('../src/services/skipSegments/analyzer');

describe('extra points to line a same-length stand-in up at', () => {
    // The stand-in's end fingerprint: its last 180 s (Ted Lasso S04E01: 2312–2492).
    const reference = { from: 2312, to: 2492 };

    it('spreads them over the fingerprint, away from the point already tried', () => {
        const probes = analyzer._alignProbes(reference, 2394.81);
        expect(probes.length).toBeGreaterThanOrEqual(2);
        for (const at of probes) {
            expect(at).toBeGreaterThanOrEqual(reference.from + 10);
            expect(at).toBeLessThanOrEqual(reference.to - 20); // a 30 s read from at-10 stays inside
            expect(Math.abs(at - 2394.81)).toBeGreaterThanOrEqual(15);
        }
    });

    it('offers none when the fingerprint is too short to read 30 s from', () => {
        expect(analyzer._alignProbes({ from: 100, to: 125 }, 110)).toEqual([]);
    });
});

const credits = (story) => ({ type: 'credits', start: 2394.81, end: 2493, confidence: 'medium', sources: ['picture'], story });
const stored = (story, version) => ({ segments: [credits(story)], complete: true, credits: version, intro: 2, at: Date.now() });

describe('stored results and the same-length rule', () => {
    beforeEach(() => mockMemory.clear());

    it('redoes a search-3 result whose story end was only seen', async () => {
        mockMemory.set('res3|tt10986410:4:1|cakes', stored('seen', 3));
        expect((await store.getResult('tt10986410:4:1', 'cakes')).complete).toBe(false);
    });

    it('keeps search-3 results that were heard, and current ones either way', async () => {
        mockMemory.set('res3|tt10986410:4:1|cap', stored('heard', 3));
        mockMemory.set('res3|tt10986410:4:2|x', stored('seen', 4));
        expect((await store.getResult('tt10986410:4:1', 'cap')).complete).toBe(true);
        expect((await store.getResult('tt10986410:4:2', 'x')).complete).toBe(true);
    });

    it('stamps new results with the current search', async () => {
        await store.setResult('tt1:1:1', 'f', { segments: [credits('heard')], complete: true });
        expect(mockMemory.get('res3|tt1:1:1|f').credits).toBe(4);
    });
});
