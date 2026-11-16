// The daily clean-up of Skip Intro's stored data, against an in-mockMemory store.
const mockMemory = new Map();
jest.mock('../src/common/idbKeyval', () => ({
    available: () => true,
    get: async (db, store, key) => mockMemory.get(key),
    set: async (db, store, key, value) => { mockMemory.set(key, value); return true; },
    del: async (db, store, key) => mockMemory.delete(key),
    keys: async () => [...mockMemory.keys()],
    delMany: async (db, store, list) => { list.forEach((key) => mockMemory.delete(key)); return true; },
}));
const store = require('../src/services/skipSegments/store');

const DAY = 24 * 60 * 60 * 1000;

describe('skip intro: stored data clean-up', () => {
    beforeEach(() => mockMemory.clear());

    it('drops what an older version left, what expired, and fingerprints past the cap', async () => {
        const now = Date.now();
        mockMemory.set('res2|tt1:1:1|a', { at: now });
        mockMemory.set('theme2|tt1|1', { at: now });
        mockMemory.set('miss|tt1|1', { count: 2, at: now });
        mockMemory.set('fp|tt1:1:1', { seconds: 180 }); // per-episode key from before
        mockMemory.set('db|tt1:1:2', { segments: [], at: now - 2 * DAY }); // a miss, kept one day
        mockMemory.set('db|tt1:1:3', { segments: [{}], at: now - 2 * DAY }); // a hit, kept a week
        await store.setResult('tt1:1:4', 'a', { segments: [] });
        // Written one after another, so the newest are known.
        let clock = now - 1000;
        const tick = jest.spyOn(Date, 'now').mockImplementation(() => ++clock);
        for (let i = 0; i < 305; i++) await store.setFingerprint(`tt2:1:${i}`, { fileKey: 'f', seconds: 180 });
        tick.mockRestore();

        await store.sweep(now + 1000);

        expect(['res2|tt1:1:1', 'theme2|tt1|1', 'miss|tt1|1', 'fp|tt1:1:1', 'db|tt1:1:2'].filter((key) => mockMemory.has(key))).toEqual([]);
        expect(mockMemory.has('db|tt1:1:3')).toBe(true);
        expect(await store.getResult('tt1:1:4', 'a')).not.toBeNull();
        const fingerprints = [...mockMemory.keys()].filter((key) => key.startsWith('fp|'));
        expect(fingerprints.length).toBe(300);
        expect(await store.getAnyFingerprint('tt2:1:304')).toBeDefined();
        expect(await store.getAnyFingerprint('tt2:1:0')).toBeUndefined();
    });

    it('runs at most once a day', async () => {
        const now = Date.now();
        await store.sweep(now);
        mockMemory.set('res2|old', { at: now });
        expect(await store.sweep(now + DAY / 2)).toBe(0);
        expect(await store.sweep(now + DAY + 1)).toBe(1);
    });
});
