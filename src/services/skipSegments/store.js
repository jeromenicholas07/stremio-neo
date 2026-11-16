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

// Results belong to one file: another release of the same episode can be cut
// differently.
async function getResult(videoId, fileKey) {
    const result = await get(`res${ALGORITHM}|${videoId}|${fileKey}`);
    return result && Date.now() - result.at < RESULT_MAX_AGE_MS ? result : null;
}
const setResult = (videoId, fileKey, result) => set(`res${ALGORITHM}|${videoId}|${fileKey}`, { ...result, at: Date.now() });

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

// How many episodes of a season the picture showed no credit roll for (the
// credits run over footage). After a couple, frames are not read for it.
async function getPictureMisses(metaId, season) {
    const misses = await get(`pmiss${ALGORITHM}|${metaId}|${season}`);
    return misses && Date.now() - misses.at < SEASON_MISS_MAX_AGE_MS ? misses.count : 0;
}
const setPictureMisses = (metaId, season, count) => set(`pmiss${ALGORITHM}|${metaId}|${season}`, { count, at: Date.now() });

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
    if (key.startsWith(`miss${ALGORITHM}|`) || key.startsWith(`pmiss${ALGORITHM}|`)) return SEASON_MISS_MAX_AGE_MS;
    if (key.startsWith(`theme${ALGORITHM}|`) || key.startsWith(`ctheme${ALGORITHM}|`)) return THEME_MAX_AGE_MS;
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
    const current = [`res${ALGORITHM}|`, `theme${ALGORITHM}|`, `ctheme${ALGORITHM}|`, `miss${ALGORITHM}|`, `pmiss${ALGORITHM}|`, 'db|', 'fp|', FINGERPRINT_INDEX, SWEEP_AT];
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
    getResult,
    setResult,
    getDatabaseAnswer,
    setDatabaseAnswer,
};
