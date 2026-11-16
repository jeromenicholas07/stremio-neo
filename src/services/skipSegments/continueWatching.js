// Prepares Skip Intro (intro and credits) for what the viewer is likely to
// play next: the episode each show in Continue Watching is up to, from the
// top, one show at a time and only while no player is open (the analyzer
// cancels it the moment one starts). Each episode's result is kept, so a show
// is only read once per episode.

const analyzer = require('./analyzer');
const store = require('./store');
const { getSkipSettings } = require('./settings');
const { fetchChapters } = require('./chapters');
const { fetchEpisodeStreams, fileKeyOf, isReadable } = require('./neighbours');
const { getPlayableAutoPickSettings, getDefaultAutoPickSettings, pickBestStream } = require('../../common/autoPick');

const MAX_SHOWS = 8;
// Let the app and the Board settle before reading anything.
const START_DELAY_MS = 60 * 1000;
const CINEMETA = 'https://v3-cinemeta.strem.io/meta/series/';
const FETCH_TIMEOUT_MS = 15000;
// Watched this far (core gives progress in percent), the show is up to the
// next episode.
const WATCHED_PERCENT = 90;

let pending = null;
let timer = null;
let running = false;

async function fetchJson(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

// The episode a Continue Watching item opens: its streams deep link ends in it.
function videoIdOf(item) {
    const link = item && item.deepLinks && (item.deepLinks.metaDetailsStreams || item.deepLinks.player);
    if (typeof link !== 'string') return null;
    const match = link.match(/#\/detail\/series\/[^/]+\/([^/?]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}

function servesSeriesStreams(addon) {
    const manifest = addon && addon.manifest;
    if (!manifest || typeof addon.transportUrl !== 'string') return false;
    const types = (resource) => (resource && Array.isArray(resource.types) ? resource.types : manifest.types || []);
    return (manifest.resources || []).some((resource) => (resource === 'stream' || (resource && resource.name === 'stream'))
        && types(resource).includes('series'));
}

/**
 * The analyzer job for one Continue Watching show, or null.
 *
 * The file is the one Auto-Pick would choose from the stream add-ons' lists
 * (its real run also checks each stream first, so usually rather than
 * always the same file).
 */
async function jobFor(item, addons, streamingServerUrl) {
    const metaId = item._id;
    let videoId = videoIdOf(item);
    if (!metaId || !videoId) return null;
    const meta = await fetchJson(`${CINEMETA}${encodeURIComponent(metaId)}.json`);
    const videos = ((meta && meta.meta && meta.meta.videos) || [])
        .map((video) => ({ id: video.id, season: video.season, episode: video.episode !== undefined ? video.episode : video.number }))
        .filter((video) => typeof video.season === 'number' && typeof video.episode === 'number')
        .sort((a, b) => a.season - b.season || a.episode - b.episode);
    if (typeof item.progress === 'number' && item.progress >= WATCHED_PERCENT) {
        const index = videos.findIndex((video) => video.id === videoId);
        if (index < 0 || index + 1 >= videos.length) return null;
        videoId = videos[index + 1].id;
    }
    const video = videos.find((candidate) => candidate.id === videoId);
    if (!video) return null;
    const streams = [];
    for (const addon of addons.filter(servesSeriesStreams)) {
        (await fetchEpisodeStreams(addon.transportUrl, 'series', videoId))
            .forEach((stream) => streams.push({ stream, transportUrl: addon.transportUrl }));
    }
    const readable = streams.filter(({ stream }) => isReadable(stream));
    const settings = getPlayableAutoPickSettings('series', metaId) || getDefaultAutoPickSettings();
    const picked = pickBestStream(readable.map(({ stream }) => stream), settings);
    const choice = readable.find(({ stream }) => stream === picked);
    if (!choice) return null;
    const existing = await store.getResult(videoId, fileKeyOf(choice.stream));
    if (existing && existing.complete) return null;
    const info = await fetchChapters(choice.stream.url);
    // Not an episode: a placeholder clip for a dead stream, or a misread length.
    if (!info || !info.duration || info.duration < 120) return null;
    return {
        type: 'series',
        metaId,
        videoId,
        season: video.season,
        videos,
        stream: choice.stream,
        transportUrl: choice.transportUrl,
        streamingServerUrl,
        duration: Math.round(info.duration),
    };
}

async function drain() {
    timer = null;
    if (running) return;
    running = true;
    try {
        while (pending && pending.items.length > 0) {
            // A player is open (or still finishing its work): look again later.
            if (analyzer.isBusy()) break;
            const queue = pending;
            const item = queue.items[0];
            const job = await jobFor(item, queue.addons, queue.streamingServerUrl).catch(() => null);
            // Given way to a player: this show is still to do.
            if (job && !(await analyzer.prepare(job)) && analyzer.isBusy()) break;
            // Done, failed or not preparable. A newer list may have replaced
            // the queue meanwhile; it starts from its own top.
            if (pending === queue && queue.items[0] === item) queue.items.shift();
        }
    } finally {
        running = false;
        if (pending && pending.items.length > 0) arm();
    }
}

function arm() {
    if (timer) return;
    timer = setTimeout(drain, START_DELAY_MS);
    // Under Node (tests) a pending start must not keep the process alive.
    if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Called with the current Continue Watching list (top first), e.g. whenever
 * it changes. Replaces whatever was still queued.
 *
 * @param {{ items: Array, addons: Array, streamingServerUrl: string }} input
 */
function schedule({ items, addons, streamingServerUrl }) {
    const settings = getSkipSettings();
    if (settings.mode === 'off' || !settings.backgroundAnalysis) return;
    pending = {
        items: (items || []).filter((item) => item && item.type === 'series').slice(0, MAX_SHOWS),
        addons: addons || [],
        streamingServerUrl,
    };
    if (!running) arm();
}

module.exports = {
    schedule,
    videoIdOf,
    jobFor,
    // For tests: work through the queue now instead of after the delay.
    drain,
};
