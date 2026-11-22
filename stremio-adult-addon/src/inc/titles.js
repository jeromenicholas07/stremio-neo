// Shared helpers for catalog titles.
//
// A title is the unit the UI shows as a card. Two kinds:
//   tube  — a video hosted by a tube site; plays from the site's own files.
//   scene — a studio scene built from torrent releases; plays via RD / P2P.
//
// Shape (what /inc/* endpoints return):
//   { id, kind, site?, name, thumbnail, snapshots[], duration, views, rating,
//     performers[], tags[], studio, date, description, releases? }

// Hosts the UI can't load reliably (ISP resets ~half the connects) or that
// we'd rather keep off the page. Their images go through /inc/img.
const PROXY_IMAGE_HOSTS = [/(^|\.)eporner\.com$/i];

function imageUrl(url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return '';
    let host = '';
    try { host = new URL(url).hostname; } catch { return ''; }
    if (PROXY_IMAGE_HOSTS.some((re) => re.test(host))) {
        // Relative: the UI resolves it against the addon URL it is using.
        return '/inc/img?u=' + encodeURIComponent(url);
    }
    return url;
}

function decodeEntities(s) {
    return String(s || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function cleanName(s) {
    return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

// "17:34" or "1:02:03" → seconds.
function clockToSeconds(s) {
    if (typeof s === 'number') return s;
    const parts = String(s || '').split(':').map((p) => parseInt(p, 10));
    if (parts.some((p) => !Number.isFinite(p))) return 0;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function qualityNumber(label) {
    const m = String(label || '').match(/(\d{3,4})/);
    return m ? parseInt(m[1], 10) : 0;
}

function base64UrlEncode(str) {
    return Buffer.from(String(str), 'utf8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

module.exports = {
    imageUrl, cleanName, decodeEntities, clockToSeconds, qualityNumber,
    base64UrlEncode, base64UrlDecode,
};
