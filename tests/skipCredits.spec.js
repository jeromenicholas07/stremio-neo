// Skip Intro's credits search through the analyzer (run, findCredits,
// creditsPicture, fusion), with the launcher, the store and the audio faked:
// credits are looked for even in a season whose intro search gave up, from
// the picture alone when no music is shared, and their start is kept to the
// frame.
const mockMemory = new Map();
jest.mock('../src/common/idbKeyval', () => ({
    available: () => true,
    get: async (db, store, key) => mockMemory.get(key),
    set: async (db, store, key, value) => { mockMemory.set(key, value); return true; },
    del: async (db, store, key) => mockMemory.delete(key),
    keys: async () => [...mockMemory.keys()],
    delMany: async (db, store, list) => { list.forEach((key) => mockMemory.delete(key)); return true; },
}));
// Silence for audio: no music shared with anything.
jest.mock('../src/services/subtitleSync/audioExtractor', () => ({
    checkExtractServer: async () => true,
    resolveMediaUrl: async () => ({ url: 'http://127.0.0.1:11470/hash/0' }),
    extractChunkDirect: async (url, start, seconds) => ({ audio: new Float32Array(Math.round(seconds * 16000)) }),
}));

const analyzer = require('../src/services/skipSegments/analyzer');
const store = require('../src/services/skipSegments/store');

const DURATION = 1300;
const CREDITS_FROM = 1251.6; // the first card, on black
const W = 640;
const H = 352;

// A frame: footage (mid grey noise), or black with four lines of small
// white text, drawn at 160x88 and blown up 4x4 like the launcher's frames.
function frameAt(time) {
    const small = new Uint8Array(160 * 88);
    if (time >= CREDITS_FROM) {
        small.fill(16);
        [20, 32, 44, 56].forEach((top) => {
            for (let y = top; y < top + 3; y++) for (let x = 50; x < 110; x += 4) { small[y * 160 + x] = 220; small[y * 160 + x + 1] = 220; }
        });
    } else {
        let seed = Math.round(time * 10) + 1;
        for (let i = 0; i < small.length; i++) { seed = (seed * 1103515245 + 12345) >>> 0; small[i] = 60 + (seed % 120); }
    }
    const frame = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) frame[y * W + x] = small[(y >> 2) * 160 + (x >> 2)];
    return frame;
}

let frameReads = 0;
beforeEach(() => {
    mockMemory.clear();
    frameReads = 0;
    global.fetch = jest.fn(async (url) => {
        const text = String(url);
        const query = new URL(text).searchParams;
        if (text.includes('/media-info')) return { ok: true, json: async () => ({ duration: DURATION, chapters: [] }) };
        if (text.includes('/scene-cuts')) return { ok: true, json: async () => ({ cuts: [CREDITS_FROM - 0.1], blacks: [] }) };
        if (text.includes('/frames')) {
            frameReads++;
            const start = Number(query.get('start'));
            const fps = Number(query.get('fps'));
            const count = Math.floor(Math.min(Number(query.get('duration')), DURATION - start) * fps);
            const data = new Uint8Array(count * W * H);
            for (let i = 0; i < count; i++) data.set(frameAt(start + i / fps), i * W * H);
            return { ok: true, arrayBuffer: async () => data.buffer };
        }
        return { ok: false, json: async () => ({}) };
    });
});

const job = {
    type: 'series',
    metaId: 'tt0000001',
    videoId: 'tt0000001:1:2',
    season: 1,
    videos: [1, 2, 3].map((episode) => ({ id: `tt0000001:1:${episode}`, season: 1, episode })),
    stream: { url: 'https://example.test/ep2.mkv', behaviorHints: { filename: 'Show.S01E02.1080p.mkv' } },
    transportUrl: 'https://addon.example/manifest.json',
    streamingServerUrl: 'http://127.0.0.1:11470/',
    duration: DURATION,
};

describe('skip intro: credits through the analyzer', () => {
    it('finds the credits from the picture in a season whose intro search gave up', async () => {
        await store.setSeasonMisses(job.metaId, job.season, 5);
        expect(await analyzer.prepare(job)).toBe(true);
        const result = analyzer.getResult(analyzer.keyFor(job.videoId, job.stream));
        const credits = result.segments.find((segment) => segment.type === 'credits');
        expect(credits).toMatchObject({ end: DURATION, sources: expect.arrayContaining(['picture']) });
        expect(Math.abs(credits.start - CREDITS_FROM)).toBeLessThanOrEqual(1);
        // A roll on black the strict test is sure of may advance on its own.
        expect(credits.confidence).toBe('high');
        expect(frameReads).toBeGreaterThan(0);
        // The season learns how long its credits run.
        expect((await store.getCreditsLengths(job.metaId, job.season))[0].seconds).toBeCloseTo(DURATION - credits.start, 1);
    });

    it('keeps the file to look at again when the picture could not be read', async () => {
        global.fetch = jest.fn(async (url) => (String(url).includes('/media-info')
            ? { ok: true, json: async () => ({ duration: DURATION, chapters: [] }) }
            : { ok: false, json: async () => ({}) }));
        expect(await analyzer.prepare({ ...job, videoId: 'tt0000001:1:3' })).toBe(true);
        const stored = await store.getResult('tt0000001:1:3', require('../src/services/skipSegments/neighbours').fileKeyOf(job.stream));
        expect(stored.complete).toBe(false);
    });
});
