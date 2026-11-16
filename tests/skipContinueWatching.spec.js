// Skip Intro's background preparation of Continue Watching shows.
const mockPrepared = [];
const mockState = { busy: false };
jest.mock('../src/services/skipSegments/analyzer', () => ({
    isBusy: () => mockState.busy,
    prepare: async (job) => { mockPrepared.push(job.videoId); return true; },
}));
jest.mock('../src/services/skipSegments/chapters', () => ({ fetchChapters: async () => ({ duration: 1300, named: [], marks: [] }) }));
const mockResults = new Map();
jest.mock('../src/services/skipSegments/store', () => ({ getResult: async (videoId, fileKey) => mockResults.get(`${videoId}|${fileKey}`) || null }));

const { schedule, drain, videoIdOf, jobFor } = require('../src/services/skipSegments/continueWatching');

const torrentio = { transportUrl: 'https://torrentio.example/manifest.json', manifest: { resources: ['stream'], types: ['movie', 'series'] } };
const stream = (videoId, size) => {
    const file = `Show.${videoId.replace(/:/g, '.')}.1080p.WEB.mkv`;
    return {
        name: '[RD+] Torrentio\n1080p',
        title: `${file}\n💾 ${size} GB`,
        url: `https://torrentio.example/resolve/realdebrid/key/hash/null/1/${file}`,
        behaviorHints: { bingeGroup: 'torrentio|1080p', filename: file, videoSize: size * 1e9 },
    };
};
const item = (id, videoId, progress) => ({ _id: id, type: 'series', progress, deepLinks: { metaDetailsStreams: `#/detail/series/${id}/${encodeURIComponent(videoId)}` } });

beforeEach(() => {
    mockPrepared.length = 0;
    mockResults.clear();
    mockState.busy = false;
    global.fetch = async (url) => {
        const text = String(url);
        const json = (body) => ({ ok: true, json: async () => body });
        const series = text.match(/meta\/series\/(tt\d+)\.json/);
        if (series) {
            const videos = [1, 2, 3].map((episode) => ({ id: `${series[1]}:1:${episode}`, season: 1, episode }));
            return json({ meta: { videos } });
        }
        const streams = text.match(/stream\/series\/(.+)\.json/);
        if (streams) return json({ streams: [stream(decodeURIComponent(streams[1]), 1.2)] });
        return { ok: false };
    };
});

describe('skip intro: preparing Continue Watching', () => {
    it('reads the episode a show is up to from its link', () => {
        expect(videoIdOf(item('tt1', 'tt1:1:2'))).toBe('tt1:1:2');
        expect(videoIdOf({ deepLinks: { metaDetailsStreams: '#/detail/movie/tt9/tt9' } })).toBeNull();
    });

    it('prepares the next episode once this one is all but watched, from the file Auto-Pick would choose', async () => {
        const job = await jobFor(item('tt1', 'tt1:1:2', 95), [torrentio], 'http://127.0.0.1:11470/');
        expect(job).toMatchObject({ videoId: 'tt1:1:3', season: 1, duration: 1300, transportUrl: torrentio.transportUrl });
        expect(job.stream.url).toContain('tt1.1.3');
    });

    it('skips an episode already done', async () => {
        mockResults.set('tt1:1:2|Show.tt1.1.2.1080p.WEB.mkv|1200000000', { complete: true });
        expect(await jobFor(item('tt1', 'tt1:1:2', 30), [torrentio], 'x')).toBeNull();
    });

    it('works down the list from the top, and stops when a player opens', async () => {
        schedule({ items: [item('tt1', 'tt1:1:1', 20), item('tt2', 'tt2:1:2', 10), item('tt3', 'tt3:1:1', 89)], addons: [torrentio], streamingServerUrl: 'x' });
        await drain();
        expect(mockPrepared).toEqual(['tt1:1:1', 'tt2:1:2', 'tt3:1:1']);

        mockPrepared.length = 0;
        mockState.busy = true;
        schedule({ items: [item('tt4', 'tt4:1:1', 20)], addons: [torrentio], streamingServerUrl: 'x' });
        await drain();
        expect(mockPrepared).toEqual([]);
    });
});
