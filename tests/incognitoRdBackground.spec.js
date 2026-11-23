// Background Real-Debrid caching of thin favorites: a favorite nothing plays
// well gets its best release downloaded on RD and followed until cached;
// failures move on to the next release; unfavoriting removes the download;
// a play-time download job shares the torrent instead of duplicating it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-rdbg-'));
process.env.INCOGNITO_DATA_DIR = dataDir;
process.env.INCOGNITO_CACHE_DIR = dataDir;
process.env.INCOGNITO_TPDB_TOKEN_FILE = path.join(dataDir, 'no-token.txt');
fs.writeFileSync(path.join(dataDir, 'realdebrid-token.txt'), 'test-token-0123456789\n');

const rd = require('../stremio-adult-addon/src/rd');
const rdBackground = require('../stremio-adult-addon/src/inc/rdBackground');
const rdJobs = require('../stremio-adult-addon/src/inc/rdJobs');

const TOKEN = 'test-token-0123456789';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const files = [{ id: 3, path: '/scene.mp4', bytes: 500e6 }];

// Fake RD: per-torrent status the test controls. Records calls.
function fakeRd(statusById) {
    const calls = [];
    let next = 0;
    rd._setRdFetch(async (token, method, p) => {
        calls.push(`${method} ${p}`);
        if (p === '/torrents/addMagnet') { next++; return { ok: true, status: 201, body: { id: `T${next}` } }; }
        if (p === '/torrents/activeCount') return { ok: true, status: 200, body: { nb: 0, limit: 50 } };
        if (p.startsWith('/torrents/info/')) {
            const id = p.split('/').pop();
            return { ok: true, status: 200, body: { status: statusById[id] || 'waiting_files_selection', progress: statusById[`${id}%`] || 0, seeders: 1, files } };
        }
        return { ok: true, status: 204, body: null };
    });
    return calls;
}
const fakeCatalog = (cov) => ({ coverage: async () => cov });
const thin = { name: 'Scene', cached: false, healthy: false, candidates: [{ infoHash: A, name: 'rel A', seeders: 2 }, { infoHash: B, name: 'rel B', seeders: 1 }] };

beforeEach(() => {
    rdBackground._reset();
    rdJobs._reset();
});
afterAll(() => {
    rdBackground._reset();
    rdJobs._reset();
    rd._setRdFetch(null);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('background caching of thin favorites', () => {
    it('downloads the best release, follows it, and marks it cached', async () => {
        const st = {};
        const calls = fakeRd(st);
        rdBackground._setCatalog(fakeCatalog(thin));
        rdBackground.consider('inc:scene:1', { id: 'inc:scene:1', name: 'Scene' });
        await rdBackground.run();
        expect(rdBackground.statusFor('inc:scene:1')).toMatchObject({ state: 'downloading', release: 'rel A' });
        expect(rd.isProtected(A)).toBe(true);
        expect(calls.filter((c) => c === 'POST /torrents/addMagnet')).toHaveLength(1);

        Object.assign(st, { T1: 'downloading', 'T1%': 42 });
        await rdBackground.run();
        expect(rdBackground.statusFor('inc:scene:1')).toMatchObject({ state: 'downloading', progress: 42 });

        st.T1 = 'downloaded';
        await rdBackground.run();
        expect(rdBackground.statusFor('inc:scene:1').state).toBe('cached');
        expect(rd.isProtected(A)).toBe(false);
        // The title page now offers it as [RD+] without asking RD again.
        const before = calls.length;
        expect(await rd.checkCached({ infoHash: A, title: 'rel A', token: TOKEN })).toBe(true);
        expect(calls.length).toBe(before);
        expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
    });

    it('moves on to the next release when RD fails one', async () => {
        const st = {};
        const calls = fakeRd(st);
        rdBackground._setCatalog(fakeCatalog(thin));
        rdBackground.consider('inc:scene:2', { id: 'inc:scene:2' });
        await rdBackground.run();
        st.T1 = 'error';
        await rdBackground.run(); // drops A, starts B
        expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
        expect(rdBackground.statusFor('inc:scene:2')).toMatchObject({ state: 'downloading', release: 'rel B' });
    });

    it('leaves favorites that already play alone', async () => {
        const calls = fakeRd({});
        rdBackground._setCatalog(fakeCatalog({ ...thin, healthy: true }));
        rdBackground.consider('inc:scene:3', {});
        await rdBackground.run();
        expect(rdBackground.statusFor('inc:scene:3').state).toBe('covered');
        rdBackground._setCatalog(fakeCatalog({ ...thin, cached: true }));
        rdBackground.consider('inc:scene:4', {});
        await rdBackground.run();
        expect(rdBackground.statusFor('inc:scene:4').state).toBe('cached');
        expect(calls.filter((c) => c === 'POST /torrents/addMagnet')).toHaveLength(0);
    });

    it('removes the download when the favorite is removed', async () => {
        const calls = fakeRd({});
        rdBackground._setCatalog(fakeCatalog(thin));
        rdBackground.consider('inc:scene:5', {});
        await rdBackground.run();
        await rdBackground.forget('inc:scene:5');
        expect(rdBackground.statusFor('inc:scene:5')).toBeNull();
        expect(calls.filter((c) => c.startsWith('DELETE'))).toHaveLength(1);
        expect(rd.isProtected(A)).toBe(false);
    });

    it('runs a few at once and queues the rest', async () => {
        fakeRd({});
        let n = 0;
        rdBackground._setCatalog({ coverage: async () => { n++; return { ...thin, candidates: [{ infoHash: String(n).repeat(40).slice(0, 40).replace(/\d/g, (d) => 'abcdef0123'[d]), name: `r${n}`, seeders: 1 }] }; } });
        for (let i = 0; i < rdBackground.MAX_ACTIVE + 2; i++) rdBackground.consider(`inc:scene:q${i}`, {});
        await rdBackground.run();
        const states = Array.from({ length: rdBackground.MAX_ACTIVE + 2 }, (_, i) => rdBackground.statusFor(`inc:scene:q${i}`).state);
        expect(states.filter((s) => s === 'downloading')).toHaveLength(rdBackground.MAX_ACTIVE);
        expect(states.filter((s) => s === 'queued')).toHaveLength(2);
    });

    it('lets a play-time download share the torrent, and keeps it on cancel', async () => {
        const st = { T1: 'downloading', 'T1%': 10 };
        const calls = fakeRd(st);
        rdBackground._setCatalog(fakeCatalog(thin));
        rdBackground.consider('inc:scene:6', {});
        await rdBackground.run();
        const job = await rdJobs.start({ infoHash: A, title: 'rel A', token: TOKEN });
        expect(job.state).toBe('downloading');
        expect(calls.filter((c) => c === 'POST /torrents/addMagnet')).toHaveLength(1);
        await rdJobs.cancel(A);
        expect(calls.some((c) => c.startsWith('DELETE'))).toBe(false);
        expect(rd.isProtected(A)).toBe(true);
    });
});
