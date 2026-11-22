// Porntrex as a full-length tube source: card parsing, how sure a clearnet
// copy is to be the studio scene, and when auto-pick may play direct files.

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-tube-'));
process.env.INCOGNITO_DATA_DIR = dataDir;
process.env.INCOGNITO_TPDB_TOKEN_FILE = path.join(dataDir, 'no-token.txt');

const porntrex = require('../stremio-adult-addon/src/inc/sources/porntrex');
const { copyConfidence } = require('../stremio-adult-addon/src/inc/catalog');
const streamsOut = require('../stremio-adult-addon/src/inc/streams');
const autoPick = require('../src/common/autoPick');

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

// The shape of one result card (synthetic text, real structure).
const card = (id, slug, title, duration, quality) => `
<div class="video-preview-screen video-item thumb-item " data-item-id="${id}">
<a href="https://www.porntrex.com/video/${id}/${slug}" class="thumb rotator-screen" >
<img class="cover lazyload"data-src="//ptx.cdntrex.com/contents/videos_screenshots/${id}/300x168/1.jpg?v=3" alt="${title}" />
<ul class="screenshots-list"><li class="screenshot-item active" data-src="//ptx.cdntrex.com/s/${id}/1.jpg"></li><li class="screenshot-item " data-src="//ptx.cdntrex.com/s/${id}/2.jpg"></li></ul></a>
<div class="hd-text-icon text video-item-submitted"><span class="quality">${quality}</span> <span class="hd-icon">HD</span></div>
<div class="durations"><i class="fa fa-clock-o"></i> ${duration}</div>
<p class="inf"><a href="https://www.porntrex.com/video/${id}/${slug}" title="${title}" >${title}</a></p></div>`;

describe('Porntrex cards', () => {
    it('reads id+slug, title, duration, quality and https thumbnails', () => {
        const [t] = porntrex.parseCards(`<div>${card(1408403, 'performer-a-some-scene', 'Performer A - Some Scene &amp; More', '34:59', '720p')}</div>`);
        expect(t).toMatchObject({
            id: 'inc:tube:pt:1408403/performer-a-some-scene', site: 'pt', siteId: '1408403/performer-a-some-scene',
            name: 'Performer A - Some Scene & More', duration: 2099, quality: 720, kind: 'tube', siteName: 'Porntrex',
        });
        expect(t.thumbnail).toMatch(/^https:\/\/ptx\.cdntrex\.com\//);
        expect(t.snapshots).toHaveLength(2);
    });
    it('reads several cards and longer clocks', () => {
        const out = porntrex.parseCards(card(1, 'a', 'A', '1:02:33', '1080p') + card(2, 'b', 'B', '9:59', '480p'));
        expect(out.map((t) => [t.siteId, t.duration, t.quality])).toEqual([['1/a', 3753, 1080], ['2/b', 599, 480]]);
    });
});

describe('clearnet copy confidence', () => {
    const scene = { name: 'No Boundaries Broken For Jenna', studio: 'Hard X', performers: ['Jenna Foxx'], duration: 35 * 60 };
    it('is strong with the lead, most title words and a close length', () => {
        expect(copyConfidence(scene, { name: 'Jenna Foxx - No Boundaries Broken For Jenna 2', duration: 34 * 60 + 59 })).toBe('strong');
    });
    it('is weak with only lead + studio, and only within a minute of the length', () => {
        const generic = { name: 'Case No. 7862669', studio: 'Shoplyfter', performers: ['Jenna Foxx'], duration: 50 * 60 + 14 };
        expect(copyConfidence(generic, { name: 'Shoplyfter - Jenna Foxx full scene', duration: 50 * 60 })).toBe('weak');
        expect(copyConfidence(generic, { name: 'Shoplyfter - Jenna Foxx', duration: 45 * 60 })).toBeNull();
    });
    it('is nothing without the lead performer, or with a very different length', () => {
        expect(copyConfidence(scene, { name: 'No Boundaries Broken For Jenna', duration: 35 * 60 })).toBeNull();
        expect(copyConfidence(scene, { name: 'Jenna Foxx - No Boundaries Broken For Jenna', duration: 8 * 60 })).toBeNull();
    });
});

describe('auto-pick and direct files', () => {
    const files = [{ quality: 1080, label: '1080p' }, { quality: 720, label: '720p' }];
    const tok = (s, id, q) => `${s}-${id}-${q}`;
    const asPage = (streams) => streams.map((s) => ({ ...s, incognitoDirect: s.source === 'clearnet' && s.autoPick === true, deepLinks: { player: `#/player/${s.url}` } }));
    it('plays a video\'s own files (marked auto-pickable), best quality first', () => {
        const streams = asPage(streamsOut.fromDirect('pt', 'Porntrex', '1/a', files, tok, { autoPick: true }));
        const [first] = autoPick.getAutoPickCandidates(streams, autoPick.getDefaultAutoPickSettings());
        expect(first.name).toBe('Porntrex\n1080p');
    });
    it('leaves weak clearnet matches to the user', () => {
        const streams = asPage(streamsOut.fromDirect('pt', 'Porntrex', '1/a', files, tok, { label: 'Some upload', autoPick: false }));
        expect(autoPick.getAutoPickCandidates(streams, autoPick.getDefaultAutoPickSettings())).toEqual([]);
        expect(streams[0].description).toContain('Some upload');
    });
});
