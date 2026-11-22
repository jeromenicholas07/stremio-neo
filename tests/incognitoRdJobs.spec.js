// Real-Debrid download jobs (the fallback when nothing plays right away):
// the job keeps the torrent on RD while it downloads, nothing else deletes
// it meanwhile, a finished job turns into [RD+], and abandoned or stuck
// jobs clean up after themselves.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-rdjobs-'));
process.env.INCOGNITO_DATA_DIR = dataDir;
process.env.INCOGNITO_CACHE_DIR = dataDir;
process.env.INCOGNITO_TPDB_TOKEN_FILE = path.join(dataDir, 'no-token.txt');

const rd = require('../stremio-adult-addon/src/rd');
const rdJobs = require('../stremio-adult-addon/src/inc/rdJobs');
const streamsOut = require('../stremio-adult-addon/src/inc/streams');

const TOKEN = 'test-token-0123456789';
const HASH = 'b'.repeat(40);
const files = [{ id: 7, path: '/scene.mp4', bytes: 900e6 }];

// A fake RD whose torrent state the test sets. Records calls.
function fakeRd(state) {
    const calls = [];
    rd._setRdFetch(async (token, method, p) => {
        calls.push(`${method} ${p}`);
        if (p === '/torrents/activeCount') return { ok: true, status: 200, body: { nb: state.active || 0, limit: 5 } };
        if (p === '/torrents/addMagnet') return { ok: true, status: 201, body: { id: 'J1' } };
        if (p.startsWith('/torrents/info/')) {
            return { ok: true, status: 200, body: { status: state.status, progress: state.progress || 0, speed: state.speed || 0, seeders: state.seeders || 0, bytes: 900e6, files } };
        }
        if (p.startsWith('/torrents/selectFiles/')) { state.selected = true; return { ok: true, status: 204, body: null }; }
        if (p.startsWith('/torrents/delete/')) return { ok: true, status: 204, body: null };
        return { ok: false, status: 404, body: null };
    });
    return calls;
}
const deletes = (calls) => calls.filter((c) => c.startsWith('DELETE')).length;

