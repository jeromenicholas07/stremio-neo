// Prowlarr releases without a hash (PornoLab, XXXClub): search resolves only
// a few per indexer and never spends PornoLab's rationed downloads; the
// title page resolves its matches, PornoLab only when nothing else plays.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-prowlarr-'));
process.env.INCOGNITO_DATA_DIR = dataDir;
process.env.INCOGNITO_CACHE_DIR = dataDir;
process.env.INCOGNITO_TPDB_TOKEN_FILE = path.join(dataDir, 'no-token.txt');

const prowlarr = require('../stremio-adult-addon/src/prowlarr');
const catalog = require('../stremio-adult-addon/src/inc/catalog');

afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('search-time hash lookups', () => {
    const item = (indexer, seeders, n) => ({ indexer, seeders, title: `${indexer} ${n}`, downloadUrl: `http://127.0.0.1:1/${indexer}/${n}` });

    it('takes the best-seeded few per indexer and never PornoLab', () => {
        const items = [
            ...Array.from({ length: 10 }, (_, i) => item('XXXClub', 100 - i, i)),
            ...Array.from({ length: 5 }, (_, i) => item('PornoLab', 500 - i, i)),
            ...Array.from({ length: 2 }, (_, i) => item('MyPornClub', 1 + i, i)),
        ];
        const picked = prowlarr._pickForEnrichment(items);
        expect(picked.filter((p) => p.indexer === 'PornoLab')).toHaveLength(0);
        expect(picked.filter((p) => p.indexer === 'XXXClub').map((p) => p.seeders)).toEqual([100, 99, 98]);
        expect(picked.filter((p) => p.indexer === 'MyPornClub')).toHaveLength(2);
    });

    it('treats PornoLab as metered, others not', () => {
        expect(prowlarr.isMetered('PornoLab')).toBe(true);
        expect(prowlarr.isMetered('XXXClub')).toBe(false);
        expect(prowlarr.isMetered('')).toBe(false);
    });
});

describe('XXXClub direct adapter', () => {
    const { parseXxxclub, SOURCES } = require('../stremio-adult-addon/src/directSources');
    const row = (hash, title, see) => `<li> <span class="catlabe" > <a class="catah" href="/torrents/browse/1/"><lable class="catla">HD</lable></a> </span>
        <span class="toral"> <a title="" href="/torrents/browse/all/1" id="#ie8a6aba764241ccf54723c6eec85d18014b71" style="position:absolute">Studio</a>
        <a href="/torrents/details/~-1" title="" id="#i${hash}">${title}</a> </span>
        <span class="adde thre fou addedtable">02 Jun 2026 18:56:36</span> <span class="siz thre fou">412.47 MB</span>
        <span class="see thre">${see}</span> <span class="lee thre">1</span> <span class="uploadertable fou">x</span> </li>`;
    const page = `<div class="browsetableinside"> <ul class="tsearch"> <li> <span>Category</span> <span>Name</span> </li>
        ${row('d4a7379b339140cd6b91475523efd8c406b04552', 'BrazzersExxtra 26 06 02 <mark>Jenna</mark> Foxx &amp; Friends 720p', 3)}
        ${row('nothex', 'Broken row', 9)}</ul></div>`;

    it('reads the hash from the title link id, with seeders, size and date', () => {
        const [a, ...rest] = parseXxxclub(page);
        expect(rest).toHaveLength(0);
        expect(a).toMatchObject({
            infoHash: 'd4a7379b339140cd6b91475523efd8c406b04552',
            title: 'BrazzersExxtra 26 06 02 Jenna Foxx & Friends 720p',
            seeders: 3, peers: 1, indexer: 'XXXClub',
        });
        expect(a.size).toBe(Math.round(412.47 * 1024 ** 2));
        expect(a.magnetUrl).toContain('btih:d4a7379b');
        expect(a.pubDate.startsWith('2026-06-02')).toBe(true);
    });

    it('replaces the XXXClub Prowlarr indexer', () => {
        expect(SOURCES.find((s) => s.id === 'xxxclub').prowlarrName).toBe('XXXClub');
        expect(parseXxxclub('<html>no table</html>')).toEqual([]);
    });
});

describe('title-page hash lookups', () => {
    const hashed = (h, seeders) => ({ key: `h:${h}`, infoHash: h, seeders, name: h });
    const linkOnly = (indexer, seeders, n) => ({ key: `m:${indexer}${n}`, infoHash: '', seeders, indexer, name: `${indexer} ${n}`, downloadUrl: `http://127.0.0.1:1/${n}` });

    it('keeps one entry per torrent, the best-seeded listing', async () => {
        const a = 'a'.repeat(40);
        const out = await catalog._withResolvedHashes([hashed(a, 3), hashed('b'.repeat(40), 9), hashed(a, 12)]);
        expect(out.map((r) => [r.infoHash[0], r.seeders])).toEqual([['a', 12], ['b', 9]]);
    });

    it('leaves PornoLab links alone when another release already has seeders', async () => {
        const pl = linkOnly('PornoLab', 40, 1);
        const out = await catalog._withResolvedHashes([hashed('c'.repeat(40), 8), pl]);
        // Unresolved, still listed (it resolves when opened).
        expect(out).toContain(pl);
        expect(pl.infoHash).toBe('');
    });

    it('returns within its budget when lookups fail', async () => {
        const t0 = Date.now();
        const out = await catalog._withResolvedHashes([linkOnly('XXXClub', 5, 1), linkOnly('PornoLab', 2, 2)]);
        expect(out).toHaveLength(2);
        expect(Date.now() - t0).toBeLessThan(9000);
    });
});
