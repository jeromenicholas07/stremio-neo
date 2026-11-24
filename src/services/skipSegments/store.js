// IndexedDB persistence for Skip Intro: fingerprints, per-file results,
// database answers and the per-season theme fingerprint.

const idb = require('../../common/idbKeyval');

const DB_NAME = 'skip-segments';
const STORE_NAME = 'kv';

const DAY_MS = 24 * 60 * 60 * 1000;
const RESULT_MAX_AGE_MS = 60 * DAY_MS;
const DATABASE_HIT_MAX_AGE_MS = 7 * DAY_MS;
const DATABASE_MISS_MAX_AGE_MS = DAY_MS;

const get = (key) => idb.get(DB_NAME, STORE_NAME, key);
const set = (key, value) => idb.set(DB_NAME, STORE_NAME, key, value);

// Bump when detection changes, so results and season themes worked out by an
// older version are found again instead of trusted for weeks. Fingerprints
// and database answers do not depend on it.
// 3: season misses no longer counted on failed reads, preamble search.
const ALGORITHM = 3;

// One fingerprint per file of an episode: { fileKey, seconds, hashes, valid }.
// Per file, because the look-ahead prepares the two files the next episode
// is likely to be played from. Up to 900 s of one is ~70 KB, so they are
// capped by count and age (see sweep), which needs to know when each was
// written: an index of "videoId|fileKey" -> time, updated one write at a
// time so parallel reads do not lose entries.
const FINGERPRINT_INDEX = 'fp-index';
let indexChain = Promise.resolve();
const withIndex = (change) => {
    indexChain = indexChain.then(async () => {
        const index = (await get(FINGERPRINT_INDEX)) || {};
        await set(FINGERPRINT_INDEX, change(index) || index);
    }).catch(() => null);
    return indexChain;
};
const getFingerprint = (videoId, fileKey) => get(`fp|${videoId}|${fileKey}`);
// The newest fingerprint of any file of an episode: any release serves as a
// neighbour to compare with.
async function getAnyFingerprint(videoId) {
    const index = (await get(FINGERPRINT_INDEX)) || {};
    const [newest] = Object.entries(index)
        .filter(([entry]) => entry.startsWith(`${videoId}|`))
        .sort((a, b) => b[1] - a[1]);
    return newest ? get(`fp|${newest[0]}`) : undefined;
}
async function setFingerprint(videoId, fingerprint) {
    await set(`fp|${videoId}|${fingerprint.fileKey}`, fingerprint);
    await withIndex((index) => { index[`${videoId}|${fingerprint.fileKey}`] = Date.now(); });
}

// The intro's own fingerprint for a season, cut from an episode where it was
// found: { hashes, valid, seconds, confirmed }.
const getTheme = (metaId, season) => get(`theme${ALGORITHM}|${metaId}|${season}`);
const setTheme = (metaId, season, theme) => set(`theme${ALGORITHM}|${metaId}|${season}`, { ...theme, at: Date.now() });

// The same for the end credits' music: { hashes, valid, seconds, confirmed }.
const getCreditsTheme = (metaId, season) => get(`ctheme${ALGORITHM}|${metaId}|${season}`);
const setCreditsTheme = (metaId, season, theme) => set(`ctheme${ALGORITHM}|${metaId}|${season}`, { ...theme, at: Date.now() });

// How long the credits ran in episodes of a season where they were certain:
// the last few { seconds, duration }, newest last.
const KEEP_CREDITS_LENGTHS = 6;
async function getCreditsLengths(metaId, season) {
    const entry = await get(`clen${ALGORITHM}|${metaId}|${season}`);
    return entry && Array.isArray(entry.samples) ? entry.samples : [];
}
async function addCreditsLength(metaId, season, sample) {
    const samples = (await getCreditsLengths(metaId, season))
        .filter((other) => Math.abs(other.duration - sample.duration) > 1)
        .concat([sample])
        .slice(-KEEP_CREDITS_LENGTHS);
    await set(`clen${ALGORITHM}|${metaId}|${season}`, { samples, at: Date.now() });
}

// Results belong to one file: another release of the same episode can be cut
// differently.
// The credits search a result was made with (3: offered where the story
// ends, by speech and the picture after the credits). One from an older search is
// shown but looked at again: the old one skipped seasons without an intro
// and credits over footage, and called those files done.
// 4: a stand-in the same length as the played file counts as lined up, so its
// story end can be advanced on. Only search-3 results whose story end was
// "seen" (auto-next off) are looked at again; the rest are still current.
const CREDITS_SEARCH = 4;
// The intro search likewise: before 2, two episodes with a cut-down title
// sequence switched the search off for the whole season, theme or not, so
// a result without an intro from then is looked at again.
const INTRO_SEARCH = 2;
async function getResult(videoId, fileKey) {
    const result = await get(`res${ALGORITHM}|${videoId}|${fileKey}`);
    if (!result || Date.now() - result.at >= RESULT_MAX_AGE_MS) return null;
    const introStale = result.intro !== INTRO_SEARCH && !result.segments.some((segment) => segment.type === 'intro');
    const seen = result.segments.some((segment) => segment.type === 'credits' && segment.story === 'seen');
    const creditsCurrent = result.credits === CREDITS_SEARCH || (result.credits === 3 && !seen);
    return creditsCurrent && !introStale ? result : { ...result, complete: false };
}
const setResult = (videoId, fileKey, result) => set(`res${ALGORITHM}|${videoId}|${fileKey}`, { ...result, credits: CREDITS_SEARCH, intro: INTRO_SEARCH, at: Date.now() });