beforeEach(() => rdJobs._reset());
afterAll(() => {
    rdJobs._reset();
    rd._setRdFetch(null);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('download job', () => {
    it('picks the video, follows progress, and turns into [RD+] when done', async () => {
        const state = { status: 'waiting_files_selection' };
        const calls = fakeRd(state);
        let job = await rdJobs.start({ infoHash: HASH, title: 'Scene', token: TOKEN });
        expect(job.state).toBe('finding');
        expect(state.selected).toBe(true);

        Object.assign(state, { status: 'downloading', progress: 40, speed: 2 * 1024 ** 2, seeders: 2 });
        await rdJobs._tick(rdJobs._jobs.get(HASH));
        job = rdJobs.status(HASH);
        expect(job).toMatchObject({ state: 'downloading', progress: 40, seeders: 2 });
        expect(job.etaSec).toBe(Math.round((900e6 * 0.6) / (2 * 1024 ** 2)));

        state.status = 'downloaded';
        await rdJobs._tick(rdJobs._jobs.get(HASH));
        expect(rdJobs.status(HASH).state).toBe('ready');
        // Now cached: the title page's check says so without touching RD again.
        const before = calls.length;
        expect(await rd.checkCached({ infoHash: HASH, title: 'Scene', token: TOKEN })).toBe(true);
        expect(calls.length).toBe(before);
        expect(deletes(calls)).toBe(0);
    });

    it('is not deleted by a cache check or a failed play while it runs', async () => {
        const state = { status: 'downloading', progress: 5 };
        const calls = fakeRd(state);
        await rdJobs.start({ infoHash: HASH, title: 'Scene', token: TOKEN });
        expect(await rd.checkCached({ infoHash: HASH, title: 'Scene', token: TOKEN })).toBe(false);
        expect(rd.seenDownloading(TOKEN, HASH)).toBe(true);
        await rd.abandonIfNotReady({ infoHash: HASH, token: TOKEN });
        expect(deletes(calls)).toBe(0);
        expect(calls.filter((c) => c === 'POST /torrents/addMagnet')).toHaveLength(1);
    });

    it('takes over the torrent a cache check parked instead of adding it again', async () => {
        const state = { status: 'waiting_files_selection' };
        const calls = fakeRd(state);
        // The title page's check: RD starts fetching it → parked, not deleted.
        rd._setRdFetch(null);
        const checkCalls = [];
        let n = 0;
        rd._setRdFetch(async (token, method, p) => {
            checkCalls.push(`${method} ${p}`);
            if (p === '/torrents/addMagnet') return { ok: true, status: 201, body: { id: 'P9' } };
            if (p.startsWith('/torrents/info/')) {
                n++;
                return { ok: true, status: 200, body: n === 1 ? { status: 'waiting_files_selection', files } : { status: 'downloading', progress: 0, files } };
            }
            if (p === '/torrents/activeCount') return { ok: true, status: 200, body: { nb: 0, limit: 5 } };
            return { ok: true, status: 204, body: null };
        });
        expect(await rd.checkCached({ infoHash: HASH, title: 'Scene', token: TOKEN })).toBe(false);
        const added = checkCalls.filter((c) => c === 'POST /torrents/addMagnet').length;
        const job = await rdJobs.start({ infoHash: HASH, title: 'Scene', token: TOKEN });
        expect(job.state).toBe('downloading');
        expect(checkCalls.filter((c) => c === 'POST /torrents/addMagnet').length).toBe(added);
        expect(checkCalls.some((c) => c.startsWith('DELETE'))).toBe(false);
        expect(calls).toEqual([]);
    }, 10000);

    it('rejoins the running job instead of adding the torrent again', async () => {
        const calls = fakeRd({ status: 'downloading', progress: 5 });
        await rdJobs.start({ infoHash: HASH, title: 'Scene', token: TOKEN });
        await rdJobs.start({ infoHash: HASH, title: 'Scene', token: TOKEN });
        expect(calls.filter((c) => c === 'POST /torrents/addMagnet')).toHaveLength(1);
    });

    it('deletes the torrent on cancel, when nobody watches, and when stuck', async () => {
        let calls = fakeRd({ status: 'downloading', progress: 5 });
        await rdJobs.start({ infoHash: HASH, title: 'Scene', token: TOKEN });
        expect((await rdJobs.cancel(HASH)).state).toBe('cancelled');
        expect(deletes(calls)).toBe(1);

        rdJobs._reset();
        calls = fakeRd({ status: 'downloading', progress: 5 });
        await rdJobs.start({ infoHash: HASH, title: 'Scene', token: TOKEN });
        rdJobs._jobs.get(HASH).watchedAt -= rdJobs.UNWATCHED_MS + 1000;
        await rdJobs._tick(rdJobs._jobs.get(HASH));
        expect(rdJobs.status(HASH).state).toBe('cancelled');
        expect(deletes(calls)).toBe(1);

        rdJobs._reset();
        calls = fakeRd({ status: 'downloading', progress: 5 });
        await rdJobs.start({ infoHash: HASH, title: 'Scene', token: TOKEN });
        rdJobs._jobs.get(HASH).progressAt -= rdJobs.STALL_MS + 1000;
        await rdJobs._tick(rdJobs._jobs.get(HASH));
        expect(rdJobs.status(HASH)).toMatchObject({ state: 'stalled' });
        expect(rdJobs.status(HASH).message).toContain('no progress');
        expect(deletes(calls)).toBe(1);
    });

    it('retries an early RD "error" once, then gives up and cleans up', async () => {
        const state = { status: 'error' };
        const calls = fakeRd(state);
        let job = await rdJobs.start({ infoHash: HASH, title: 'Scene', token: TOKEN });
        expect(job.state).toBe('finding'); // waiting to re-add
        expect(deletes(calls)).toBe(1);
        const j = rdJobs._jobs.get(HASH);
        j.readdAt = 0;
        await rdJobs._tick(j); // re-adds and sees "error" again
        job = rdJobs.status(HASH);
        expect(job.state).toBe('dead');
        expect(job.message).toContain('no reachable peers');
        expect(calls.filter((c) => c === 'POST /torrents/addMagnet')).toHaveLength(2);
        expect(deletes(calls)).toBe(2);
    });

    it('runs one job at a time and respects RD’s download limit', async () => {
        const state = { status: 'downloading', progress: 5 };
        const calls = fakeRd(state);
        await rdJobs.start({ infoHash: HASH, title: 'One', token: TOKEN });
        await rdJobs.start({ infoHash: 'c'.repeat(40), title: 'Two', token: TOKEN });
        expect(rdJobs.status(HASH).state).toBe('cancelled');
        expect(deletes(calls)).toBe(1);

        rdJobs._reset();
        state.active = 5;
        const job = await rdJobs.start({ infoHash: 'd'.repeat(40), title: 'Three', token: TOKEN });
        expect(job.state).toBe('error');
        expect(job.message).toContain('limit');
    });
});

describe('[RD download] entries', () => {
    const rel = (h, seeders, extra = {}) => ({ infoHash: h, name: `rel ${h[0]}`, seeders, liveChecked: true, ...extra });

    it('offer releases RD saw downloading first, and route them to the download page', () => {
        const swarmHash = 'e'.repeat(40);
        const rdCached = new Map([[swarmHash, false], ['f'.repeat(40), null]]);
        rdCached.swarm = new Set([swarmHash]);
        const out = streamsOut.fromReleases([rel('f'.repeat(40), 3), rel(swarmHash, 1)], { title: { id: 'inc:scene:x' }, rdCached, rdEnabled: true });
        const rdEntries = out.filter((s) => /\[RD download\]/.test(s.name));
        expect(rdEntries).toHaveLength(2);
        expect(rdEntries[0].description).toContain('rel e');
        expect(typeof rdEntries[0].rdJob).toBe('string');
        expect(rdEntries[0].url).toBe(`/inc/rd/${rdEntries[0].rdJob}`);
    });

    it('leave dead magnets out, and add none when something already plays', () => {
        const dead = 'a'.repeat(40);
        const rdCached = new Map([[dead, false]]);
        rdCached.swarm = new Set();
        let out = streamsOut.fromReleases([rel(dead, 2)], { title: { id: 't' }, rdCached, rdEnabled: true });
        expect(out.some((s) => /\[RD download\]/.test(s.name))).toBe(false);

        out = streamsOut.fromReleases([rel(dead, 40), rel('9'.repeat(40), 3)], { title: { id: 't' }, rdCached: new Map(), rdEnabled: true });
        expect(out.some((s) => /\[RD download\]/.test(s.name))).toBe(false);
    });
});
