// Real-Debrid on the Incognito title page: the cache check must only say
// "not cached" when RD is seen fetching the torrent (or the magnet is dead);
// anything it can't tell is "unknown" and forgotten within minutes, and an
// unconfirmed RD entry is always offered as a safety net.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-rd-'));
process.env.INCOGNITO_DATA_DIR = dataDir;
process.env.INCOGNITO_TPDB_TOKEN_FILE = path.join(dataDir, 'no-token.txt');

const rd = require('../stremio-adult-addon/src/rd');
const streamsOut = require('../stremio-adult-addon/src/inc/streams');
const autoPick = require('../src/common/autoPick');
const { p2pEligibility } = require('../src/routes/Incognito/inc/p2pEligibility');

const TOKEN = 'test-token-0123456789';
const HASH = 'a'.repeat(40);

// A fake RD: `script` decides each response. Records calls.
function fakeRd(script) {
    const calls = [];
    let infoCalls = 0;
    rd._setRdFetch(async (token, method, p) => {
        calls.push(`${method} ${p.replace(/\/[A-Z0-9]+$/, '/:id')}`);
        if (p === '/torrents/addMagnet') return script.addMagnet ? script.addMagnet() : { ok: true, status: 201, body: { id: 'T1' } };
        if (p.startsWith('/torrents/info/')) {
            infoCalls++;
            return script.info(infoCalls);
        }
        if (p.startsWith('/torrents/selectFiles/')) return { ok: true, status: 204, body: null };
        if (p.startsWith('/torrents/delete/')) return { ok: true, status: 204, body: null };
        return { ok: false, status: 404, body: null };
    });
    return calls;
}
const files = [{ id: 1, path: '/scene.mp4', bytes: 400e6 }];
const listingThen = (statuses) => (n) => {
    if (n === 1) return { ok: true, status: 200, body: { status: 'waiting_files_selection', files } };
    const s = statuses[Math.min(n - 2, statuses.length - 1)];
    return { ok: true, status: 200, body: { status: s, progress: s === 'downloading' ? 3 : 0, files } };
};
const deleted = (calls) => calls.some((c) => c.startsWith('DELETE'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

afterAll(() => {
    rd._setRdFetch(null);
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('Real-Debrid cache check', () => {
    it('says cached when RD has it, and keeps the torrent', async () => {
        const calls = fakeRd({ info: listingThen(['downloaded']) });
        expect(await rd.checkCached({ infoHash: HASH, title: 'x', token: TOKEN })).toBe(true);
        expect(deleted(calls)).toBe(false);
    });

    it('waits for a cached torrent that flips to "downloaded" after ~3 s', async () => {
        fakeRd({ info: listingThen(['queued', 'queued', 'queued', 'queued', 'downloaded']) });
        expect(await rd.checkCached({ infoHash: HASH, title: 'x', token: TOKEN })).toBe(true);
    }, 10000);

    it('says not cached only when RD is seen downloading it, and parks it for a download job', async () => {
        const calls = fakeRd({ info: listingThen(['downloading']) });
        expect(await rd.checkCached({ infoHash: HASH, title: 'x', token: TOKEN })).toBe(false);
        // Not deleted at once (a re-add would make RD answer "error"): a
        // download job can take it over, else it's deleted a few minutes later.
        expect(deleted(calls)).toBe(false);
        expect(rd.seenDownloading(TOKEN, HASH)).toBe(true);
        expect(rd.adoptParked(TOKEN, HASH)).toBe('T1');
        expect(rd.adoptParked(TOKEN, HASH)).toBeNull();
    }, 10000);

    it('says not cached for a dead magnet', async () => {
        fakeRd({ info: () => ({ ok: true, status: 200, body: { status: 'magnet_error', files: [] } }) });
        expect(await rd.checkCached({ infoHash: HASH, title: 'x', token: TOKEN })).toBe(false);
    });

    it('treats a 429 as unknown, and does not remember it as "no"', async () => {
        const calls = fakeRd({ addMagnet: () => ({ ok: false, status: 429, body: { error: 'too_many_requests' }, raw: 'too_many_requests' }), info: listingThen(['downloaded']) });
        expect(await rd.checkCached({ infoHash: HASH, title: 'x', token: TOKEN })).toBeNull();
        // The verdict is short-lived: forget it and RD answers properly next time.
        const calls2 = fakeRd({ info: listingThen(['downloaded']) });
        expect(await rd.checkCached({ infoHash: HASH, title: 'x', token: TOKEN })).toBe(true);
        expect(calls.length).toBeGreaterThan(0);
        expect(calls2[0]).toBe('POST /torrents/addMagnet');
    }, 15000);

    it('gets past a single 429 by pausing and retrying', async () => {
        let first = true;
        fakeRd({
            addMagnet: () => {
                if (first) { first = false; return { ok: false, status: 429, body: null, raw: 'too_many_requests' }; }
                return { ok: true, status: 201, body: { id: 'T1' } };
            },
            info: listingThen(['downloaded']),
        });
        expect(await rd.checkCached({ infoHash: HASH, title: 'x', token: TOKEN })).toBe(true);
    }, 10000);

    it('treats a file list slower than the budget as unknown, then cleans up', async () => {
        const calls = fakeRd({ info: (n) => (n < 2 ? { ok: true, status: 200, body: { status: 'magnet_conversion', files: [] } } : { ok: true, status: 200, body: { status: 'waiting_files_selection', files } }) });
        expect(await rd.checkCached({ infoHash: HASH, title: 'x', token: TOKEN, budgetMs: 200 })).toBeNull();
        await sleep(1500);
        expect(deleted(calls)).toBe(true);
    }, 10000);
});

describe('Real-Debrid entries on the title page', () => {
    const rel = (h, name, listed, live, quality = '1080p') => ({
        key: `h:${h}`, name, infoHash: h.repeat(40).slice(0, 40), seeders: live, listedSeeders: listed, liveChecked: true, quality, size: 400e6,
    });
    const title = { id: 'inc:scene:x', duration: 2400 };

    it('offers the two most popular releases as "[RD download]" when nothing else is playable', () => {
        const releases = [rel('b', 'Shoplyfter Jenna Foxx 16 10 2019', 349, 2, ''), rel('c', 'Jenna Foxx Case No', 3, 0), rel('d', 'other', 0, 0)];
        const out = streamsOut.fromReleases(releases, { title, rdCached: new Map(), rdEnabled: true });
        const rdStreams = out.filter((s) => /RD/.test(s.name));
        expect(rdStreams.map((s) => s.name)).toEqual(['[RD download] Incognito\nSD', '[RD download] Incognito\n1080p']);
        expect(rdStreams[0].url).toMatch(/^\/inc\/rd\//);
        expect(rdStreams[0].description).toContain('Shoplyfter Jenna Foxx');
    });

    it('auto-pick plays "[RD download]" there, ahead of the weak P2P copies', () => {
        const releases = [rel('b', 'Shoplyfter Jenna Foxx 16 10 2019', 349, 2, ''), rel('c', 'Jenna Foxx Case No', 3, 0)];
        const raw = streamsOut.fromReleases(releases, { title, rdCached: new Map(), rdEnabled: true });
        const ok = p2pEligibility(raw);
        const streams = raw.map((s) => ({ ...s, incognitoP2P: Boolean(s.infoHash) && ok(s), deepLinks: { player: `#/player/${s.name}${s.description}` } }));
        const [first] = autoPick.getAutoPickCandidates(streams, autoPick.getDefaultAutoPickSettings());
        expect(first.name).toMatch(/^\[RD download\]/);
    });

    it('shows "[RD+]" for a confirmed copy and no unconfirmed extras then', () => {
        const releases = [rel('b', 'A', 349, 2), rel('c', 'B', 30, 0)];
        const out = streamsOut.fromReleases(releases, { title, rdCached: new Map([['b'.repeat(40), true]]), rdEnabled: true });
        expect(out.filter((s) => /RD/.test(s.name)).map((s) => s.name)).toEqual(['[RD+] Incognito\n1080p']);
    });

    it('keeps one manual-only RD entry when a healthy P2P copy exists, and auto-pick plays the P2P', () => {
        const releases = [rel('b', 'A', 100, 40), rel('c', 'B', 349, 0)];
        const raw = streamsOut.fromReleases(releases, { title, rdCached: new Map([['c'.repeat(40), null]]), rdEnabled: true });
        const manual = raw.filter((s) => /RD/.test(s.name));
        expect(manual.map((s) => s.name)).toEqual(['RD (unconfirmed)\n1080p']);
        expect(autoPick.streamSourceKeys(manual[0])).toEqual(['other']);
        const ok = p2pEligibility(raw);
        const streams = raw.map((s) => ({ ...s, incognitoP2P: Boolean(s.infoHash) && ok(s), deepLinks: { player: `#/player/${s.name}${s.description}` } }));
        expect(autoPick.getAutoPickCandidates(streams, autoPick.getDefaultAutoPickSettings())[0].name).toBe('Incognito P2P\n1080p');
    });

    it('never offers RD for releases RD is known not to have, or without an RD token', () => {
        const releases = [rel('b', 'A', 349, 2)];
        expect(streamsOut.fromReleases(releases, { title, rdCached: new Map([['b'.repeat(40), false]]), rdEnabled: true }).filter((s) => /RD/.test(s.name))).toEqual([]);
        expect(streamsOut.fromReleases(releases, { title, rdCached: new Map(), rdEnabled: false }).filter((s) => /RD/.test(s.name))).toEqual([]);
    });
});
