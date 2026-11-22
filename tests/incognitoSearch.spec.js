// Incognito search understanding (performer / studio in a query, typos,
// leftover keywords) and which P2P streams auto-pick may try (1080p first).

const entities = require('../stremio-adult-addon/src/inc/searchEntities');
const { p2pEligibility } = require('../src/routes/Incognito/inc/p2pEligibility');

// ThePornDB stand-in: performer search corrects typos, site search is exact.
const PERFORMERS = ['Lena Paul', 'Angela White', 'Little Caprice', 'Abella Danger', 'Riley Reid', 'Anna de Ville'];
const SITES = [{ name: 'Tushy', shortName: 'tushy' }, { name: 'Vixen', shortName: 'vixen' }, { name: 'Brazzers', shortName: 'brazzers' }, { name: 'Blacked Raw', shortName: 'blackedraw' }];
const calls = [];
async function lookup(kind, q) {
    calls.push(`${kind}:${q}`);
    if (kind === 'performers') return PERFORMERS.filter((p) => entities.closeName(q, p)).map((name) => ({ name }));
    return SITES.filter((s) => s.name.toLowerCase() === q.toLowerCase());
}

beforeEach(() => { calls.length = 0; });

describe('search entities', () => {
    const names = (r) => r && r.performers.map((p) => p.name);

    it('recognises a performer, typos included', async () => {
        expect(await entities.resolve('lena pual', lookup)).toMatchObject({ performers: [{ name: 'Lena Paul' }], studio: null, rest: [] });
        expect(names(await entities.resolve('Angela Whte', lookup))).toEqual(['Angela White']);
        expect(names(await entities.resolve('anna de ville', lookup))).toEqual(['Anna de Ville']);
    });

    it('stops after the whole query when it is a name', async () => {
        await entities.resolve('lena paul', lookup);
        expect(calls).toEqual(['performers:lena paul', 'sites:lena paul']);
    });

    it('splits a performer from leftover keywords', async () => {
        expect(await entities.resolve('lena paul anal', lookup)).toMatchObject({ performers: [{ name: 'Lena Paul' }], rest: ['anal'] });
    });

    it('finds several performers, with or without separators, typos included', async () => {
        expect(names(await entities.resolve('lena paul abella danger', lookup))).toEqual(['Lena Paul', 'Abella Danger']);
        expect(names(await entities.resolve('Lena Paul, Abella Danger', lookup))).toEqual(['Lena Paul', 'Abella Danger']);
        expect(names(await entities.resolve('lena paul and abella danger', lookup))).toEqual(['Lena Paul', 'Abella Danger']);
        expect(names(await entities.resolve('lena paul & abela danger', lookup))).toEqual(['Lena Paul', 'Abella Danger']);
        expect(names(await entities.resolve('riley reid lena paul angela white', lookup))).toEqual(['Riley Reid', 'Lena Paul', 'Angela White']);
        expect(await entities.resolve('lena paul abella danger anal', lookup)).toMatchObject({ rest: ['anal'] });
    });

    it('combines performers with a studio', async () => {
        const r = await entities.resolve('blacked raw lena paul', lookup);
        expect(names(r)).toEqual(['Lena Paul']);
        expect(r.studio).toMatchObject({ name: 'Blacked Raw' });
        expect(r.rest).toEqual([]);
        const v = await entities.resolve('vixen little caprice', lookup);
        expect(names(v)).toEqual(['Little Caprice']);
        expect(v.studio).toMatchObject({ name: 'Vixen' });
    });

    it('recognises studios, and fixes typos in big studio names', async () => {
        expect(await entities.resolve('tushy', lookup)).toMatchObject({ performers: [], studio: { name: 'Tushy', shortName: 'tushy' } });
        expect((await entities.resolve('brazers', lookup)).studio).toMatchObject({ name: 'Brazzers' });
        expect(await entities.resolve('vixen laying it bare', lookup)).toMatchObject({ studio: { name: 'Vixen' }, rest: ['laying', 'it', 'bare'] });
        expect((await entities.resolve('blacked raw', lookup)).studio).toMatchObject({ name: 'Blacked Raw' });
    });

    it('knows which titles feature every named performer', () => {
        const t = { performers: ['Lena Paul', 'Abella Danger', 'Mick Blue'] };
        expect(entities.featuresAll(t, ['Lena Paul', 'Abella Danger'])).toBe(true);
        expect(entities.featuresAll(t, ['Lena Paul', 'Riley Reid'])).toBe(false);
    });

    it('finds nothing in a plain title search', async () => {
        expect(await entities.resolve('stretching sunday', lookup)).toBeNull();
    });

    it('does not fuzzy-match words to obscure sites', async () => {
        const fuzzySites = async (kind, q) => (kind === 'sites'
            ? [{ name: 'Playing', shortName: 'playing' }, { name: 'ANGELA', shortName: 'angela' }].filter((x) => entities.closeName(q, x.name))
            : []);
        expect(await entities.resolve('laying it bare', fuzzySites)).toBeNull();
        expect(await entities.resolve('angela', fuzzySites)).toBeNull();
    });

    it('does not take one-word names as performers', async () => {
        expect(await entities.resolve('angela', lookup)).toBeNull();
    });

    it('filters by leftover keywords across title, tags, studio and cast', () => {
        const t = { name: 'Lena Paul Gets Analized', studio: 'Analized', tags: ['Big Tits'], performers: ['Lena Paul'] };
        expect(entities.matchesKeywords(t, ['anal'])).toBe(true);
        expect(entities.matchesKeywords(t, ['big', 'tits'])).toBe(true);
        expect(entities.matchesKeywords(t, ['massage'])).toBe(false);
        expect(entities.matchesKeywords(t, [])).toBe(true);
    });

    it('says how the query reads once corrected', async () => {
        expect(entities.correctedQuery('lena pual anal', await entities.resolve('lena pual anal', lookup))).toBe('Lena Paul anal');
        expect(entities.correctedQuery('lena paul & abela danger', await entities.resolve('lena paul & abela danger', lookup))).toBe('Lena Paul Abella Danger');
        expect(entities.correctedQuery('lena paul', await entities.resolve('lena paul', lookup))).toBeNull();
        expect(entities.correctedQuery('x', null)).toBeNull();
    });
});

