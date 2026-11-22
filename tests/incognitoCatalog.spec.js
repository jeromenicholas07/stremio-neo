// Incognito clearnet catalog: the addon-side logic that decides what a
// title is, which releases belong together, and what gets stored.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-test-'));
process.env.INCOGNITO_DATA_DIR = dataDir;
process.env.INCOGNITO_TPDB_TOKEN_FILE = path.join(dataDir, 'no-token.txt');

const tpdb = require('../stremio-adult-addon/src/inc/sources/theporndb');
const scenes = require('../stremio-adult-addon/src/inc/scenes');
const relay = require('../stremio-adult-addon/src/inc/relay');
const eporner = require('../stremio-adult-addon/src/inc/sources/eporner');
const { mergeTube } = require('../stremio-adult-addon/src/inc/catalog');
const favorites = require('../stremio-adult-addon/src/inc/favorites');
const { imageUrl } = require('../stremio-adult-addon/src/inc/titles');
const routesRegexp = require('../src/common/routesRegexp');

afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('ThePornDB match checks', () => {
    it('reads "yy mm dd" and trailing "dd mm yyyy" release dates', () => {
        expect(tpdb.releaseDate('FreeUseFantasy 23 01 07 Jordan Maxx And Maya Woulfe Off To College XXX')).toBe('2023-01-07');
        expect(tpdb.releaseDate('BrazzersExxtra Jolee Love Strike A Pose 15 10 2019')).toBe('2019-10-15');
        expect(tpdb.releaseDate('Angela White I Waited For You rq')).toBe('');
    });

    it('accepts a parse result whose date matches the release', () => {
        expect(tpdb.plausible('Vixen 21 04 16 Agatha Vega XXX -XXX', {
            title: 'Trading Up', date: '2021-04-16', performers: [{ name: 'Agatha Vega' }],
        })).toBe(true);
    });

    it('rejects a parse result with a different date', () => {
        expect(tpdb.plausible('BangBros18 20 07 18 Kira Perez -XXX', {
            title: 'Kira Perez Fucks Her Stepdad', date: '2020-04-07', performers: [{ name: 'Kira Perez' }],
        })).toBe(false);
    });

    it('rejects a bare performer name (parse always returns some scene for one)', () => {
        expect(tpdb.plausible('Clea Gaultier', {
            title: 'Clea Gaultier', date: '2025-07-11', performers: [{ name: 'Clea Gaultier' }],
        })).toBe(false);
    });

    it('accepts an undated release that names most of the title', () => {
        expect(tpdb.plausible('Tushy Anastasia Knight Rebel Rebel', {
            title: 'Rebel Rebel', date: '2019-03-27', performers: [{ name: 'Anastasia Knight' }],
        })).toBe(true);
    });
});

describe('scene grouping fallback', () => {
    it('parses studio, date and body from a release name', () => {
        expect(scenes.parseName('MomsLickTeens.23.03.13.Maya.Woulfe.And.Wendy.Raine.XXX.720p.HEVC')).toEqual({
            studio: 'MomsLickTeens', date: '2023-03-13', body: 'Maya Woulfe And Wendy Raine XXX 720p HEVC',
        });
    });

    it('gives two releases of one scene the same key', () => {
        const a = scenes.fallbackKey({ name: 'AnalMom 24 12 05 Jordan Maxx And Alyssia Vera XXX WRB' });
        const b = scenes.fallbackKey({ name: 'AnalMom 24 12 05 Jordan Maxx And Alyssia Vera XXX XXX' });
        expect(a).toBeTruthy();
        expect(a).toBe(b);
    });

    it('keeps two scenes a studio released on the same day apart', () => {
        const a = scenes.fallbackKey({ name: 'BrazzersExxtra 20 04 29 Siri And Angela White Sneaky Shower Threesome -XXX' });
        const b = scenes.fallbackKey({ name: 'BrazzersExxtra 20 04 29 Luna Star All Dolled Up Anal Edition -XXX' });
        expect(a).not.toBe(b);
    });
});

