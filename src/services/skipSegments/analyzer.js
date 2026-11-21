// Background analysis for Skip Intro. One job at a time, for the episode being
// played: ask the databases, read the file's chapters, and find the audio the
// episode shares with its neighbours. Results are published as they firm up,
// then the next episodes of the season are prepared so their result is ready
// before they start.
//
// The analyzer is a module-level singleton on purpose: the work has to survive
// the Player re-rendering and moving on to the next episode.

const { extractChunkDirect, checkExtractServer, resolveMediaUrl } = require('../subtitleSync/audioExtractor');
const { FRAMES_PER_SECOND } = require('./fingerprint');
const compute = require('./compute');
const store = require('./store');
const { lookupDatabases } = require('./databases');
const { fetchChapters, fetchSceneCuts } = require('./chapters');
const { findPictureCredits } = require('./creditsPicture');
const { storyEnd, snapStoryEnd, snapWindow } = require('./storyEnd');
const { speechInWorker } = require('./textDetector');
const { fuse, landingAfter, STRONG_BIT_ERROR_RATE } = require('./fusion');
const { getSkipSettings } = require('./settings');
const { fileKeyOf, orderNeighbours, episodesAhead, fetchEpisodeStreams, pickReferenceStreams, isReadable, sizeOf } = require('./neighbours');
const { getPlayableAutoPickSettings, pickBestStream } = require('../../common/autoPick');

// Almost every intro starts in the first six minutes, most in the first
// three. Read three minutes first so an answer comes quickly, and widen only
// when nothing was found, because ffmpeg has to download the file up to the
// point it reads.
const WINDOW_SECONDS = 360;
const EXTENDED_SECONDS = 900;
const WINDOWS = [180, WINDOW_SECONDS, EXTENDED_SECONDS];
// One read per window step: 0-180, 180-360, then 360-900 in three reads.
const CHUNK_SECONDS = 180;
// Reads of one file run side by side.
const LANES = 3;
// Neighbours read at the same time as the episode itself.
const EAGER_NEIGHBOURS = 2;
const MAX_NEIGHBOURS = 3;
const EXTENDED_NEIGHBOURS = 1;
// After this many episodes of a season with nothing shared, stop reading audio
// for that season: it has no recurring intro.
const SEASON_MISS_LIMIT = 2;
// Episodes prepared ahead, each for up to two likely files (see likelyNext).
const AHEAD_LIMIT = 2;
// Shorter is not an episode: a debrid placeholder clip for a dead stream
// (~30 s), or a file whose length ffmpeg misread. Neither is analysed.
const MIN_EPISODE_SECONDS = 120;
const HEAD_SECONDS = 8;
// Keep working this long after the player closes, so going back to pick the
// next episode does not throw the season's progress away.
const RELEASE_GRACE_MS = 3 * 60 * 1000;

const listeners = new Set();
const results = new Map();
let active = null;
// Whether reads may go ahead. The player turns this off while it loads,
// seeks or runs short of data, and on again once it has played smoothly for
// a while (useSkipSegments). With no player open there is nothing to protect.
let ready = true;
let releaseTimer = null;
// A preparation of an episode nobody is playing (see prepare).
let background = null;
let sweepTimer = null;
// The day's clean-up of stored data waits until the start of playback is over.
const SWEEP_DELAY_MS = 5 * 60 * 1000;

class Cancelled extends Error {}

