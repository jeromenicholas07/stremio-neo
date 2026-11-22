// Incognito recommendations input: the play log, the opt-in taste snapshot,
// the picks file, and the local "more like what you like" signals.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-taste-'));
process.env.INCOGNITO_DATA_DIR = dataDir;
process.env.INCOGNITO_TPDB_TOKEN_FILE = path.join(dataDir, 'no-token.txt');

const taste = require('../stremio-adult-addon/src/inc/taste');
const favorites = require('../stremio-adult-addon/src/inc/favorites');

const file = (name) => path.join(dataDir, name);
const scene = (n, extra = {}) => ({
    id: `inc:scene:${n}`, kind: 'scene', name: `Scene ${n}`, studio: 'Blacked',
    performers: ['Maya Woulfe', 'Jordan Maxx'], tags: ['Blonde', 'Interracial'],
    releases: [{ infoHash: 'a'.repeat(40) }], thumbnail: 'x.jpg', ...extra,
});

afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
    for (const f of ['plays.json', 'claude-picks.json', 'claude-taste.json', 'favorites.json']) {
        fs.rmSync(file(f), { force: true });
    }
    taste._reset();
    for (const t of favorites.get().titles) favorites.apply({ op: 'remove', type: 'title', value: t.id });
    for (const p of favorites.get().performers) favorites.apply({ op: 'remove', type: 'performer', value: p.name });
});

describe('play log', () => {
    it('keeps names only, newest first, and folds quick replays', () => {
        expect(taste.recordPlay(scene(1), 1000)).toBe(true);
        expect(taste.recordPlay(scene(2), 2000)).toBe(true);
        expect(taste.recordPlay(scene(1), 3000)).toBe(true); // replay within 6 h
        const plays = JSON.parse(fs.readFileSync(file('plays.json'), 'utf8')).plays;
        expect(plays.map((p) => p.id)).toEqual(['inc:scene:1', 'inc:scene:2']);
        expect(Object.keys(plays[0]).sort()).toEqual(['at', 'id', 'name', 'performers', 'studio', 'tags']);
        expect(JSON.stringify(plays)).not.toContain('a'.repeat(40));
    });

    it('counts a replay after the window as another play', () => {
        taste.recordPlay(scene(1), 0);
        taste.recordPlay(scene(1), 7 * 60 * 60 * 1000);
        expect(taste.plays()[0].count).toBe(2);
    });

    it('ignores titles without an id or name', () => {
        expect(taste.recordPlay(null)).toBe(false);
        expect(taste.recordPlay({ id: 'inc:scene:x' })).toBe(false);
    });
});

describe('Claude picks opt-in', () => {
    it('writes no taste snapshot until the picks file exists', () => {
        taste.recordPlay(scene(1));
        expect(fs.existsSync(file('claude-taste.json'))).toBe(false);
        expect(taste.readPicks()).toBeNull();

        fs.writeFileSync(file('claude-picks.json'), JSON.stringify({ generatedAt: '2026-11-22T10:00:00Z', picks: [] }));
        taste.recordPlay(scene(2));
        const snap = JSON.parse(fs.readFileSync(file('claude-taste.json'), 'utf8'));
        expect(snap.plays.map((p) => p.name)).toEqual(['Scene 2', 'Scene 1']);
        expect(snap.plays[0].id).toBeUndefined();
        expect(snap.favorites).toEqual({ titles: [], performers: [], studios: [], tags: [] });
    });

    it('validates picks: known kinds only, trimmed, at most 20', () => {
        fs.writeFileSync(file('claude-picks.json'), JSON.stringify({
            generatedAt: 'g1',
            picks: [
                { performer: '  Maya   Woulfe ', reason: 'Fits.' },
                { scene: 'Off To College', studio: 'FreeUseFantasy', reason: 'r' },
                { unknown: 'x' },
                { tag: '' },
                'junk',
                ...Array.from({ length: 30 }, (_, i) => ({ query: `q${i}` })),
            ],
        }));
        const { generatedAt, picks } = taste.readPicks();
        expect(generatedAt).toBe('g1');
        expect(picks).toHaveLength(20);
        expect(picks[0]).toEqual({ kind: 'performer', value: 'Maya Woulfe', studio: '', reason: 'Fits.' });
        expect(picks[1]).toEqual({ kind: 'scene', value: 'Off To College', studio: 'FreeUseFantasy', reason: 'r' });
        expect(picks[2].kind).toBe('query');
    });

    it('treats a malformed picks file as no picks', () => {
        fs.writeFileSync(file('claude-picks.json'), '{not json');
        expect(taste.readPicks()).toBeNull();
    });
});

describe('clearnet search sections', () => {
    const sections = require('../src/routes/Incognito/inc/searchSections');
    it('puts healthy P2P studio titles first, then other releases, then the rest; tube apart', () => {
        const t = (id, kind, releaseCount, seeders) => ({ id, kind, releaseCount, seeders });
        const out = sections([
            t('none', 'scene', 0, 0), t('weak', 'scene', 2, 3), t('tube1', 'tube'),
            t('movie', 'movie', 1, 9), t('ok', 'scene', 4, 40), t('none2', 'scene'),
        ]);
        expect(out.pro.map((x) => x.id)).toEqual(['movie', 'ok', 'weak', 'none', 'none2']);
        expect(out.tube.map((x) => x.id)).toEqual(['tube1']);
        expect(out.playable).toBe(2);
    });
});

describe('local signals', () => {
    it('needs repeat evidence, and skips what you already follow', () => {
        taste.recordPlay(scene(1, { performers: ['Once Only'], studio: '', tags: [] }));
        expect(taste.localSignals()).toEqual([]);

        favorites.apply({ op: 'add', type: 'title', value: scene(2) });
        favorites.apply({ op: 'add', type: 'performer', value: 'Jordan Maxx' });
        taste.recordPlay(scene(3));
        const sig = taste.localSignals();
        const names = sig.map((s) => `${s.kind}:${s.name}`);
        expect(names).toContain('performer:Maya Woulfe');
        expect(names).toContain('studio:Blacked');
        expect(names).not.toContain('performer:Jordan Maxx'); // followed already
        expect(names).not.toContain('performer:Once Only'); // a single play
        expect(sig[0]).toMatchObject({ kind: 'performer', name: 'Maya Woulfe', score: 3 });
    });

    it('lists favorited and played ids for the rows to skip', () => {
        favorites.apply({ op: 'add', type: 'title', value: scene(5) });
        taste.recordPlay(scene(6));
        expect([...taste.seenIds()].sort()).toEqual(['inc:scene:5', 'inc:scene:6']);
    });
});