describe('tube merging', () => {
    const t = (site, name, duration) => ({ id: `inc:tube:${site}:${name}`, site, siteId: name, siteName: site, name, duration });

    it('folds the same video from two sites into one title', () => {
        const merged = mergeTube([[t('rt', 'Same Video', 600)], [t('ep', 'Same Video', 602)]]);
        expect(merged).toHaveLength(1);
        expect(merged[0].alsoOn).toEqual([{ site: 'ep', siteId: 'Same Video', siteName: 'ep' }]);
    });

    it('keeps same-named videos of different lengths apart', () => {
        expect(mergeTube([[t('rt', 'Compilation', 600)], [t('ep', 'Compilation', 1200)]])).toHaveLength(2);
    });
});

describe('RedTube titles', () => {
    const redtube = require('../stremio-adult-addon/src/inc/sources/redtube');

    it('skips broken thumbnail URLs and falls back to a good snapshot', () => {
        const t = redtube.toTitle({
            video_id: '1', title: 'X', duration: '10:00',
            default_thumb: 'https://ei-ph.rdtcdn.com/videos//original/(m=e0YH8f)0.jpg',
            thumbs: [
                { src: 'https://ei-ph.rdtcdn.com/videos//original/1.jpg' },
                { src: 'https://ei-ph.rdtcdn.com/videos/202210/02/416730851/original/2.jpg' },
            ],
        });
        expect(t.thumbnail).toBe('https://ei-ph.rdtcdn.com/videos/202210/02/416730851/original/2.jpg');
        expect(t.snapshots).toHaveLength(1);
        expect(t.duration).toBe(600);
    });
});

describe('play relay', () => {
    it('round-trips a play token', () => {
        expect(relay.parsePlayToken(relay.makePlayToken('rt', '193552611', 1080))).toEqual({ s: 'rt', id: '193552611', q: 1080 });
        expect(relay.parsePlayToken('not-a-token')).toBe(null);
        expect(relay.parsePlayToken(Buffer.from('{"s":"xx","id":"1"}').toString('base64'))).toBe(null);
    });

    it('picks the asked quality, else the best below it, else the best', () => {
        const list = [{ quality: 1080 }, { quality: 720 }, { quality: 480 }];
        expect(relay.pickStream(list, 720).quality).toBe(720);
        expect(relay.pickStream(list, 900).quality).toBe(720);
        expect(relay.pickStream(list, 240).quality).toBe(1080);
        expect(relay.pickStream(list, 0).quality).toBe(1080);
    });

    it('encodes the Eporner page hash the way the site player does', () => {
        expect(eporner.encodeHash('3dbfab1705c622c9fe70c5f87b02303a'))
            .toBe([0, 8, 16, 24].map((i) => parseInt('3dbfab1705c622c9fe70c5f87b02303a'.slice(i, i + 8), 16).toString(36)).join(''));
    });

    it('routes only the unreliable image hosts through the addon', () => {
        expect(imageUrl('https://static-ca-cdn.eporner.com/thumbs/1.jpg')).toMatch(/^\/inc\/img\?u=/);
        expect(imageUrl('https://ei-ph.rdtcdn.com/videos/1.jpg')).toBe('https://ei-ph.rdtcdn.com/videos/1.jpg');
        expect(imageUrl('javascript:alert(1)')).toBe('');
    });
});

describe('favorites', () => {
    it('adds, snapshots and removes a title', () => {
        favorites.apply({ op: 'add', type: 'title', value: { id: 'inc:tube:rt:1', name: 'A', className: 'x', thumbnail: 't.jpg' } });
        const fav = favorites.get();
        expect(fav.titles[0].id).toBe('inc:tube:rt:1');
        expect(fav.titles[0].snapshot).toEqual({ id: 'inc:tube:rt:1', name: 'A', thumbnail: 't.jpg' });
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'favorites.json'), 'utf8')).titles).toHaveLength(1);
        favorites.apply({ op: 'remove', type: 'title', value: 'inc:tube:rt:1' });
        expect(favorites.get().titles).toHaveLength(0);
    });

    it('adds performers once (case-insensitive) and reorders them', () => {
        favorites.apply({ op: 'add', type: 'performer', value: 'Maya Woulfe' });
        favorites.apply({ op: 'add', type: 'performer', value: 'maya woulfe' });
        favorites.apply({ op: 'add', type: 'performer', value: 'Angela White' });
        expect(favorites.get().performers.map((p) => p.name)).toEqual(['maya woulfe', 'Angela White']);
        favorites.apply({ op: 'move', type: 'performer', value: 'Angela White', to: 0 });
        expect(favorites.get().performers.map((p) => p.name)).toEqual(['Angela White', 'maya woulfe']);
    });
});