async function getDatabaseAnswer(videoId) {
    const answer = await get(`db|${videoId}`);
    if (!answer) return null;
    const maxAge = answer.segments.length > 0 ? DATABASE_HIT_MAX_AGE_MS : DATABASE_MISS_MAX_AGE_MS;
    return Date.now() - answer.at < maxAge ? answer : null;
}
const setDatabaseAnswer = (videoId, answer) => set(`db|${videoId}`, { ...answer, at: Date.now() });

// How many episodes of a season were compared without finding shared audio.
// Shows without a recurring intro would otherwise be re-read on every episode.
// Versioned too: older versions also counted reads that had failed.
const SEASON_MISS_MAX_AGE_MS = 30 * DAY_MS;
async function getSeasonMisses(metaId, season) {
    const misses = await get(`miss${ALGORITHM}|${metaId}|${season}`);
    return misses && Date.now() - misses.at < SEASON_MISS_MAX_AGE_MS ? misses.count : 0;
}
const setSeasonMisses = (metaId, season, count) => set(`miss${ALGORITHM}|${metaId}|${season}`, { count, at: Date.now() });

// How many episodes of a season the picture showed no credits for, since
// the text detector (`tmiss`; the dark-frame test's old `pmiss` counts are
// dropped, they counted credits over footage the detector now sees). After
// a few, frames are not read for it for a while.
async function getPictureMisses(metaId, season) {
    const misses = await get(`tmiss${ALGORITHM}|${metaId}|${season}`);
    return misses && Date.now() - misses.at < SEASON_MISS_MAX_AGE_MS ? misses.count : 0;
}
const setPictureMisses = (metaId, season, count) => set(`tmiss${ALGORITHM}|${metaId}|${season}`, { count, at: Date.now() });

// ── Clean-up ────────────────────────────────────────────────────────────────

// Without this the store only grows: every episode ever analysed keeps its
// fingerprint, and each version bump leaves the last version's keys behind.
const KEEP_FINGERPRINTS = 300;
const FINGERPRINT_MAX_AGE_MS = 90 * DAY_MS;
const THEME_MAX_AGE_MS = 180 * DAY_MS;
const SWEEP_EVERY_MS = DAY_MS;
const SWEEP_AT = 'sweep-at';

const maxAgeOf = (key, value) => {
    if (key.startsWith(`res${ALGORITHM}|`)) return RESULT_MAX_AGE_MS;
    if (key.startsWith(`miss${ALGORITHM}|`) || key.startsWith(`tmiss${ALGORITHM}|`)) return SEASON_MISS_MAX_AGE_MS;
    if (key.startsWith(`theme${ALGORITHM}|`) || key.startsWith(`ctheme${ALGORITHM}|`) || key.startsWith(`clen${ALGORITHM}|`)) return THEME_MAX_AGE_MS;
    if (key.startsWith('db|')) return value && value.segments && value.segments.length > 0 ? DATABASE_HIT_MAX_AGE_MS : DATABASE_MISS_MAX_AGE_MS;
    return null;
};

/**
 * Drop what is expired, left over from an older version, or beyond the
 * fingerprint cap. Runs at most once a day; returns how many keys went.
 */
async function sweep(now = Date.now()) {
    const last = await get(SWEEP_AT);
    if (typeof last === 'number' && now - last < SWEEP_EVERY_MS) return 0;
    await set(SWEEP_AT, now);
    const all = await idb.keys(DB_NAME, STORE_NAME);
    const drop = [];
    let keptFingerprints = 0;
    await withIndex((index) => {
        const tracked = new Set();
        Object.entries(index)
            .sort((a, b) => b[1] - a[1])
            .forEach(([entry, at]) => {
                if (keptFingerprints < KEEP_FINGERPRINTS && now - at < FINGERPRINT_MAX_AGE_MS) {
                    keptFingerprints++;
                    tracked.add(entry);
                } else {
                    delete index[entry];
                }
            });
        // Fingerprints written before the index existed, or dropped above.
        all.filter((key) => typeof key === 'string' && key.startsWith('fp|') && !tracked.has(key.slice(3)))
            .forEach((key) => drop.push(key));
        return index;
    });
    const current = [`res${ALGORITHM}|`, `theme${ALGORITHM}|`, `ctheme${ALGORITHM}|`, `clen${ALGORITHM}|`, `miss${ALGORITHM}|`, `tmiss${ALGORITHM}|`, 'db|', 'fp|', FINGERPRINT_INDEX, SWEEP_AT];
    for (const key of all) {
        if (typeof key !== 'string' || !current.some((prefix) => key === prefix || key.startsWith(prefix))) {
            drop.push(key);
            continue;
        }
        if (key.startsWith('fp|') || key === FINGERPRINT_INDEX || key === SWEEP_AT) continue;
        const value = await get(key);
        const maxAge = maxAgeOf(key, value);
        if (!value || typeof value.at !== 'number' || (maxAge !== null && now - value.at >= maxAge)) drop.push(key);
    }
    await idb.delMany(DB_NAME, STORE_NAME, drop);
    return drop.length;
}

module.exports = {
    sweep,
    getSeasonMisses,
    setSeasonMisses,
    getPictureMisses,
    setPictureMisses,
    getFingerprint,
    getAnyFingerprint,
    setFingerprint,
    getTheme,
    setTheme,
    getCreditsTheme,
    setCreditsTheme,
    getCreditsLengths,
    addCreditsLength,
    getResult,
    setResult,
    getDatabaseAnswer,
    setDatabaseAnswer,
};
