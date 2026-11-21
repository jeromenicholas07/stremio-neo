// Skip Intro's season search for the intro: two episodes with a cut-down
// title sequence (Two and a Half Men) used to switch it off for the whole
// season, and a full analysis then threw away an intro found ahead of time.
const mockMemory = new Map();
jest.mock('../src/common/idbKeyval', () => ({
    available: () => true,
    get: async (db, store, key) => mockMemory.get(key),
    set: async (db, store, key, value) => { mockMemory.set(key, value); return true; },
    del: async (db, store, key) => mockMemory.delete(key),
    keys: async () => [...mockMemory.keys()],
    delMany: async (db, store, list) => { list.forEach((key) => mockMemory.delete(key)); return true; },
}));
const mockReads = [];
jest.mock('../src/services/subtitleSync/audioExtractor', () => ({
    checkExtractServer: async () => true,
    resolveMediaUrl: async () => ({ url: 'http://127.0.0.1:11470/hash/0' }),
    extractChunkDirect: async (url, start, seconds) => {
        mockReads.push({ start, seconds });
        return { audio: new Float32Array(Math.round(seconds * 16000)) };
    },
}));

const analyzer = require('../src/services/skipSegments/analyzer');
const store = require('../src/services/skipSegments/store');

const DURATION = 1300;
const job = {
    type: 'series',
    metaId: 'tt0000002',
    videoId: 'tt0000002:7:17',
    season: 7,
    videos: [15, 16, 17, 18].map((episode) => ({ id: `tt0000002:7:${episode}`, season: 7, episode })),
    stream: { url: 'https://example.test/ep17.mkv', behaviorHints: { filename: 'Show.S07E17.1080p.mkv' } },
    transportUrl: 'https://addon.example/manifest.json',
    streamingServerUrl: 'http://127.0.0.1:11470/',
    duration: DURATION,
    background: true,
};
const fileKey = 'Show.S07E17.1080p.mkv';
const theme = { hashes: new Int32Array(80), valid: new Uint8Array(80).fill(1), seconds: 20.5, confirmed: false, window: 360 };

beforeEach(() => {
    mockMemory.clear();
    mockReads.length = 0;
    // No chapters, no frames, nothing from databases.
    global.fetch = jest.fn(async (url) => (String(url).includes('/media-info')
        ? { ok: true, json: async () => ({ duration: DURATION, chapters: [] }) }
        : { ok: false, json: async () => ({}) }));
});

describe('skip intro: the season search', () => {
    it('still looks for the season theme after two misses, and counts no more', async () => {
        await store.setSeasonMisses(job.metaId, job.season, 2);
        await store.setTheme(job.metaId, job.season, theme);
        await analyzer.prepare(job);
        // The start of this file was read to look for the theme.
        expect(mockReads.some((read) => read.start < 360)).toBe(true);
        expect(await store.getSeasonMisses(job.metaId, job.season)).toBe(2);
    });

    it('does not read for the intro after two misses without a theme', async () => {
        await store.setSeasonMisses(job.metaId, job.season, 2);
        await analyzer.prepare(job);
        expect(mockReads.some((read) => read.start < 360)).toBe(false);
    });

    it('keeps an intro prepared ahead of time when the full analysis finds none', async () => {
        await store.setSeasonMisses(job.metaId, job.season, 2);
        const intro = { type: 'intro', start: 151.4, end: 173, confidence: 'medium', sources: ['audio'] };
        await store.setResult(job.videoId, fileKey, { segments: [intro], complete: false, endCut: null });
        await analyzer.prepare(job);
        const saved = await store.getResult(job.videoId, fileKey);
        expect(saved.segments.find((segment) => segment.type === 'intro')).toMatchObject({ start: 151.4 });
    });

    it('looks again at a result without an intro made before the fix', async () => {
        await store.setResult(job.videoId, fileKey, { segments: [], complete: true, endCut: null });
        const key = `res3|${job.videoId}|${fileKey}`;
        const { intro: _intro, ...old } = mockMemory.get(key);
        mockMemory.set(key, old);
        expect((await store.getResult(job.videoId, fileKey)).complete).toBe(false);
        // With an intro it stands.
        mockMemory.set(key, { ...old, segments: [{ type: 'intro', start: 150, end: 172, confidence: 'high', sources: ['audio'] }] });
        expect((await store.getResult(job.videoId, fileKey)).complete).toBe(true);
    });
});
