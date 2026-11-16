// Crowd-sourced intro/recap/credits timestamps. Two public databases are
// asked; both are keyed by IMDb id + season + episode. Their answers are only
// ever evidence: a timestamp can belong to a different cut of the episode, so
// fusion.js decides how far to trust them.

const THEINTRODB_URL = 'https://api.theintrodb.org/v4/media';
const INTRODB_URL = 'https://api.introdb.app/segments';
const TIMEOUT_MS = 8000;
// TheIntroDB groups submissions by file length; a group this close to the
// played file's length is taken to be the same cut.
const SAME_CUT_SECONDS = 5;

// Stremio series video ids look like "tt0903747:1:2".
function parseVideoId(videoId) {
    const match = typeof videoId === 'string' ? videoId.match(/^(tt\d{7,8}):(\d+):(\d+)$/) : null;
    return match ? { imdbId: match[1], season: Number(match[2]), episode: Number(match[3]) } : null;
}

async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function segment(type, start, end, votes, source, sameCut) {
    return Number.isFinite(start) && Number.isFinite(end) && end - start >= 5
        ? [{ type, start, end, votes: votes || 1, source, sameCut }]
        : [];
}

function parseTheIntroDb(body, durationSec) {
    if (!body || typeof body !== 'object') return [];
    const group = Number(body.group_duration_ms) / 1000;
    const sameCut = Number.isFinite(group) && group > 0 && Number.isFinite(durationSec)
        ? Math.abs(group - durationSec) <= SAME_CUT_SECONDS
        : null;
    const out = [];
    for (const type of ['intro', 'recap', 'credits', 'preview']) {
        const entry = Array.isArray(body[type]) ? body[type][0] : null;
        if (!entry) continue;
        // A missing start means "from the beginning" for intro/recap; a missing
        // end means "to the end of the file" for credits/preview.
        const opensFile = type === 'intro' || type === 'recap';
        const start = entry.start_ms === null || entry.start_ms === undefined ? (opensFile ? 0 : NaN) : entry.start_ms / 1000;
        const end = entry.end_ms === null || entry.end_ms === undefined ? (opensFile ? NaN : durationSec) : entry.end_ms / 1000;
        out.push(...segment(type, start, end, entry.submission_count, 'theintrodb', sameCut));
    }
    return out;
}

function parseIntroDb(body) {
    if (!body || typeof body !== 'object') return [];
    const out = [];
    const types = { intro: 'intro', recap: 'recap', outro: 'credits' };
    for (const key of Object.keys(types)) {
        const entry = body[key];
        if (!entry) continue;
        out.push(...segment(types[key], entry.start_ms / 1000, entry.end_ms / 1000, entry.submission_count, 'introdb', null));
    }
    return out;
}

/**
 * @param {{ videoId: string, durationSec: number }} episode
 * @param {(url: string) => string} [proxy] - wraps a URL so it can be fetched
 *   despite the database not allowing this origin. IntroDB needs it; without
 *   one it is skipped.
 * @returns {Promise<{ segments: Array }>} empty for ids the databases cannot know.
 */
async function lookupDatabases(episode, proxy) {
    const ids = parseVideoId(episode.videoId);
    if (!ids) return { segments: [] };
    const query = `imdb_id=${ids.imdbId}&season=${ids.season}&episode=${ids.episode}`;
    const duration = Number.isFinite(episode.durationSec) ? `&duration_ms=${Math.round(episode.durationSec * 1000)}` : '';
    const [theIntroDb, introDb] = await Promise.all([
        fetchJson(`${THEINTRODB_URL}?${query}&details=true${duration}`),
        proxy ? fetchJson(proxy(`${INTRODB_URL}?${query}`)) : null,
    ]);
    return { segments: [...parseTheIntroDb(theIntroDb, episode.durationSec), ...parseIntroDb(introDb)] };
}

module.exports = {
    parseVideoId,
    parseTheIntroDb,
    parseIntroDb,
    lookupDatabases,
};
