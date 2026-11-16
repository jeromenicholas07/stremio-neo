// Picks the other episodes to compare against and a stream to read each from.
// Any release works as a comparison: only where the shared audio sits in the
// file being played is used, so the smallest stream is the cheapest choice.
// The exception is the episode that will play next, where the release the
// player is likely to pick is read, so its result is ready when it starts.

const TIMEOUT_MS = 15000;
const MIN_BYTES = 30 * 1024 * 1024; // below this it is a sample or an error clip

function sizeOf(stream) {
    const hints = stream.behaviorHints || {};
    if (Number.isFinite(hints.videoSize) && hints.videoSize > 0) return hints.videoSize;
    const text = `${stream.title || ''} ${stream.description || ''}`;
    const match = text.match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b/i);
    if (!match) return null;
    const unit = { TB: 1024 ** 4, GB: 1024 ** 3, MB: 1024 ** 2 }[match[2].toUpperCase()];
    return Math.round(Number(match[1]) * unit);
}

// Identifies a file across sessions, for both core's stream objects and the
// raw ones an addon returns.
function fileKeyOf(stream) {
    const hints = stream.behaviorHints || {};
    let name = hints.filename;
    if (!name && typeof stream.url === 'string') {
        try { name = decodeURIComponent(new URL(stream.url).pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; }
    }
    if (!name && stream.infoHash) name = `${stream.infoHash}:${stream.fileIdx}`;
    return `${name || 'unknown'}|${hints.videoSize || ''}`;
}

// Same season, nearest first, the next episode before the previous one.
function orderNeighbours(videos, videoId) {
    const current = (videos || []).find((video) => video.id === videoId);
    if (!current || !Number.isFinite(current.episode)) return [];
    return videos
        .filter((video) => video.id !== videoId && video.season === current.season && Number.isFinite(video.episode))
        .sort((a, b) => {
            const da = Math.abs(a.episode - current.episode);
            const db = Math.abs(b.episode - current.episode);
            return da - db || b.episode - a.episode;
        });
}

function episodesAhead(videos, videoId) {
    const current = (videos || []).find((video) => video.id === videoId);
    if (!current || !Number.isFinite(current.episode)) return [];
    return videos
        .filter((video) => video.season === current.season && video.episode > current.episode)
        .sort((a, b) => a.episode - b.episode);
}

async function fetchEpisodeStreams(transportUrl, type, videoId) {
    if (typeof transportUrl !== 'string' || !/^https?:/i.test(transportUrl)) return [];
    const base = transportUrl.replace(/manifest\.json(\?.*)?$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${base}stream/${encodeURIComponent(type)}/${encodeURIComponent(videoId)}.json`, { signal: controller.signal });
        if (!response.ok) return [];
        const body = await response.json();
        return Array.isArray(body && body.streams) ? body.streams : [];
    } catch {
        return [];
    } finally {
        clearTimeout(timer);
    }
}

// Direct HTTP streams only: torrents would have to be started in the
// streaming server, and a debrid entry that is not cached yet would start a
// download on the user's account.
function isReadable(stream) {
    if (!stream || typeof stream.url !== 'string' || !/^https?:/i.test(stream.url)) return false;
    const hints = stream.behaviorHints || {};
    if (hints.proxyHeaders && (hints.proxyHeaders.request || hints.proxyHeaders.response)) return false;
    if (/download/i.test(stream.name || '')) return false;
    const size = sizeOf(stream);
    return size === null || size >= MIN_BYTES;
}

/**
 * @param {Array} streams - raw streams for one episode from the addon
 * @param {{ like?: object, limit?: number }} [options] - `like`: the stream
 *   being played; when given, streams the player would pick for the next
 *   episode (same binge group, closest size) come first.
 */
function pickReferenceStreams(streams, options) {
    const { like, limit = 3 } = options || {};
    const readable = (streams || []).filter(isReadable);
    const bySize = (a, b) => (sizeOf(a) === null ? Infinity : sizeOf(a)) - (sizeOf(b) === null ? Infinity : sizeOf(b));
    if (!like) return readable.sort(bySize).slice(0, limit);
    const group = like.behaviorHints && like.behaviorHints.bingeGroup;
    const likeSize = sizeOf(like);
    const distance = (stream) => {
        const size = sizeOf(stream);
        return size && likeSize ? Math.abs(Math.log(size / likeSize)) : 10;
    };
    const sameGroup = (stream) => Boolean(group) && stream.behaviorHints && stream.behaviorHints.bingeGroup === group;
    return readable
        .map((stream, index) => ({ stream, index }))
        .sort((a, b) => sameGroup(b.stream) - sameGroup(a.stream) || distance(a.stream) - distance(b.stream) || a.index - b.index)
        .map(({ stream }) => stream)
        .slice(0, limit);
}

module.exports = {
    sizeOf,
    fileKeyOf,
    orderNeighbours,
    episodesAhead,
    fetchEpisodeStreams,
    isReadable,
    pickReferenceStreams,
};
