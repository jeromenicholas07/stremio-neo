// Incognito search understanding (performer / studio in a query, typos,
// leftover keywords) and which P2P streams auto-pick may try (1080p first).

const entities = require('../stremio-adult-addon/src/inc/searchEntities');
const { p2pEligibility } = require('../src/routes/Incognito/inc/p2pEligibility');

// ThePornDB stand-in: performer search corrects typos, site search is exact.
const PERFORMERS = ['Lena Paul', 'Angela White', 'Little Caprice'];
const SITES = [{ name: 'Tushy', shortName: 'tushy' }, { name: 'Vixen', shortName: 'vixen' }, { name: 'Brazzers', shortName: 'brazzers' }, { name: 'Blacked Raw', shortName: 'blackedraw' }];
const calls = [];
async function lookup(kind, q) {
    calls.push(`${kind}:${q}`);
    if (kind === 'performers') return PERFORMERS.filter((p) => entities.closeName(q, p)).map((name) => ({ name }));
    return SITES.filter((s) => s.name.toLowerCase() === q.toLowerCase());
}

beforeEach(() => { calls.length = 0; });

describe('search entities', () => {
    it('recognises a performer, typos included', async () => {
        expect(await entities.resolve('lena pual', lookup)).toMatchObject({ kind: 'performer', name: 'Lena Paul', rest: [] });
        expect(await entities.resolve('Angela Whte', lookup)).toMatchObject({ kind: 'performer', name: 'Angela White' });
    });

    it('stops after the whole query when it is a name', async () => {
        await entities.resolve('lena paul', lookup);
        expect(calls).toEqual(['performers:lena paul', 'sites:lena paul']);
    });

    it('splits a performer from leftover keywords', async () => {
        expect(await entities.resolve('lena paul anal', lookup)).toMatchObject({ kind: 'performer', name: 'Lena Paul', rest: ['anal'] });
    });

    it('recognises studios, and fixes typos in big studio names', async () => {
        expect(await entities.resolve('tushy', lookup)).toMatchObject({ kind: 'studio', name: 'Tushy', shortName: 'tushy' });
        expect(await entities.resolve('brazers', lookup)).toMatchObject({ kind: 'studio', name: 'Brazzers' });
        expect(await entities.resolve('vixen laying it bare', lookup)).toMatchObject({ kind: 'studio', name: 'Vixen', rest: ['laying', 'it', 'bare'] });
        expect(await entities.resolve('blacked raw', lookup)).toMatchObject({ kind: 'studio', name: 'Blacked Raw' });
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

    it('says how the query reads once corrected', () => {
        expect(entities.correctedQuery('lena pual anal', { name: 'Lena Paul', span: 'lena pual' })).toBe('Lena Paul anal');
        expect(entities.correctedQuery('lena paul', { name: 'Lena Paul', span: 'lena paul' })).toBeNull();
        expect(entities.correctedQuery('x', null)).toBeNull();
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

    it('keeps the relative bar for 720p and below', () => {
        const mid = s('720p', 7);
        const lq = s('480p', 180);
        expect(p2pEligibility([mid, lq])(mid)).toBe(false);
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
