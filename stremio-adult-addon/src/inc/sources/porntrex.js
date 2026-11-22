// Porntrex — full-length studio scenes (30–50 min, up to 1080p/4K), from
// the site's search page and each video page's player config.
//
// Verified 2026-11-22:
//   - search: https://www.porntrex.com/search/<words-with-dashes>/ lists
//     cards with title, duration, quality label and thumbnail;
//   - a video page needs its id and slug (/video/<id>/<slug>; the id alone
//     is a 404), so siteId is "<id>/<slug>";
//   - the page's `flashvars` carry plain file URLs (video_url, video_alt_url,
//     video_alt_url2…) with labels ("480p", "720p HD", "1080p"…). The links
//     go through porntrex.com/get_file/ and need the page as Referer.
//   - reachable from this PC (no ISP resets seen on porntrex.com).

const net = require('../net');
const { cleanName, clockToSeconds, qualityNumber } = require('../titles');

const SITE = 'pt';
const NAME = 'Porntrex';
const BASE = 'https://www.porntrex.com';

const absUrl = (u) => (typeof u === 'string' && u.startsWith('//') ? `https:${u}` : u || '');
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#039;|&#39;/g, '\'').replace(/&quot;/g, '"');

/** Result cards on a search/listing page → titles. */
function parseCards(html) {
    const out = [];
    const parts = String(html || '').split(/<div class="video-preview-screen video-item[^"]*"/).slice(1);
    for (const part of parts) {
        const link = part.match(/href="https:\/\/www\.porntrex\.com\/video\/(\d+)\/([a-z0-9-]+)"/i);
        if (!link) continue;
        const title = (part.match(/<p class="inf"><a [^>]*title="([^"]+)"/) || part.match(/alt="([^"]+)"/) || [])[1];
        const thumb = (part.match(/data-src="([^"]+\/1\.jpg[^"]*)"/) || part.match(/data-src="([^"]+)"/) || [])[1];
        const shots = [...part.matchAll(/class="screenshot-item[^"]*" data-src="([^"]+)"/g)].map((m) => absUrl(m[1]));
        const duration = clockToSeconds((part.match(/<div class="durations">[\s\S]*?([\d:]{4,8})\s*<\/div>/) || [])[1]);
        const quality = qualityNumber((part.match(/<span class="quality">([^<]+)<\/span>/) || [])[1]);
        const siteId = `${link[1]}/${link[2]}`;
        out.push({
            id: `inc:tube:${SITE}:${siteId}`,
            kind: 'tube',
            site: SITE,
            siteId,
            siteName: NAME,
            name: cleanName(decode(title)),
            thumbnail: absUrl(thumb),
            snapshots: shots.length ? shots : [absUrl(thumb)].filter(Boolean),
            duration,
            quality,
            views: 0,
            rating: 0,
            date: '',
            performers: [],
            tags: [],
            pageUrl: `${BASE}/video/${siteId}`,
        });
    }
    return out.filter((t) => t.name);
}

async function search(query, page = 1) {
    const words = String(query || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!words) return [];
    const url = `${BASE}/search/${words}/${page > 1 ? `${page}/` : ''}`;
    const r = await net.fetchText(url);
    if (r.status !== 200) throw new Error(`porntrex search HTTP ${r.status}`);
    return parseCards(r.body);
}

async function list({ query = '', page = 1 } = {}) {
    return query ? search(query, page) : [];
}

async function videoPage(siteId) {
    if (!/^\d+\/[a-z0-9-]+$/i.test(siteId)) throw new Error('porntrex: bad id');
    const url = `${BASE}/video/${siteId}`;
    const r = await net.fetchText(url);
    if (r.status !== 200) throw new Error(`porntrex page HTTP ${r.status}`);
    return { url: r.finalUrl || url, html: r.body };
}

function flashvars(html) {
    const m = String(html).match(/var flashvars = \{([\s\S]*?)\};/);
    const out = {};
    if (m) for (const f of m[1].matchAll(/(\w+):\s*'([^']*)'/g)) out[f[1]] = f[2];
    return out;
}

async function get(siteId) {
    const { html } = await videoPage(siteId);
    const fv = flashvars(html);
    const title = fv.video_title || (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
    const [, id] = siteId.match(/^(\d+)\//) || [];
    const thumb = absUrl(fv.preview_url || '');
    return {
        id: `inc:tube:${SITE}:${siteId}`,
        kind: 'tube',
        site: SITE,
        siteId,
        siteName: NAME,
        name: cleanName(decode(title)),
        thumbnail: thumb,
        snapshots: thumb ? [thumb] : [],
        duration: Number(fv.duration) || clockToSeconds((html.match(/"duration":\s*"PT(\d+)M(\d+)S"/) || []).slice(1, 3).join(':')),
        views: 0,
        rating: 0,
        date: '',
        performers: [],
        tags: [],
        pageUrl: `${BASE}/video/${siteId}`,
        tpxId: id,
    };
}

/** → [{ quality, label, url, headers }] best first */
async function directStreams(siteId) {
    const { url: pageUrl, html } = await videoPage(siteId);
    const fv = flashvars(html);
    const out = [];
    for (const [k, v] of Object.entries(fv)) {
        if (!/^video_(alt_)?url\d*$/.test(k) || !/^https?:\/\//.test(v)) continue;
        const label = fv[`${k}_text`] || '';
        const quality = qualityNumber(label) || qualityNumber(v) || 480;
        out.push({ quality, label: `${quality}p`, url: v, headers: { Referer: pageUrl } });
    }
    return out.sort((a, b) => b.quality - a.quality);
}

module.exports = { SITE, name: NAME, list, search, get, directStreams, parseCards };
