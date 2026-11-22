// RedTube — public JSON API (no key) for catalog rows; the video page's
// `mediaDefinitions` for direct file URLs.
//
// Verified 2026-11-21: the mp4 definition points at a JSON list of
// per-quality files (up to 1080p). The file host (rdtcdn.com) is reachable
// every time, but answers 410 Gone without the page as Referer. URLs carry a
// 2-hour validity window.

const net = require('../net');
const { imageUrl, cleanName, clockToSeconds, qualityNumber } = require('../titles');

const SITE = 'rt';
const API = 'https://api.redtube.com/';
const PAGE = 'https://www.redtube.net/';

const SORTS = {
    trending: { ordering: 'mostviewed', period: 'weekly' },
    latest: { ordering: 'newest' },
    top: { ordering: 'rating', period: 'monthly' },
    popular: { ordering: 'mostviewed', period: 'alltime' },
    month: { ordering: 'mostviewed', period: 'monthly' },
};

// Some API entries carry thumbnail URLs with an empty path segment
// (".../videos//original/...jpg"), which the CDN answers with a tiny HTML
// page. Skip those and fall back to the next snapshot.
const goodThumb = (url) => typeof url === 'string' && /^https?:\/\//.test(url) && !/\/videos\/\//.test(url);

function toTitle(v) {
    if (!v || !v.video_id) return null;
    const thumbs = (Array.isArray(v.thumbs) ? v.thumbs : []).filter((t) => t && goodThumb(t.src));
    return {
        id: `inc:tube:${SITE}:${v.video_id}`,
        kind: 'tube',
        site: SITE,
        siteId: String(v.video_id),
        siteName: 'RedTube',
        name: cleanName(v.title),
        thumbnail: imageUrl([v.default_thumb, v.thumb, thumbs[0] && thumbs[0].src].find(goodThumb) || ''),
        snapshots: thumbs.map((t) => imageUrl(t && t.src)).filter(Boolean),
        duration: clockToSeconds(v.duration),
        views: Number(v.views) || 0,
        // RedTube rates 0-100; normalise to 0-5 like Eporner.
        rating: Number(v.rating) ? Math.round(Number(v.rating) / 2) / 10 : 0,
        date: typeof v.publish_date === 'string' ? v.publish_date.slice(0, 10) : '',
        performers: [],
        tags: (v.tags || []).map((t) => cleanName(t && t.tag_name)).filter(Boolean).slice(0, 12),
        pageUrl: `${PAGE}${v.video_id}`,
    };
}

async function list({ sort = 'trending', query = '', tag = '', page = 1 } = {}) {
    const params = new URLSearchParams({
        data: 'redtube.Videos.searchVideos',
        output: 'json',
        thumbsize: 'big',
        page: String(page),
        ...(SORTS[sort] || SORTS.trending),
    });
    if (query) params.set('search', query);
    if (tag) params.append('tags[]', tag);
    const data = await net.fetchJson(`${API}?${params}`);
    return (data.videos || []).map((x) => toTitle(x && x.video)).filter(Boolean);
}

async function search(query, page = 1) {
    return list({ sort: 'popular', query, page });
}

async function get(siteId) {
    const params = new URLSearchParams({
        data: 'redtube.Videos.getVideoById',
        video_id: siteId,
        output: 'json',
        thumbsize: 'big',
    });
    const data = await net.fetchJson(`${API}?${params}`);
    return toTitle(data && data.video);
}

/** → [{ quality, label, url, headers }] best first */
async function directStreams(siteId) {
    const pageUrl = `${PAGE}${encodeURIComponent(siteId)}`;
    const page = await net.fetchText(pageUrl);
    if (page.status !== 200) throw new Error(`redtube page HTTP ${page.status}`);
    const m = page.body.match(/mediaDefinitions["']?\s*:\s*(\[.*?\])\s*,\s*["']?[a-zA-Z]/s);
    if (!m) throw new Error('redtube page: mediaDefinitions not found');
    let defs;
    try { defs = JSON.parse(m[1]); } catch { throw new Error('redtube page: mediaDefinitions unreadable'); }
    const mp4 = defs.find((d) => d && d.format === 'mp4' && d.videoUrl);
    if (!mp4) throw new Error('redtube page: no mp4 definition');
    const referer = page.finalUrl || pageUrl;
    const cookies = [].concat(page.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    const list = await net.fetchJson(new URL(String(mp4.videoUrl).replace(/\\\//g, '/'), referer).href, {
        headers: { Referer: referer, ...(cookies ? { Cookie: cookies } : {}) },
    });
    return (Array.isArray(list) ? list : [])
        .map((x) => ({
            quality: qualityNumber(x && x.quality),
            label: `${qualityNumber(x && x.quality)}p`,
            url: x && x.videoUrl,
            headers: { Referer: referer },
        }))
        .filter((s) => s.quality && typeof s.url === 'string' && /^https?:\/\//.test(s.url))
        .sort((a, b) => b.quality - a.quality);
}

async function tags() {
    try {
        const data = await net.fetchJson(`${API}?data=redtube.Tags.getTagList&output=json`);
        return (data.tags || []).map((t) => cleanName(t && t.tag && t.tag.tag_name)).filter(Boolean);
    } catch {
        return [];
    }
}

module.exports = { SITE, name: 'RedTube', list, search, get, directStreams, tags, toTitle };