describe('Stremio-shaped streams', () => {
    const streamsOut = require('../stremio-adult-addon/src/inc/streams');
    const { releaseQueries } = require('../stremio-adult-addon/src/inc/catalog');
    const autoPick = require('../src/common/autoPick');

    const release = {
        key: 'h:abc', name: 'MomsTight.24.02.22.Briana.Banderas.My.Stepmom.XXX.1080p.HEVC',
        infoHash: 'a'.repeat(40), seeders: 92, size: 376 * 1024 * 1024, quality: '1080p', indexer: 'Knaben', liveChecked: true,
    };

    it('offers each release as an RD stream and a P2P stream, best seeded first', () => {
        const rdCached = new Map([['a'.repeat(40), true], ['b'.repeat(40), true]]);
        const out = streamsOut.fromReleases([{ ...release, key: 'h:low', infoHash: 'b'.repeat(40), seeders: 3 }, release], { rdCached });
        expect(out.map((s) => s.name)).toEqual([
            '[RD+] Incognito\n1080p', 'Incognito P2P\n1080p',
            '[RD+] Incognito\n1080p', 'Incognito P2P\n1080p',
        ]);
        expect(out[0].url).toMatch(/^\/inc\/rd\//);
        expect(out[1].infoHash).toBe('a'.repeat(40));
        expect(out[1].sources).toContain(`dht:${'a'.repeat(40)}`);
        expect(out[1].sources.some((s) => s.startsWith('tracker:'))).toBe(true);
        expect(out[0].source).toBe('torrents');
    });

    it('describes streams the way auto-pick reads them (seeders, quality, RD bucket)', () => {
        const [rd, p2p] = streamsOut.fromReleases([release], { rdCached: new Map([['a'.repeat(40), true]]) });
        expect(autoPick.detectQuality(rd)).toBe('1080p');
        expect(rd.description).toContain('👤 92');
        expect(autoPick.streamSourceKeys(rd)).toContain('rd_plus');
        expect(autoPick.streamSourceKeys(p2p)).not.toContain('rd_plus');
    });

    it('puts Incognito P2P streams in auto-pick’s main P2P bucket (on by default)', () => {
        const p2p = { name: 'Incognito P2P\n1080p', description: 'x\n👤 40', incognitoP2P: true, addonName: 'Torrents' };
        expect(autoPick.streamSourceKeys(p2p)).toContain('torrentio');
        expect(autoPick.streamSourceKeys({ ...p2p, incognitoP2P: undefined })).toEqual(['other']);
        const torrentio = autoPick.getDefaultAutoPickSettings().sources.find((s) => s.key === 'torrentio');
        expect(torrentio.enabled).toBe(true);
    });

    it('ranks live-checked releases above stale listed counts', () => {
        const stale = { ...release, key: 'h:stale', infoHash: 'd'.repeat(40), seeders: 428, liveChecked: false };
        const out = streamsOut.fromReleases([stale, release]);
        expect(out.map((s) => s.infoHash)).toEqual(['a'.repeat(40), 'd'.repeat(40)]);
        expect(out[1].description).toContain('~428 listed');
    });

    it('round-trips the signed RD token and rejects junk or tampering', () => {
        const token = streamsOut.makeRdToken(release);
        expect(streamsOut.parseRdToken(token).h).toBe(release.infoHash);
        expect(streamsOut.parseRdToken('junk')).toBe(null);
        // Someone else's infoHash with the old signature: refused.
        const forged = Buffer.from(JSON.stringify({ h: 'c'.repeat(40), n: 'x' })).toString('base64')
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        expect(streamsOut.parseRdToken(`${forged}.${token.split('.')[1]}`)).toBe(null);
        expect(streamsOut.parseRdToken(token.split('.')[0])).toBe(null);
    });

    it('offers RD only for releases Real-Debrid has cached', () => {
        expect(streamsOut.fromReleases([release]).map((s) => s.name)).toEqual(['Incognito P2P\n1080p']);
        const out = streamsOut.fromReleases([release], { rdCached: new Map([['a'.repeat(40), false]]) });
        expect(out.map((s) => s.name)).toEqual(['Incognito P2P\n1080p']);
    });

    it('does not attach another scene a studio released the same day', () => {
        const scene = {
            id: 'inc:scene:x', tpdbId: 'x', kind: 'scene', name: 'Sneaky Shower Threesome', date: '2020-04-29',
            studio: 'Brazzers Exxtra', performers: ['Siri', 'Angela White'],
        };
        expect(scenes.releaseMatches(scene, { name: 'BrazzersExxtra 20 04 29 Siri And Angela White Sneaky Shower Threesome -XXX' })).toBe(true);
        expect(scenes.releaseMatches(scene, { name: 'BrazzersExxtra 20 04 29 Luna Star All Dolled Up Anal Edition -XXX' })).toBe(false);
        expect(scenes.releaseMatches(scene, { name: 'BrazzersExxtra 20 04 30 Angela White Sneaky Shower Threesome' })).toBe(false);
    });

    it('needs a performer for an undated release of a short title', () => {
        const scene = { id: 'inc:scene:y', tpdbId: 'y', kind: 'scene', name: 'Stay on the Line', date: '2021-01-01', performers: ['Abella Danger'] };
        expect(scenes.releaseMatches(scene, { name: 'Abella Danger Stay On The Line XXX 1080p' })).toBe(true);
        expect(scenes.releaseMatches(scene, { name: 'Stay On The Line Compilation XXX' })).toBe(false);
    });

    it('rejects undated releases when the title is only the performer and filler', () => {
        // "Best of ZZ - Abella Danger" has no words of its own to check.
        const scene = { id: 'inc:scene:z', tpdbId: 'z', kind: 'scene', name: 'Best of ZZ - Abella Danger', date: '2021-01-01', performers: ['Abella Danger'] };
        expect(scenes.releaseMatches(scene, { name: 'Abella Danger Anal Compilation XXX' })).toBe(false);
    });

    it('sends releases without an infoHash to the torrent screen', () => {
        const [s] = streamsOut.fromReleases([{ key: 'm:1', name: 'X 720p', seeders: 1, href: '#/torrent/abc' }]);
        expect(s.externalHref).toBe('#/torrent/abc');
        expect(s.url).toBeUndefined();
    });

    it('searches a scene by "<Studio> yy mm dd", the performers, and lead + title', () => {
        expect(releaseQueries({
            kind: 'scene', name: 'Off to College', date: '2023-01-07', studioShort: 'freeusefantasy',
            performers: ['Jordan Maxx', 'Maya Woulfe'],
        })).toEqual(['freeusefantasy 23 01 07', 'Jordan Maxx Maya Woulfe', 'Jordan Maxx Off to College']);
    });

    it('matches movie (DVD) releases by most of the title words', () => {
        const movie = { kind: 'movie', id: 'inc:movie:x', name: 'My Friend’s Hot Mom Vol. 104' };
        expect(scenes.releaseMatches(movie, { name: 'My Friends Hot Mom 104 XXX DVDRip' })).toBe(true);
        expect(scenes.releaseMatches(movie, { name: 'My Sisters Hot Friend 9 XXX' })).toBe(false);
    });

    it('leaves clip stores out of "new scenes"', () => {
        expect(tpdb.isClipSite({ site: { name: 'I Want Clips: Somebody', network: { name: 'I Want Clips' } } })).toBe(true);
        expect(tpdb.isClipSite({ site: { name: 'Brazzers Exxtra', network: { name: 'MindGeek (Aylo)' } } })).toBe(false);
    });
});

describe('incognito routes', () => {
    it('matches the title and row subpages', () => {
        expect('/incognito/title/inc%3Atube%3Art%3A1'.match(routesRegexp.incognito.regexp).slice(1)).toEqual(['title', 'inc%3Atube%3Art%3A1']);
        expect('/incognito/row/perf%3AMaya%20Woulfe'.match(routesRegexp.incognito.regexp).slice(1)).toEqual(['row', 'perf%3AMaya%20Woulfe']);
    });
});