// A job's token. Cancelling it also aborts its reads in flight, so the
// sidecar's ffmpeg for them ends instead of running on for nobody.
const newToken = () => ({ cancelled: false, controller: new AbortController() });
function cancel(token) {
    token.cancelled = true;
    token.controller.abort();
}
const check = (token) => { if (token.cancelled) throw new Cancelled(); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every read waits here until the player can spare the connection.
async function idle(token) {
    while (!ready) {
        check(token);
        await sleep(1000);
    }
    check(token);
}

// Results of this session, newest last; older ones are in the store.
const KEEP_RESULTS = 20;

function publish(key, patch) {
    const next = { key, status: 'working', segments: [], ...results.get(key), ...patch };
    results.set(key, next);
    for (const old of results.keys()) {
        if (results.size <= KEEP_RESULTS) break;
        if (!active || old !== active.key) results.delete(old);
    }
    listeners.forEach((listener) => listener(next));
}

const keyFor = (videoId, stream) => `${videoId}|${fileKeyOf(stream)}`;

// ── Audio to fingerprint ────────────────────────────────────────────────────

// Reads of any file at once, whichever part of the analysis asks for them.
// Each is an ffmpeg pulling from the debrid host as fast as it can, so this
// bounds what the analysis takes from the connection the player shares.
const MAX_READS = 4;
let reading = 0;
const waitingReads = [];
const takeRead = () => new Promise((resolve) => {
    if (reading < MAX_READS) {
        reading++;
        resolve();
    } else {
        waitingReads.push(resolve);
    }
});
function giveRead() {
    const next = waitingReads.shift();
    if (next) next(); else reading--;
}

// One read of a file: once a slot is free and the player can spare the
// connection (checked after the wait for a slot, which can be long).
async function withRead(token, read) {
    await takeRead();
    try {
        await idle(token);
        return await read(token.controller.signal);
    } finally {
        giveRead();
    }
}

async function readChunk(mediaUrl, start, seconds, token) {
    // A little extra so the last analysis window of the chunk is complete.
    const chunk = await withRead(token, (signal) => extractChunkDirect(mediaUrl, start, seconds + 0.3, null, 'full', signal));
    check(token);
    const fingerprint = await compute.fingerprint(chunk.audio, seconds * FRAMES_PER_SECOND);
    return { start, fingerprint };
}

// Fingerprint [from, to) seconds of a file. Returns null when too little of it
// could be read to be worth comparing.
async function fingerprintRange(mediaUrl, from, to, token, options) {
    const { parallel = 1 } = options || {};
    const frames = (to - from) * FRAMES_PER_SECOND;
    const hashes = new Int32Array(frames);
    const valid = new Uint8Array(frames);
    const starts = [];
    for (let start = from; start < to; start += CHUNK_SECONDS) starts.push(start);
    let cursor = 0;
    let failed = 0;
    let holes = 0;
    let ended = false;

    const place = ({ start, fingerprint }) => {
        const offset = Math.round((start - from) * FRAMES_PER_SECOND);
        const room = frames - offset;
        hashes.set(fingerprint.hashes.subarray(0, room), offset);
        valid.set(fingerprint.valid.subarray(0, room), offset);
    };
    // A chunk can come back short without the file ending: ffmpeg gives up
    // early on a slow, very high bitrate stream. Ask once for the rest; only
    // when that brings nothing is it the end of the file.
    const readRest = async (start, seconds, got) => {
        const restStart = start + got / FRAMES_PER_SECOND;
        const restSeconds = seconds - got / FRAMES_PER_SECOND;
        try {
            const rest = await readChunk(mediaUrl, restStart, restSeconds, token);
            if (rest.fingerprint.hashes.length < FRAMES_PER_SECOND) return true;
            place(rest);
            return false;
        } catch (error) {
            if (error instanceof Cancelled) throw error;
            return true;
        }
    };
    const lane = async () => {
        while (cursor < starts.length && !ended) {
            const start = starts[cursor++];
            check(token);
            const seconds = Math.min(CHUNK_SECONDS, to - start);
            try {
                const part = await readChunk(mediaUrl, start, seconds, token);
                place(part);
                const got = part.fingerprint.hashes.length;
                if (got < (seconds - 3) * FRAMES_PER_SECOND && await readRest(start, seconds, got)) ended = true;
            } catch (error) {
                if (error instanceof Cancelled) throw error;
                // A full chunk can outlast the sidecar's time limit on a very
                // high bitrate file; two halves usually get through.
                const half = seconds / 2;
                const halves = await Promise.allSettled([readChunk(mediaUrl, start, half, token), readChunk(mediaUrl, start + half, half, token)]);
                const read = halves.filter((result) => result.status === 'fulfilled');
                read.forEach((result) => place(result.value));
                if (read.length === 0) failed++;
                if (read.length < halves.length) holes++;
            }
        }
    };
    await Promise.all(Array.from({ length: parallel }, lane));
    check(token);
    // With gaps where reads failed, it can still be matched, but it is not
    // a full look at the file (see findSharedAudio).
    return failed * 2 > starts.length ? null : { hashes, valid, complete: holes === 0 };
}

// The stored fingerprint of an episode, read or extended as needed.
async function ensureFingerprint(videoId, fileKey, mediaUrl, seconds, token, options) {
    const stored = await store.getFingerprint(videoId, fileKey);
    const sameFile = stored && stored.fileKey === fileKey;
    if (sameFile && stored.seconds >= seconds) return stored;
    const from = sameFile ? stored.seconds : 0;
    const added = await fingerprintRange(mediaUrl, from, seconds, token, options);
    if (!added) return sameFile ? stored : null;
    const frames = seconds * FRAMES_PER_SECOND;
    const fingerprint = { fileKey, seconds, hashes: new Int32Array(frames), valid: new Uint8Array(frames), complete: added.complete };
    if (sameFile) {
        fingerprint.hashes.set(stored.hashes);
        fingerprint.valid.set(stored.valid);
    }
    fingerprint.hashes.set(added.hashes, from * FRAMES_PER_SECOND);
    fingerprint.valid.set(added.valid, from * FRAMES_PER_SECOND);
    // One with gaps is used as it is but not kept, so the next look at this
    // episode reads it again instead of matching against the gaps forever.
    if (fingerprint.complete) await store.setFingerprint(videoId, fingerprint);
    return fingerprint;
}

const hasAudio = (fingerprint) => fingerprint.valid.reduce((sum, flag) => sum + flag, 0) > 30 * FRAMES_PER_SECOND;

// Another episode to compare with, preferably from the same release as the
// file being played. A different release can be a different source: a PAL
// rip runs 4% fast at a higher pitch, and a heavily compressed low-resolution
// rip smears the audio, and neither then matches at all.
async function referenceFingerprint(job, video, seconds, token, options) {
    const stored = await store.getAnyFingerprint(video.id);
    if (stored && stored.seconds >= seconds) return stored;
    const streams = await fetchEpisodeStreams(job.transportUrl, job.type, video.id);
    check(token);
    for (const stream of pickReferenceStreams(streams, { like: job.stream, limit: 3 })) {
        const fingerprint = await ensureFingerprint(video.id, fileKeyOf(stream), stream.url, seconds, token, options);
        if (fingerprint && hasAudio(fingerprint)) return fingerprint;
    }
    return null;
}

// A studio card or a content warning before the theme is usually silent. When
// the shared audio starts within a few seconds of a silent opening, the intro
// is taken to start at the very beginning.
function fromTheTop(fingerprint, match) {
    if (match.startA > HEAD_SECONDS) return match.startA;
    const frames = Math.floor(match.startA * FRAMES_PER_SECOND);
    let audible = 0;
    for (let i = 0; i < frames; i++) audible += fingerprint.valid[i];
    return frames === 0 || audible / frames < 0.3 ? 0 : match.startA;
}

const asEvidence = (fingerprint, match, weight) => ({
    start: fromTheTop(fingerprint, match),
    end: match.endA,
    rawStart: match.startA,
    bitErrorRate: match.bitErrorRate,
    weight,
});

async function matchTheme(fingerprint, theme) {
    const [match] = await compute.match(fingerprint, theme, { minSeconds: Math.max(8, theme.seconds * 0.7) });
    return match && match.bitErrorRate <= STRONG_BIT_ERROR_RATE ? asEvidence(fingerprint, match, theme.confirmed ? 2 : 1) : null;
}

const introOf = (evidence) => fuse(evidence).find((segment) => segment.type === 'intro');

// ── Heavy files ─────────────────────────────────────────────────────────────

// Above about 10 Mbit/s (a 4K remux runs 40-80), three minutes of a file is
// gigabytes and does not arrive within the sidecar's time limit. A light
// release of the same episode is read instead, and lined up with the real
// file afterwards: releases of one episode can differ by a few seconds of
// lead-in, so the light one's times cannot be used as they are.
const HEAVY_BYTES_PER_SECOND = 1.25e6;
const LIGHT_BYTES_PER_SECOND = 0.75e6;
const TINY_BYTES_PER_SECOND = 0.05e6; // below this the audio is too degraded to match
const ALIGN_SECONDS = 30;
const CHAPTER_WAIT_MS = 8000;

function bytesPerSecond(stream, duration) {
    const size = sizeOf(stream);
    return size && duration ? size / duration : null;
}

const isHeavy = (stream, duration) => (bytesPerSecond(stream, duration) || 0) > HEAVY_BYTES_PER_SECOND;

// A light release of the same episode, in the addon's own order (best first).
function lightStandIn(streams, duration) {
    return streams.filter(isReadable).find((stream) => {
        const rate = bytesPerSecond(stream, duration);
        return rate !== null && rate <= LIGHT_BYTES_PER_SECOND && rate >= TINY_BYTES_PER_SECOND;
    }) || null;
}

// Where the stand-in's intro sits in the file being played: a short read of
// the real file around it, matched against the stand-in. Seconds to add to
// stand-in times, or null when they cannot be lined up.
async function offsetOnPlayedFile(mediaUrl, standIn, around, token) {
    const from = Math.max(0, Math.floor(around) - 10);
    check(token);
    const part = await readChunk(mediaUrl, from, ALIGN_SECONDS, token);
    const [match] = await compute.match(part.fingerprint, standIn, { minSeconds: 8 });
    return match && match.bitErrorRate <= STRONG_BIT_ERROR_RATE ? from + match.startA - (match.startB + (standIn.from || 0)) : null;
}

// The result for the file being played. Audio evidence from a stand-in is
// moved by the measured offset; until that is known, nothing it found may be
// skipped unattended.
function fuseForPlayback(evidence) {
    const shift = evidence.offset || 0;
    const moved = (list) => (list || []).map((match) => ({
        ...match,
        start: Math.max(0, match.start + shift),
        end: match.end + shift,
        ...(typeof match.rawStart === 'number' ? { rawStart: Math.max(0, match.rawStart + shift) } : {}),
    }));
    const run = evidence.creditsPicture && evidence.creditsPicture.run;
    const story = evidence.creditsPicture && evidence.creditsPicture.story;
    const creditsPicture = run && (evidence.standIn || evidence.creditsStandIn)
        ? {
            ...evidence.creditsPicture,
            run: { ...run, start: run.start + shift, end: run.end + shift },
            // The story end moves by the offset measured at it, if any.
            ...(story ? { story: { ...story, end: story.end + (typeof story.offset === 'number' ? story.offset : shift) } } : {}),
        }
        : evidence.creditsPicture;
    const segments = fuse({ ...evidence, repetition: moved(evidence.repetition), creditsRepetition: moved(evidence.creditsRepetition), creditsPicture });
    if (!evidence.standIn && !evidence.creditsStandIn) return segments;
    // Credits from a stand-in never advance on their own: the offset was
    // measured at the intro, and releases can differ further in.
    return segments.map((segment) => {
        const lowered = segment.type === 'credits'
            ? segment.confidence === 'high' && !segment.sources.includes('chapter')
            : segment.confidence === 'high' && segment.sources.includes('audio') && evidence.offset === null;
        return lowered ? { ...segment, confidence: 'medium' } : segment;
    });
}

// ── The episode being played ────────────────────────────────────────────────

// ── Reading only where a database places the intro ──────────────────────────

// A database that puts the intro minutes in, after a long cold open, saves
// reading everything before it: only a stretch around that spot is read,
// here and in a neighbour whose own position the database also knows (or
// matched against the season's theme). True when that settled it.
const AROUND_SECONDS = 60;

// A shared stretch no longer than this, starting this close to the top, may
// be an opening narration or ident rather than the intro (see findSharedAudio).
const PREAMBLE_START_SECONDS = 30;
const PREAMBLE_SECONDS = 25;

async function findAroundDatabase(job, mediaUrl, token, evidence, refresh, dbIntro) {
    const span = (entry) => [Math.max(0, Math.floor(entry.start) - AROUND_SECONDS), Math.ceil(entry.end) + AROUND_SECONDS];
    const [from, to] = span(dbIntro);
    const theme = await store.getTheme(job.metaId, job.season);
    // Two neighbours, so that agreeing matches can confirm the intro on
    // their own.
    const references = [];
    if (!theme) {
        const candidates = orderNeighbours(job.videos, job.videoId).slice(0, MAX_NEIGHBOURS);
        const located = await Promise.all(candidates.map(async (video) => {
            const answer = await lookupDatabases({ videoId: video.id });
            const entry = answer.segments.find((segment) => segment.type === 'intro');
            if (!entry) return null;
            const [stream] = pickReferenceStreams(await fetchEpisodeStreams(job.transportUrl, job.type, video.id), { like: job.stream, limit: 1 });
            return stream ? { stream, range: span(entry) } : null;
        }));
        references.push(...located.filter(Boolean).slice(0, EAGER_NEIGHBOURS));
        if (references.length === 0) return false;
    }
    check(token);
    const [played, ...others] = await Promise.all([
        fingerprintRange(mediaUrl, from, to, token, { parallel: LANES }),
        ...references.map((reference) => fingerprintRange(reference.stream.url, reference.range[0], reference.range[1], token, { parallel: LANES }).catch(() => null)),
    ]);
    if (!played) return false;
    const found = [];
    const add = (match, weight) => found.push({
        start: match.startA + from, end: match.endA + from, rawStart: match.startA + from, bitErrorRate: match.bitErrorRate, weight,
    });
    if (theme) {
        const [match] = await compute.match(played, theme, { minSeconds: Math.max(8, theme.seconds * 0.7) });
        if (match && match.bitErrorRate <= STRONG_BIT_ERROR_RATE) add(match, theme.confirmed ? 2 : 1);
    }
    for (const other of others.filter(Boolean)) (await compute.match(played, other)).forEach((match) => add(match, 1));
    const strong = found.filter((match) => match.bitErrorRate <= STRONG_BIT_ERROR_RATE);
    if (strong.length === 0) return false;
    evidence.repetition = found;
    evidence.sourceFingerprint = { ...played, from };
    evidence.path = 'around-database';
    refresh();
    const intro = introOf(evidence);
    const best = strong.sort((a, b) => a.bitErrorRate - b.bitErrorRate)[0];
    if (intro && (!theme || !theme.confirmed || intro.confidence === 'high')) {
        const a = Math.round((best.rawStart - from) * FRAMES_PER_SECOND);
        const b = Math.round((Math.min(intro.end, to) - from) * FRAMES_PER_SECOND);
        await store.setTheme(job.metaId, job.season, {
            hashes: played.hashes.slice(a, b),
            valid: played.valid.slice(a, b),
            seconds: (b - a) / FRAMES_PER_SECOND,
            confirmed: intro.confidence === 'high' || Boolean(theme && theme.confirmed),
            window: Math.min(EXTENDED_SECONDS, to),
        });
    }
    return true;
}

async function findSharedAudio(job, mediaUrl, token, evidence, refresh) {
    const fileKey = fileKeyOf(job.stream);
    const ordered = orderNeighbours(job.videos, job.videoId);
    const confirmed = () => { const intro = introOf(evidence); return Boolean(intro) && intro.confidence === 'high'; };
    const located = evidence.database && evidence.database.segments.find((entry) => entry.type === 'intro');
    if (located && located.end > WINDOWS[0] && located.end + AROUND_SECONDS <= EXTENDED_SECONDS
        && await findAroundDatabase(job, mediaUrl, token, evidence, refresh, located)) {
        return true;
    }
    evidence.path = 'windows';

    // Whether the last window was compared in full: this episode and at
    // least one neighbour (or the season's theme) read without gaps. Only
    // then does finding nothing count against the season.
    let comparedInFull = false;
    for (const seconds of WINDOWS) {
        const whole = (fingerprint) => fingerprint.complete !== false && fingerprint.seconds >= seconds;
        // When a database already places the intro further in, read far
        // enough to see it rather than settling for whatever shared audio
        // comes first.
        const dbIntro = evidence.database && evidence.database.segments.find((entry) => entry.type === 'intro');
        if (dbIntro && dbIntro.end + 10 > seconds && seconds < EXTENDED_SECONDS) continue;
        const neighbours = ordered.slice(0, seconds < EXTENDED_SECONDS ? MAX_NEIGHBOURS : EXTENDED_NEIGHBOURS);
        const theme = await store.getTheme(job.metaId, job.season);
        // Every read costs about five seconds before any audio arrives (the
        // debrid host takes ~0.9 s per request and ffmpeg makes six), however
        // long it is. So read few, long stretches, and read this episode and
        // its nearest neighbours at the same time. With a theme for the
        // season only this episode is needed, so nothing else is fetched.
        // When a database already has an intro, one neighbour agreeing with it
        // is enough to confirm it, so only one is read up front.
        const early = (theme ? [] : neighbours.slice(0, dbIntro ? 1 : EAGER_NEIGHBOURS))
            .map((video) => referenceFingerprint(job, video, seconds, token, { parallel: LANES }).catch(() => null));
        const played = await ensureFingerprint(job.videoId, fileKey, mediaUrl, seconds, token, { parallel: LANES });
        if (!played || played.seconds < seconds) {
            await Promise.allSettled(early);
            return false;
        }
        evidence.repetition = [];
        evidence.sourceFingerprint = played;
        let compared = Boolean(theme);
        const fromTheme = theme ? await matchTheme(played, theme) : null;
        if (fromTheme) {
            evidence.repetition.push(fromTheme);
            refresh();
        }
        for (let i = 0; i < neighbours.length; i++) {
            if (confirmed()) break;
            check(token);
            const reference = await (i < early.length ? early[i] : referenceFingerprint(job, neighbours[i], seconds, token, { parallel: LANES }));
            if (!reference) continue;
            if (whole(reference)) compared = true;
            // Every stretch the two share, not only the best: a studio logo
            // can match more cleanly than the intro that follows it.
            const matches = await compute.match(played, reference);
            if (matches.length > 0) {
                matches.forEach((match) => evidence.repetition.push(asEvidence(played, match, 1)));
                refresh();
            }
        }
        const best = evidence.repetition
            .filter((match) => match.bitErrorRate <= STRONG_BIT_ERROR_RATE)
            .sort((a, b) => a.bitErrorRate - b.bitErrorRate)[0];
        comparedInFull = compared && whole(played);
        const intro = introOf(evidence);
        // An intro running up to the edge of what was read may go on past it.
        if (best && intro && intro.end >= seconds - 5 && seconds < EXTENDED_SECONDS) continue;
        // A short stretch at the very start may be something every episode
        // opens with before its title sequence, such as a narration or a
        // network ident (Law & Order: SVU). Look further before settling on
        // it; the longer shared stretch wins in fusion. The first time a
        // season is analysed, one window further. When the season's theme is
        // known but not found yet, as far as the search goes: it comes after
        // a cold open whose length changes from episode to episode, and only
        // this file is read for it.
        const preamble = intro && intro.start <= PREAMBLE_START_SECONDS && intro.end - intro.start <= PREAMBLE_SECONDS;
        if (best && preamble && !fromTheme && seconds < (theme ? EXTENDED_SECONDS : WINDOW_SECONDS)) continue;
        if (best) {
            // Keep the intro's own fingerprint: later episodes are then checked
            // against it directly instead of against whole neighbours. It is
            // cut to the fused intro, not to the closest single match, which
            // can be a shortened version that would then cut every later
            // episode short too. It starts at the best match inside the intro;
            // the best match overall can be a logo or preamble before it.
            const anchor = intro && evidence.repetition
                .filter((match) => match.bitErrorRate <= STRONG_BIT_ERROR_RATE && match.start < intro.end && match.end > intro.start)
                .sort((a, b) => a.bitErrorRate - b.bitErrorRate)[0];
            if (anchor && (!theme || !theme.confirmed || confirmed())) {
                const from = Math.round(anchor.rawStart * FRAMES_PER_SECOND);
                const to = Math.round(Math.min(intro.end, seconds) * FRAMES_PER_SECOND);
                await store.setTheme(job.metaId, job.season, {
                    hashes: played.hashes.slice(from, to),
                    valid: played.valid.slice(from, to),
                    seconds: (to - from) / FRAMES_PER_SECOND,
                    confirmed: confirmed() || Boolean(theme && theme.confirmed),
                    // How far into the file the next episodes must be read to
                    // see it: shows with long cold opens need more reach, and
                    // one found after looking further still sits early.
                    window: WINDOWS.find((reach) => intro.end < reach - 5) || seconds,
                });
            }
            await store.setSeasonMisses(job.metaId, job.season, 0);
            return true;
        }
        if (evidence.repetition.length > 0) return true;
    }
    // Nothing shared. That counts against the season only when it was really
    // looked for: reads that failed on a slow host say nothing about the show,
    // and two misses stop audio analysis for the season for a month. Nor when
    // the season has a theme: then this episode only cut it short or left it
    // out.
    if (comparedInFull && !(await store.getTheme(job.metaId, job.season))) {
        await store.setSeasonMisses(job.metaId, job.season, (await store.getSeasonMisses(job.metaId, job.season)) + 1);
    }
    return true;
}

async function databaseAnswer(job) {
    const cached = await store.getDatabaseAnswer(job.videoId);
    if (cached) return cached;
    // Only TheIntroDB for now. IntroDB does not allow this origin, and the
    // streaming server's /proxy/ answers 500 for it, so it needs a passthrough
    // in the launcher before lookupDatabases can be given a proxy for it.
    const answer = await lookupDatabases({ videoId: job.videoId, durationSec: job.duration });
    await store.setDatabaseAnswer(job.videoId, answer);
    return answer;
}

// ── The episodes that come next ─────────────────────────────────────────────

// ── Credits ─────────────────────────────────────────────────────────────────

// End credits play the same music every episode, so they are found like the
// intro from the other end: the last minutes of this episode against the
// last minutes of a neighbour, or against the season's credits theme.
const CREDITS_WINDOWS = [180, 360];
const CREDITS_NEIGHBOURS = 2;
const CREDITS_THEME_SECONDS = 120;
// Credits run longer than any intro.
const CREDITS_MATCH = { maxSeconds: 400 };

const asCredits = (fingerprint, match, weight, end) => ({
    start: fingerprint.from + match.startA,
    end: typeof end === 'number' ? end : fingerprint.from + match.endA,
    bitErrorRate: match.bitErrorRate,
    weight,
});

// The last `seconds` of a file, kept like the opening ones (as "<videoId>#end")
// so an episode prepared ahead is not read again when it plays.
async function endFingerprint(url, duration, seconds, token, videoId, fileKey, previous) {
    const to = Math.floor(duration);
    const from = Math.max(0, to - seconds);
    const key = `${videoId}#end`;
    // The player's duration and ffmpeg's can differ by a second.
    const usable = (fingerprint) => fingerprint && Math.abs(fingerprint.to - to) <= 2;
    const stored = usable(previous) ? previous : await store.getFingerprint(key, fileKey);
    if (usable(stored) && stored.from <= from + 2) return stored;
    // A shorter end already read is extended, not read again.
    const known = usable(stored) && stored.from > from ? stored : null;
    const added = await fingerprintRange(url, from, known ? known.from : to, token, { parallel: 2 });
    if (!added) return null;
    let fingerprint = added;
    if (known) {
        const head = added.hashes.length;
        const hashes = new Int32Array(head + known.hashes.length);
        const valid = new Uint8Array(head + known.valid.length);
        hashes.set(added.hashes);
        hashes.set(known.hashes, head);
        valid.set(added.valid);
        valid.set(known.valid, head);
        fingerprint = { hashes, valid, complete: added.complete && known.complete !== false };
    }
    if (!hasAudio(fingerprint)) return null;
    const end = { ...fingerprint, fileKey, from, to: known ? known.to : to, seconds: (known ? known.to : to) - from };
    if (end.complete) await store.setFingerprint(key, end);
    return end;
}

async function neighbourEnd(job, video, seconds, token) {
    const streams = await fetchEpisodeStreams(job.transportUrl, job.type, video.id);
    for (const stream of pickReferenceStreams(streams, { like: job.stream, limit: 2 })) {
        check(token);
        const info = await fetchChapters(stream.url);
        if (!info || !info.duration || info.duration < MIN_EPISODE_SECONDS) continue;
        const fingerprint = await endFingerprint(stream.url, info.duration, seconds, token, video.id, fileKeyOf(stream));
        if (fingerprint) return fingerprint;
    }
    return null;
}

// The season's credits theme in the end of a file. The theme is only the
// start of the credits; when all of it matched and as much is left after it
// as in the episode it came from, the credits are taken to run out the file
// here too.
async function creditsFromTheme(played, duration, theme) {
    const [match] = await compute.match(played, theme, { ...CREDITS_MATCH, minSeconds: Math.max(8, theme.seconds * 0.7) });
    if (!match || match.bitErrorRate > STRONG_BIT_ERROR_RATE) return null;
    const matchEnd = played.from + match.endA;
    const whole = match.endA - match.startA >= theme.seconds * 0.9;
    const sameTail = typeof theme.tail === 'number' && Math.abs(duration - matchEnd - theme.tail) <= 15;
    return asCredits(played, match, theme.confirmed ? 2 : 1, theme.confirmed && whole && sameTail ? duration : undefined);
}

// The picture decides where the credits start (creditsPicture): over the
// stretch the shared music points at, else from where the season's credits
// usually start, else over the last eight minutes. A heavy file is only read
// near the end, it costs gigabytes otherwise.
const PICTURE_BEFORE_MUSIC = 60;
const PICTURE_AFTER_MUSIC = 90;
const PICTURE_BEFORE_LEARNED = 90;
const PICTURE_SECONDS = 480;
const PICTURE_HEAVY_SECONDS = 150;
const PICTURE_TO_END_SECONDS = 150;

// ── Where the story ends ────────────────────────────────────────────────────

// Speech is listened to from a little before the credits to the end.
const SPEECH_BEFORE = 10;
const SPEECH_MAX_SECONDS = 600;

// What people say from `from` to the end of the file (Silero VAD in the
// worker), read in the analyzer's read queue. Null when it cannot be heard.
async function speechToEnd(mediaUrl, from, duration, token) {
    const to = Math.min(Math.floor(duration), from + SPEECH_MAX_SECONDS);
    const segments = [];
    for (let start = from; start < to; start += CHUNK_SECONDS) {
        const seconds = Math.min(CHUNK_SECONDS, to - start);
        let chunk;
        try {
            chunk = await withRead(token, (signal) => extractChunkDirect(mediaUrl, start, seconds, null, 'full', signal));
        } catch (error) {
            if (error instanceof Cancelled) throw error;
            return null;
        }
        check(token);
        const heard = await speechInWorker(chunk.audio, start);
        check(token);
        if (!heard) return null;
        segments.push(...heard);
    }
    return segments;
}

/**
 * Where the story ends after credits seen in the picture (storyEnd): the
 * credits start, or the end of the scene still playing or talking under
 * them, or of a scene after the roll. Null when the picture gave no tail.
 */
async function findStoryEnd(mediaUrl, duration, found, token, { playedUrl = null, reference = null } = {}) {
    if (!found || !found.run || !found.tail || found.tail.frames.length === 0) return null;
    const { run, tail } = found;
    const speech = await speechToEnd(mediaUrl, Math.max(0, Math.floor(run.start - SPEECH_BEFORE)), duration, token);
    const story = storyEnd({ start: run.start, frames: tail.frames, framesFrom: tail.from, fps: tail.fps, speech, duration });
    const step = 1 / tail.fps;
    let scene = null;
    if (story.by !== 'start') {
        const { from, to } = snapWindow(story, step);
        scene = await withRead(token, (signal) => fetchSceneCuts(mediaUrl, from, to - from, signal));
        check(token);
    }
    const end = Math.min(snapStoryEnd(story, run.start, step, scene), duration);
    // Read on a stand-in for a heavy file: where that moment sits in the file
    // being played, by its audio there against the stand-in's end. Releases
    // can be cut a few seconds apart; without the match the end is offered
    // but not advanced on.
    let offset = null;
    if (playedUrl && reference) {
        offset = await offsetOnPlayedFile(playedUrl, reference, end, token).catch((error) => {
            if (error instanceof Cancelled) throw error;
            return null;
        });
        check(token);
    }
    return {
        end,
        by: story.by,
        words: story.words,
        live: story.live,
        roll: story.roll,
        logos: story.logos,
        scene: story.scene,
        heard: speech !== null && (!playedUrl || offset !== null),
        offset,
    };
}
// Seasons where the picture showed nothing this many times are not read for
// it again for a while (credits the detector cannot see, or none at all).
const PICTURE_MISS_LIMIT = 3;

function pictureWindow(duration, credits, length, heavy) {
    const end = Math.floor(duration);
    let from;
    if (credits) from = credits.start - PICTURE_BEFORE_MUSIC;
    else if (length) from = duration - length.seconds - PICTURE_BEFORE_LEARNED;
    else from = duration - PICTURE_SECONDS;
    from = Math.max(0, Math.max(from, duration - (heavy ? PICTURE_HEAVY_SECONDS : 900)));
    // Shared music that stops well before the end: the credits are inside it.
    // The window still reaches the end when that is not much further, for
    // a scene after the credits (storyEnd) and to see the credits run out.
    const clipped = credits && credits.end < duration - 15 ? Math.min(end, credits.start + PICTURE_AFTER_MUSIC) : end;
    const to = end - clipped <= PICTURE_TO_END_SECONDS ? end : clipped;
    return { from, to: Math.max(to, Math.min(end, from + 30)) };
}

// The season's credits length for a file of about this length.
function nearestLength(samples, duration) {
    if (samples.length === 0) return null;
    return samples.reduce((best, sample) => (Math.abs(sample.duration - duration) < Math.abs(best.duration - duration) ? sample : best));
}

// The music shared with the season's theme or the neighbours. Returns the
// end fingerprint read and the credits it shows, if any.
async function creditsFromAudio(job, mediaUrl, duration, token, evidence, refresh, theme) {
    const neighbours = orderNeighbours(job.videos, job.videoId).slice(0, CREDITS_NEIGHBOURS);
    const creditsOf = () => fuse({ ...evidence, duration, creditsPicture: null }).find((segment) => segment.type === 'credits' && segment.sources.includes('audio'));
    let played = null;
    for (const seconds of CREDITS_WINDOWS) {
        played = await endFingerprint(mediaUrl, duration, seconds, token, job.videoId, fileKeyOf(job.stream), played);
        if (!played) return { played: null, credits: null };
        evidence.creditsRepetition = [];
        const fromTheme = theme ? await creditsFromTheme(played, duration, theme) : null;
        if (fromTheme) evidence.creditsRepetition.push(fromTheme);
        // Neighbours only show where shared music lies; both are read at once
        // (each read has a fixed cost of seconds), none once the season's
        // theme has placed the credits.
        if (!fromTheme) {
            const references = await Promise.all(neighbours.map((video) => neighbourEnd(job, video, seconds, token).catch((error) => {
                if (error instanceof Cancelled) throw error;
                return null;
            })));
            for (const reference of references.filter(Boolean)) {
                (await compute.match(played, reference, CREDITS_MATCH)).forEach((match) => evidence.creditsRepetition.push(asCredits(played, match, 1)));
            }
        }
        refresh();
        const credits = creditsOf();
        // Starting at the edge of what was read: they may start earlier.
        if (credits && credits.start <= played.from + 5 && seconds < CREDITS_WINDOWS[CREDITS_WINDOWS.length - 1]) continue;
        return { played, credits: credits || null };
    }
    return { played, credits: null };
}

async function findCredits(job, mediaUrl, duration, token, evidence, refresh, options) {
    if (!Number.isFinite(duration)) return;
    const picture = Boolean(options && options.picture);
    const heavy = Boolean(options && options.heavy);
    const theme = await store.getCreditsTheme(job.metaId, job.season);
    // Other episodes' credits lengths: one about as long as this file stands
    // in when nothing is seen (fusion), and all of them back a start that
    // gives the same length.
    evidence.creditsLengths = await store.getCreditsLengths(job.metaId, job.season);
    evidence.creditsLength = nearestLength(evidence.creditsLengths, duration);
    refresh();
    const { played, credits } = await creditsFromAudio(job, mediaUrl, duration, token, evidence, refresh, theme);
    check(token);
    let pictureFailed = false;

    if (picture && (await store.getPictureMisses(job.metaId, job.season)) < PICTURE_MISS_LIMIT) {
        const { from, to } = pictureWindow(duration, credits, evidence.creditsLength, heavy);
        // A debrid host stalls now and then; one more try usually gets through.
        let found = null;
        for (let attempt = 0; attempt < 2 && found === null; attempt++) {
            found = await findPictureCredits({
                mediaUrl,
                duration,
                from,
                to,
                widen: !heavy,
                read: (fetcher) => withRead(token, fetcher),
                check: () => check(token),
            });
        }
        // An older launcher, or reads that failed: nothing learned, and the
        // file is looked at again next time (see the end).
        pictureFailed = found === null;
        if (found) {
            evidence.creditsPicture = { run: found.run, device: found.device };
            // Where the story really ends: names often run over the last
            // scene while it still plays.
            const story = await findStoryEnd(mediaUrl, duration, found, token, { playedUrl: options && options.playedUrl, reference: played });
            if (story) evidence.creditsPicture.story = story;
            // Only a look that could see credits over footage counts as a miss.
            if (found.run || found.device) {
                await store.setPictureMisses(job.metaId, job.season, found.run ? 0 : (await store.getPictureMisses(job.metaId, job.season)) + 1);
            }
        }
        refresh();
    }

    const fused = fuse({ ...evidence, duration }).find((segment) => segment.type === 'credits') || null;
    // Where the credits themselves start (the first card), which can be
    // before where they are offered (the story end): lengths and the theme
    // are learned from it.
    const pictureRun = evidence.creditsPicture && evidence.creditsPicture.run;
    const creditsStart = fused && pictureRun && fused.sources.includes('picture') ? Math.min(fused.start, pictureRun.start) : fused && fused.start;
    // Seen in this file to the end, or certain: how long this season's
    // credits run (never from the fallback, which only repeats a length).
    const seen = evidence.creditsPicture && evidence.creditsPicture.run && evidence.creditsPicture.run.runsOut === true;
    if (fused && (fused.confidence === 'high' || seen) && !(fused.sources.length === 1 && fused.sources[0] === 'season-length')) {
        await store.addCreditsLength(job.metaId, job.season, { seconds: duration - creditsStart, duration });
    }
    // The season's credits music, cut from where the credits start in this
    // file, for later episodes (creditsFromTheme).
    if (played && credits && fused && fused.sources.includes('audio') && (!theme || !theme.confirmed || fused.confidence === 'high')) {
        const from = Math.max(0, Math.round((creditsStart - played.from) * FRAMES_PER_SECOND));
        const to = Math.round((Math.min(creditsStart + CREDITS_THEME_SECONDS, credits.end) - played.from) * FRAMES_PER_SECOND);
        if (to - from >= 8 * FRAMES_PER_SECOND) {
            await store.setCreditsTheme(job.metaId, job.season, {
                hashes: played.hashes.slice(from, to),
                valid: played.valid.slice(from, to),
                seconds: (to - from) / FRAMES_PER_SECOND,
                confirmed: fused.confidence === 'high',
                // What follows the theme to the end of this file.
                tail: duration - (played.from + to / FRAMES_PER_SECOND),
            });
        }
    }
    if (pictureFailed) throw new Error('could not read the picture for the credits');
}

// ── The intro's last frame ──────────────────────────────────────────────────

// The audio places the end of the intro to within a few tenths of a second
// of where its music stops, but the episode often starts a moment later,
// after a black gap or a creator credit. A few seconds of the file around
// that end show where (see landingAfter); unnamed chapter marks often sit
// inside such a gap too. `known` is an earlier refinement of this same end,
// which saves reading it again.
const CUTS_BEFORE = 1.5;
const CUTS_SECONDS = 7;

async function refineEnd(mediaUrl, segments, known, token) {
    const intro = segments.find((segment) => segment.type === 'intro');
    // A chapter named for the intro is the release's own exact boundary.
    if (!intro || intro.sources.includes('chapter')) return { segments, endCut: null };
    const withEnd = (to) => segments.map((segment) => (segment === intro ? { ...segment, end: to } : segment));
    if (known && Math.abs(known.at - intro.end) < 0.05) return { segments: withEnd(known.to), endCut: known };
    // A debrid host stalls now and then; one more try usually gets through.
    let scene = null;
    for (let attempt = 0; attempt < 2 && scene === null; attempt++) {
        scene = await withRead(token, (signal) => fetchSceneCuts(mediaUrl, Math.max(0, intro.end - CUTS_BEFORE), CUTS_SECONDS, signal));
        check(token);
    }
    if (!scene) return { segments, endCut: null };
    const endCut = { at: intro.end, to: landingAfter(intro.end, scene) };
    return { segments: withEnd(endCut.to), endCut };
}

async function prepareAhead(job, token) {
    const theme = await store.getTheme(job.metaId, job.season);
    const creditsTheme = await store.getCreditsTheme(job.metaId, job.season);
    if (!theme && !creditsTheme) return;
    for (const video of episodesAhead(job.videos, job.videoId).slice(0, AHEAD_LIMIT)) {
        await idle(token);
        const streams = await fetchEpisodeStreams(job.transportUrl, job.type, video.id);
        const likely = likelyNext(job, streams);
        if (!likely) continue;
        const fileKey = fileKeyOf(likely);
        // Done, or its intro already found: nothing to prepare. A result
        // without one (the season search was off when it was made) gets the
        // theme looked for, keeping what else it has.
        const existing = await store.getResult(video.id, fileKey);
        if (existing && (existing.complete || existing.segments.some((segment) => segment.type === 'intro'))) continue;
        const standIn = isHeavy(likely, job.duration) ? lightStandIn(streams, job.duration) : null;
        const source = standIn || likely;
        const info = await fetchChapters(source.url);
        check(token);
        if (!info || !info.duration || info.duration < MIN_EPISODE_SECONDS) continue;
        // Not final: chapters and databases are still checked when it plays,
        // and times read from a stand-in are lined up with the real file then.
        const evidence = { duration: info.duration, chapters: standIn ? null : info, repetition: [], creditsRepetition: [], standIn: Boolean(standIn), offset: null };
        if (theme) {
            const fingerprint = await ensureFingerprint(video.id, fileKeyOf(source), source.url, theme.window || WINDOW_SECONDS, token);
            const match = fingerprint && hasAudio(fingerprint) ? await matchTheme(fingerprint, theme) : null;
            if (match) evidence.repetition.push(match);
        }
        if (creditsTheme) {
            const end = await endFingerprint(source.url, info.duration, CREDITS_WINDOWS[0], token, video.id, fileKeyOf(source));
            const credits = end ? await creditsFromTheme(end, info.duration, creditsTheme) : null;
            if (credits) evidence.creditsRepetition.push(credits);
        }
        if (evidence.repetition.length === 0 && evidence.creditsRepetition.length === 0) continue;
        const prepared = fuseForPlayback(evidence);
        const { segments, endCut } = standIn ? { segments: prepared, endCut: null } : await refineEnd(likely.url, prepared, null, token);
        const kept = existing ? existing.segments.filter((segment) => !segments.some((other) => other.type === segment.type)) : [];
        await store.setResult(video.id, fileKey, { segments: segments.concat(kept), complete: false, endCut });
    }
}

// The file the next episode will likely be played from. Next episode always
// goes through the streams page, so that is Auto-Pick's choice when it is on
// (from this addon's list; the real Auto-Pick also weighs other addons, so
// usually rather than always), else the release this one came from.
function likelyNext(job, streams) {
    const settings = getPlayableAutoPickSettings(job.type, job.metaId);
    const picked = settings ? pickBestStream(streams, settings) : null;
    if (picked && isReadable(picked)) return picked;
    const [sameRelease] = pickReferenceStreams(streams, { like: job.stream, limit: 1 });
    return sameRelease || null;
}

async function run(job, token) {
    const fileKey = fileKeyOf(job.stream);
    const key = keyFor(job.videoId, job.stream);
    const settings = getSkipSettings();
    const cached = await store.getResult(job.videoId, fileKey);
    check(token);
    if (cached) publish(key, { status: cached.complete ? 'done' : 'working', segments: cached.segments });

    if (!cached || !cached.complete) {
        const evidence = { duration: job.duration, chapters: null, database: null, repetition: [], localDone: false };
        // An intro found ahead of time in this same file (prepareAhead) is
        // kept when this analysis brings none of its own: the season search
        // can be off, or a read can fail, and the prepared intro was right.
        const preparedIntro = cached && !cached.complete ? cached.segments.find((segment) => segment.type === 'intro') || null : null;
        const withPrepared = (segments) => (preparedIntro && !segments.some((segment) => segment.type === 'intro') ? [preparedIntro, ...segments] : segments);
        // A prepared result stays on screen until fresh evidence replaces it.
        const refresh = () => {
            const segments = withPrepared(fuseForPlayback(evidence));
            if (segments.length > 0 || !cached) publish(key, { status: 'working', segments });
        };
        const mediaUrl = resolveMediaUrl(job.streamingServerUrl, job.stream).then((media) => media.url);
        // Misses stop the search for a season that shows no intro. Once two
        // episodes were found to share one (the season's theme), it is always
        // looked for (one read of this file): some episodes cut it short or
        // leave it out (Two and a Half Men) without the others losing theirs.
        const seasonTheme = Number.isFinite(job.season) ? await store.getTheme(job.metaId, job.season) : null;
        const audioWanted = settings.backgroundAnalysis && job.type === 'series' && Number.isFinite(job.season)
            && (Boolean(seasonTheme) || (await store.getSeasonMisses(job.metaId, job.season)) < SEASON_MISS_LIMIT);
        let audioDone = !audioWanted;
        const chaptersRead = mediaUrl.then(fetchChapters).then((chapters) => { evidence.chapters = chapters; refresh(); });
        const work = [chaptersRead];
        if (settings.useDatabases) {
            work.push(databaseAnswer(job).then((answer) => { evidence.database = answer; refresh(); }));
        }
        // The light release read in place of a heavy file, once looked up
        // (undefined: not looked up yet).
        let standInOf;
        const findStandIn = async () => {
            if (standInOf === undefined) {
                standInOf = isHeavy(job.stream, job.duration)
                    ? lightStandIn(await fetchEpisodeStreams(job.transportUrl, job.type, job.videoId), job.duration)
                    : null;
            }
            return standInOf;
        };
        const named = (type) => Boolean(evidence.chapters) && evidence.chapters.named.some((chapter) => chapter.type === type);
        if (audioWanted) {
            work.push((async () => {
                try {
                    if (!(await checkExtractServer())) return;
                    // A chapter named for the intro is exact for this file, and
                    // the probe answers in a few seconds: wait for it before
                    // downloading anything for audio.
                    await Promise.race([chaptersRead.catch(() => null), sleep(CHAPTER_WAIT_MS)]);
                    const playedUrl = await mediaUrl;
                    const standIn = await findStandIn();
                    if (!standIn) {
                        audioDone = named('intro') || await findSharedAudio(job, playedUrl, token, evidence, refresh);
                        return;
                    }
                    evidence.standIn = true;
                    evidence.offset = null;
                    const standInJob = { ...job, stream: standIn };
                    audioDone = named('intro') || await findSharedAudio(standInJob, standIn.url, token, evidence, refresh);
                    const intro = introOf(evidence);
                    const fingerprint = evidence.sourceFingerprint || null;
                    if (intro && fingerprint) {
                        evidence.offset = await offsetOnPlayedFile(playedUrl, fingerprint, intro.start, token).catch(() => null);
                    }
                } catch (error) {
                    if (error instanceof Cancelled) throw error;

                    console.warn('[SkipIntro] audio analysis failed:', error && error.message ? error.message : error);
                }
            })());
        }
        await Promise.allSettled(work);
        check(token);
        // How to look for the credits once the intro is settled and kept.
        // Every episode of a series gets this, whether or not its season has
        // an intro to find; nothing needs the credits until the end.
        let creditsSearch = null;
        const creditsWanted = settings.backgroundAnalysis && job.type === 'series' && Number.isFinite(job.season) && !named('credits');
        if (creditsWanted && await checkExtractServer().catch(() => false)) {
            const playedUrl = await mediaUrl.catch(() => null);
            const standIn = playedUrl ? await findStandIn().catch(() => null) : null;
            if (playedUrl && !standIn) {
                creditsSearch = () => findCredits(job, playedUrl, job.duration, token, evidence, refresh, { picture: true, heavy: isHeavy(job.stream, job.duration) });
            } else if (playedUrl) {
                evidence.creditsStandIn = true;
                creditsSearch = async () => {
                    const info = await fetchChapters(standIn.url);
                    if (info && info.duration) await findCredits({ ...job, stream: standIn }, standIn.url, info.duration, token, evidence, refresh, { picture: true, playedUrl });
                };
            }
        }
        check(token);
        evidence.localDone = audioDone && audioWanted;
        const fused = withPrepared(fuseForPlayback(evidence));
        if (fused.length > 0) publish(key, { status: 'working', segments: fused });
        // Land on the episode's first frame. Times from a stand-in that could
        // not be lined up with this file are not refined against it.
        const settle = async (known) => {
            const now = withPrepared(fuseForPlayback(evidence));
            return evidence.standIn && evidence.offset === null ? { segments: now, endCut: null } : refineEnd(await mediaUrl, now, known, token);
        };
        // The evidence behind the result, for diagnosing a wrong skip.
        const debugOf = (endCut) => ({
            database: evidence.database ? evidence.database.segments : null,
            chapters: evidence.chapters,
            repetition: evidence.repetition,
            standIn: evidence.standIn ? { offset: evidence.offset } : null,
            path: evidence.path || null,
            creditsRepetition: evidence.creditsRepetition || [],
            creditsPicture: evidence.creditsPicture || null,
            endCut,
        });
        let { segments, endCut } = await settle(cached && cached.endCut);
        // The intro is kept as soon as it is settled, so it survives the
        // player closing before the credits are found. An incomplete result
        // is looked at again next time instead of being trusted for weeks.
        await store.setResult(job.videoId, fileKey, { segments, complete: audioDone && !creditsSearch, endCut });
        if (creditsSearch) {
            publish(key, { status: 'working', segments, debug: debugOf(endCut) });
            // A search that failed (the host gave up on a read) is tried
            // again next time instead of leaving the file without credits.
            let creditsDone = true;
            try {
                await creditsSearch();
            } catch (error) {
                if (error instanceof Cancelled) throw error;
                creditsDone = false;
                console.warn('[SkipIntro] credits analysis failed:', error && error.message ? error.message : error);
            }
            check(token);
            ({ segments, endCut } = await settle(endCut));
            await store.setResult(job.videoId, fileKey, { segments, complete: audioDone && creditsDone, endCut });
        }
        publish(key, { status: 'done', segments, debug: debugOf(endCut) });
    }

    if (!job.background && settings.backgroundAnalysis && job.type === 'series') await prepareAhead(job, token);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Start (or keep) analysing the episode being played.
 *
 * @param {{
 *   type: string, metaId: string, videoId: string, season: number | null,
 *   videos: Array<{ id: string, season: number, episode: number }>,
 *   stream: object, transportUrl: string, streamingServerUrl: string, duration: number,
 * }} job - `duration` in seconds; `stream` is the stream being played.
 * @returns {string} the key its results are published under
 */
function watch(job) {
    const key = keyFor(job.videoId, job.stream);
    // Preparing other episodes gives way to the one being played.
    if (background) cancel(background.token);
    if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
    }
    if (active && active.key === key) return key;
    if (active) cancel(active.token);
    const token = newToken();
    active = { key, token };
    run(job, token).catch((error) => {
        if (error instanceof Cancelled) return;

        console.warn('[SkipIntro] analysis failed:', error && error.message ? error.message : error);
        publish(key, { status: 'error' });
    });
    scheduleSweep();
    return key;
}

function scheduleSweep() {
    if (sweepTimer) return;
    sweepTimer = setTimeout(() => {
        store.sweep().catch(() => 0).finally(() => { sweepTimer = null; });
    }, SWEEP_DELAY_MS);
    // Under Node (tests) a pending clean-up must not keep the process alive.
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

// The player closed. Work carries on for a while in case the next episode is
// about to be opened.
function release() {
    // Nothing is playing, so the look-ahead may use the connection freely.
    ready = true;
    if (releaseTimer) clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
        if (active) cancel(active.token);
        active = null;
        releaseTimer = null;
    }, RELEASE_GRACE_MS);
}

// Whether the player can spare the connection for reads right now.
function setReady(value) {
    ready = Boolean(value);
}

/**
 * Prepare an episode nobody is playing yet (Continue Watching): the same
 * analysis, only while no player is open or still finishing its work, and
 * cancelled the moment one starts. One at a time.
 *
 * @returns {Promise<boolean>} whether it ran to the end
 */
async function prepare(job) {
    if (active || background) return false;
    const token = newToken();
    background = { token };
    try {
        await run({ ...job, background: true }, token);
        return true;
    } catch (error) {
        if (!(error instanceof Cancelled)) console.warn('[SkipIntro] preparing failed:', error && error.message ? error.message : error);
        return false;
    } finally {
        background = null;
    }
}

// Whether a player's analysis or a preparation is under way.
const isBusy = () => Boolean(active || background);

function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

const getResult = (key) => results.get(key) || null;

module.exports = {
    keyFor,
    watch,
    release,
    setReady,
    subscribe,
    getResult,
    prepare,
    isBusy,
};
