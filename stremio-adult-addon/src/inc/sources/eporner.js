// Eporner — public JSON API (no key) for catalog rows; the site's own player
// flow (page hash → /xhr/video/<id>) for direct file URLs.
//
// Verified 2026-11-21: API returns title, keywords, duration, views, rating
// and 15 snapshots per video; the xhr returns per-quality MP4 URLs that play
// without a Referer. File URLs are signed and expire, so they are resolved at
// play time and never cached for long.

const net = require('../net');
const { imageUrl, cleanName, qualityNumber } = require('../titles');

const SITE = 'ep';
const API = 'https://www.eporner.com/api/v2/video';
const PAGE = 'https://www.eporner.com/video-';

const SORTS = {
    trending: 'top-weekly',
    latest: 'latest',
    top: 'top-rated',
    popular: 'most-popular',
    month: 'top-monthly',
};

// Eporner categories that exist as keywords; used for the category picker.
const TAGS = [
    'Amateur', 'Anal', 'Asian', 'BBW', 'Big Ass', 'Big Tits', 'Blonde', 'Blowjob',
    'Brunette', 'Creampie', 'Cumshot', 'Ebony', 'Fetish', 'Hardcore', 'Interracial',
    'Japanese', 'Latina', 'Lesbian', 'Massage', 'Mature', 'MILF', 'POV', 'Petite',
    'Redhead', 'Solo', 'Squirt', 'Teen', 'Threesome', 'Vintage', 'Webcam',
];

function toTitle(v) {
    if (!v || !v.id) return null;
    const keywords = String(v.keywords || '').split(',').map((k) => k.trim()).filter(Boolean);
    const name = cleanName(v.title);
    // The last keyword is usually the title itself; drop anything that is.
    const tags = keywords.filter((k) => k.toLowerCase() !== name.toLowerCase()).slice(0, 12);
    return {
        id: `inc:tube:${SITE}:${v.id}`,
        kind: 'tube',
        site: SITE,
        siteId: String(v.id),
        siteName: 'Eporner',
        name,
        thumbnail: imageUrl(v.default_thumb && v.default_thumb.src),
        snapshots: (v.thumbs || []).map((t) => imageUrl(t && t.src)).filter(Boolean),
        duration: Number(v.length_sec) || 0,
        views: Number(v.views) || 0,
        rating: Number(v.rate) || 0,
        date: typeof v.added === 'string' ? v.added.slice(0, 10) : '',
        performers: [],
        tags,
        pageUrl: v.url || `${PAGE}${v.id}/`,
    };
}

async function list({ sort = 'trending', query = '', page = 1, perPage = 40 } = {}) {
    const params = new URLSearchParams({
        query: query || 'all',
        per_page: String(perPage),
        page: String(page),
        thumbsize: 'big',
        order: SORTS[sort] || SORTS.trending,
        gay: '0',
        lq: '0',
        format: 'json',
    });
    const data = await net.fetchJson(`${API}/search/?${params}`);
    return (data.videos || []).map(toTitle).filter(Boolean);
}

async function search(query, page = 1) {
    return list({ sort: 'popular', query, page });
}

async function get(siteId) {
    const params = new URLSearchParams({ id: siteId, thumbsize: 'big', format: 'json' });
    const data = await net.fetchJson(`${API}/id/?${params}`);
    // The id endpoint returns the video object itself (or [] when unknown).
    return Array.isArray(data) ? null : toTitle(data);
}

// The site's own player hashes the 32-hex page hash in four 8-char chunks,
// each rewritten in base 36.
function encodeHash(hash) {
    return [0, 8, 16, 24].map((i) => parseInt(hash.slice(i, i + 8), 16).toString(36)).join('');
}

/** → [{ quality: 720, label: '720p', url, headers: {} }] best first */
async function directStreams(siteId) {
    const page = await net.fetchText(`${PAGE}${encodeURIComponent(siteId)}/`);
    if (page.status !== 200) throw new Error(`eporner page HTTP ${page.status}`);
    const vid = (page.body.match(/vid\s*=\s*'([^']+)'/) || [])[1];
    const hash = (page.body.match(/hash\s*=\s*'([a-f0-9]{32})'/) || [])[1];
    if (!vid || !hash) throw new Error('eporner page: player data not found');
    const params = new URLSearchParams({
        hash: encodeHash(hash),
        domain: 'www.eporner.com',
        fallback: 'false',
        embed: 'false',
        supportedFormats: 'dash,mp4',
    });
    const data = await net.fetchJson(`https://www.eporner.com/xhr/video/${encodeURIComponent(vid)}?${params}`, {
        headers: { Referer: page.finalUrl || `${PAGE}${siteId}/` },
    });
    const mp4 = (data && data.sources && data.sources.mp4) || {};
    return Object.entries(mp4)
        .map(([label, v]) => ({
            quality: qualityNumber(label),
            label: `${qualityNumber(label) || label}p`.replace(/pp$/, 'p'),
            url: v && v.src,
            headers: {},
        }))
        .filter((s) => typeof s.url === 'string' && /^https?:\/\//.test(s.url))
        .sort((a, b) => b.quality - a.quality);
}

module.exports = { SITE, name: 'Eporner', TAGS, list, search, get, directStreams, toTitle, encodeHash };