describe('quality of untagged releases', () => {
    const { estimateQuality, fromReleases } = require('../stremio-adult-addon/src/inc/streams');
    it('labels only sizes that can only be HD, and guesses nothing in the overlap', () => {
        const min40 = 40 * 60;
        expect(estimateQuality({ size: 3e9 }, min40)).toBe('~1080p'); // 10 Mbps
        expect(estimateQuality({ sizeLabel: '2.5 GB' }, min40)).toBe('~1080p'); // 8.3 Mbps
        expect(estimateQuality({ size: 700e6 }, min40)).toBe(''); // 2.3 Mbps: 720p or HEVC 1080p
        expect(estimateQuality({ size: 6e9 }, min40)).toBe(''); // 20 Mbps: 4K or a pack
        expect(estimateQuality({ size: 3e9 }, 0)).toBe(''); // no scene length
    });
    it('puts the estimate in the stream name', () => {
        const [s] = fromReleases([{ key: 'h:1', name: 'HardX Lena Paul 1st Gangbang', infoHash: 'c'.repeat(40), seeders: 9, size: 3e9, liveChecked: true }], { title: { id: 'inc:scene:x', duration: 2400 } });
        expect(s.name).toBe('Incognito P2P\n~1080p');
    });
});

describe('P2P streams auto-pick may try', () => {
    const s = (q, live, hash = Math.random().toString(16).slice(2).padEnd(40, '0')) => ({
        name: `Incognito P2P\n${q}`, description: `release\n👤 ${live} 💾 1 GB`, infoHash: hash,
    });

    it('lets a 1080p copy with enough seeders in even when a 480p one has far more', () => {
        const hq = s('1080p', 15);
        const lq = s('480p', 180);
        const ok = p2pEligibility([hq, lq]);
        expect(ok(hq)).toBe(true);
        expect(ok(lq)).toBe(true);
    });

    it('lets 720p, 480p and untagged copies in on 5 live seeders too (auto-pick then plays the best quality)', () => {
        const mid = s('720p', 7);
        const lq = s('480p', 180);
        const sd = s('SD', 5);
        const est = s('~1080p', 6);
        const ok = p2pEligibility([mid, lq, sd, est]);
        expect(ok(mid)).toBe(true);
        expect(ok(lq)).toBe(true);
        expect(ok(sd)).toBe(true);
        expect(ok(est)).toBe(true);
    });

    it('treats an estimated "~1080p" as 1080p when deciding on 4K', () => {
        const uhd = s('4k', 30);
        expect(p2pEligibility([uhd, s('~1080p', 9)])(uhd)).toBe(false);
    });

    it('uses 4K only when no 1080p qualifies, and with at least 10 live seeders', () => {
        const uhd = s('4k', 6);
        const hd = s('1080p', 22);
        expect(p2pEligibility([uhd, hd])(uhd)).toBe(false);
        const uhdStrong = s('4k', 30);
        expect(p2pEligibility([uhdStrong, hd])(uhdStrong)).toBe(false);
        expect(p2pEligibility([uhdStrong, s('480p', 40)])(uhdStrong)).toBe(true);
        expect(p2pEligibility([s('4k', 8), s('480p', 40)])(s('4k', 8))).toBe(false);
    });

    it('never takes a swarm under 5 live seeders or an unverified count', () => {
        const weak = s('1080p', 4);
        const listed = { name: 'Incognito P2P\n1080p', description: 'x\n👤 ~428 listed', infoHash: 'f'.repeat(40) };
        const ok = p2pEligibility([weak, listed]);
        expect(ok(weak)).toBe(false);
        expect(ok(listed)).toBe(false);
    });

    it('ignores streams without an infoHash', () => {
        expect(p2pEligibility([{ name: 'RD', description: '👤 99' }])({ name: 'RD', description: '👤 99' })).toBe(false);
    });
});
