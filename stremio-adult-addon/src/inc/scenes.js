// Studio scenes built from torrent releases.
//
// The torrent side already exists: catalog metas from the addon's own
// handleCatalog (deduped, with a `torrent:<payload>` id whose payload carries
// the raw release name and a #/torrent deep link that does RD / P2P / file
// picking). Here we group those releases into scenes:
//
//   1. ThePornDB ?parse= on the release name. A plausible hit gives the scene
//      id, which is the grouping key (it also tells apart two scenes a studio
//      released on the same day).
//   2. Otherwise a fallback key from the release name: studio + date + the
//      first title words. When unsure, a release stays its own scene.
//
// Rows never wait long for ThePornDB: uncached names are looked up in the
// background and the response says how many are still pending, so the UI
// can refresh the row a few seconds later.

const tpdb = require('./sources/theporndb');
const { base64UrlEncode, base64UrlDecode, cleanName } = require('./titles');
const { hashKey } = require('./store');

const REGISTRY_MAX = 3000;
const CARRIED_RELEASES = 8;
const registry = new Map(); // scene id → { title, releases: Map(releaseKey → release) }

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const TAG_WORDS = /\b(xxx|1080p|720p|2160p|4k|480p|mp4|web|webrip|web dl|prt|galaxxxy|rq|xleech|ktr|p2p|hevc|x265|x264|av1|split scenes|nbq|wrb|xc|sd|hd|fhd|uhd)\b/gi;

function decodePayload(metaId) {
    if (typeof metaId !== 'string' || !metaId.startsWith('torrent:')) return null;
    try { return JSON.parse(base64UrlDecode(metaId.slice('torrent:'.length))); } catch { return null; }
}

function releaseFromMeta(meta) {
    const payload = decodePayload(meta && meta.id) || {};
    const raw = String(payload.title || meta.name || '').split(/\\n|[\r\n]/)[0].trim();
    return {
        // Un-enriched releases share a long common id prefix, so hash the whole id.
        key: meta.infoHash ? `h:${meta.infoHash}` : `m:${hashKey(meta.id).slice(0, 16)}`,
        name: raw || meta.name,
        displayName: meta.name,
        infoHash: meta.infoHash || '',
        seeders: Number(meta.seeders) || 0,
        peers: Number(meta.peers) || 0,
        size: Number(meta.sizeBytes) || 0,
        sizeLabel: meta.size || '',
        quality: meta.quality || '',
        indexer: meta.indexer || '',
        href: meta.deepLinks && meta.deepLinks.player,
        torrentId: meta.id,
    };
}

// "<Studio> yy mm dd <rest>" → { studio, date, body }
function parseName(name) {
    const n = String(name || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
    let m = n.match(/^([A-Za-z0-9]+(?: [A-Z][A-Za-z0-9]+)?) (\d{2}) (\d{2}) (\d{2}) (.+)$/);
    if (m && +m[3] >= 1 && +m[3] <= 12 && +m[4] >= 1 && +m[4] <= 31) {
        return { studio: m[1], date: `20${m[2]}-${m[3]}-${m[4]}`, body: m[5] };
    }
    m = n.match(/^([A-Za-z0-9]+) (.+?) (\d{2}) (\d{2}) (20\d{2})\b/);
    if (m && +m[4] >= 1 && +m[4] <= 12) {
        return { studio: m[1], date: `${m[5]}-${m[4]}-${m[3]}`, body: m[2] };
    }
    return { studio: '', date: '', body: n };
}

function cleanBody(body) {
    return cleanName(String(body || '')
        .replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, ' ')
        .replace(TAG_WORDS, ' ')
        .replace(/[[\](){}]/g, ' ')
        .replace(/(\s[-–]+)+\s*$/g, ' ')
        .replace(/\s-\S*$/g, ' '));
}

function fallbackKey(rel) {
    const p = parseName(rel.name);
    const bodyWords = norm(cleanBody(p.body)).split(' ').filter(Boolean).slice(0, 6).join(' ');
    if (p.studio && p.date) return `${norm(p.studio)}|${p.date}|${bodyWords}`;
    return '';
}

function fallbackTitle(id, rel) {
    const p = parseName(rel.name);
    const body = cleanBody(p.body) || rel.displayName;
    return {
        id,
        kind: 'scene',
        name: body,
        thumbnail: '',
        snapshots: [],
        duration: 0,
        date: p.date,
        studio: p.studio ? p.studio.replace(/([a-z])([A-Z])/g, '$1 $2') : '',
        performers: [],
        tags: [],
        description: '',
    };
}

function remember(title, releases) {
    let entry = registry.get(title.id);
    if (!entry) {
        entry = { title, releases: new Map() };
        registry.set(title.id, entry);
        if (registry.size > REGISTRY_MAX) registry.delete(registry.keys().next().value);
    } else if (title.tpdbId || !entry.title.tpdbId) {
        entry.title = title;
    }
    for (const r of releases) entry.releases.set(r.key, r);
    return entry;
}

function summarize(entry) {
    const releases = [...entry.releases.values()];
    const bestSeeders = releases.reduce((m, r) => Math.max(m, r.seeders), 0);
    const qualities = [...new Set(releases.map((r) => r.quality).filter(Boolean))];
    return {
        ...entry.title,
        releaseCount: releases.length,
        seeders: bestSeeders,
        qualities,
        // The best-seeded releases travel with the title, so a favorite still
        // lists streams after an addon restart (when the registry is empty and
        // a fresh search may not return the same releases).
        releases: releases.slice().sort((a, b) => b.seeders - a.seeders).slice(0, CARRIED_RELEASES),
        searchHint: entry.title.performers && entry.title.performers.length
            ? entry.title.performers.slice(0, 2).join(' ')
            : releases[0] ? cleanBody(parseName(releases[0].name).body).split(' ').slice(0, 5).join(' ') : '',
    };
}

/**
 * Torrent catalog metas → scene titles (best seeded first within the input
 * order). Waits at most `waitMs` for ThePornDB; reports `pending`.
 */
async function build(metas, { waitMs = 2500 } = {}) {
    const releases = (metas || []).map(releaseFromMeta).filter((r) => r.name);
    const cachedResults = await Promise.all(releases.map((r) => tpdb.parseRelease(r.name, { cachedOnly: true })));
    // Kick off the uncached ones (only when a token is set); give them a short window.
    const canLookUp = tpdb.hasToken();
    let anyLive = false;
    const live = cachedResults.map((res, i) => {
        if (res !== undefined || !canLookUp) return Promise.resolve(res);
        anyLive = true;
        return tpdb.parseRelease(releases[i].name);
    });
    let settled = cachedResults;
    if (anyLive) {
        const timeout = new Promise((resolve) => setTimeout(resolve, waitMs, 'timeout'));
        settled = await Promise.all(live.map((p) => Promise.race([p, timeout])));
    }

    const order = [];
    const groups = new Map();
    let pending = 0;
    releases.forEach((rel, i) => {
        const res = settled[i];
        let title;
        if (res && res !== 'timeout') {
            title = res;
        } else {
            if (res === 'timeout') pending++;
            const fk = fallbackKey(rel);
            const id = fk ? `inc:scene:k:${base64UrlEncode(fk)}` : `inc:scene:r:${base64UrlEncode(rel.key)}`;
            title = fallbackTitle(id, rel);
        }
        if (!groups.has(title.id)) { groups.set(title.id, { title, releases: [] }); order.push(title.id); }
        groups.get(title.id).releases.push(rel);
    });

    const titles = order.map((id) => {
        const g = groups.get(id);
        return summarize(remember(g.title, g.releases));
    });
    return { titles, pending };
}

function get(id) {
    const entry = registry.get(id);
    return entry ? summarize(entry) : null;
}

function releasesOf(id) {
    const entry = registry.get(id);
    return entry ? [...entry.releases.values()] : [];
}

const STOP_WORDS = new Set('the a an and of in on with for to my her his your is at by xxx best part'.split(' '));
const words = (s) => norm(s).split(' ').filter((w) => w.length > 2 && !STOP_WORDS.has(w));

// A ThePornDB scene vs a release found by a targeted search. A studio often
// releases several scenes on one day, and the "<Studio> yy mm dd" search
// returns all of them, so a matching date is not enough on its own: the
// release must also name a performer or most of the title.
function daysApart(a, b) {
    const ms = Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`));
    return Number.isFinite(ms) ? ms / 86400000 : Infinity;
}

// TV episodes turn up in general torrent indexes ("… S01E07 … WEB-DL").
const TV_EPISODE = /\bs\d{1,2}\s?e\d{1,3}\b/i;

function knownSceneMatches(scene, rel) {
    if (TV_EPISODE.test(String(rel.name || ''))) return false;
    const name = norm(rel.name);
    const compact = name.replace(/ /g, '');
    const performers = (scene.performers || []).map(norm).filter(Boolean);
    const performerHit = performers.some((p) => name.includes(p) || compact.includes(p.replace(/ /g, '')));
    const perfWords = new Set(words(performers.join(' ')));
    const titleWords = words(scene.name).filter((w) => !perfWords.has(w));
    const have = new Set(name.split(' '));
    const titleRatio = titleWords.length ? titleWords.filter((w) => have.has(w)).length / titleWords.length : 0;
    const relDate = tpdb.releaseDate(rel.name);
    if (relDate && scene.date) {
        // Release groups and ThePornDB often disagree by a day (time zones).
        if (daysApart(relDate, scene.date) <= 1) return performerHit || titleRatio >= 0.5;
        // A re-release or a mis-dated one: only with the performer and nearly
        // the whole title ("HardX 21 05 13 Lena Paul 1st Gangbang" for the
        // 2018 scene). Same-day scenes from one studio never get here.
        return performerHit && titleWords.length >= 2 && titleRatio >= 0.75;
    }
    // Undated release: most of the title, plus a performer when the title is
    // too short to identify the scene alone ("Best of ZZ"). A short title
    // needs every word: half of "1st Gangbang" is just "1st", and "[TUSHY]
    // Lena Paul, Abella Danger {Anal Sharing} (1st June, 2018)" was attached
    // to "Lena Paul 1St Gangbang" as its best-seeded release.
    if (titleRatio < (titleWords.length <= 3 ? 1 : 0.5)) return false;
    if (performerHit) return true;
    // No performer named: the whole title, and a title long enough to mean
    // something ("I Just Want To Love You" took an anime episode, "I Want to
    // Love You Till Your Dying Day S01E07", on 3 of its 4 words).
    return titleWords.length >= 3 && titleRatio === 1;
}

// Does this release belong to the given scene? Used after a targeted search,
// without spending a ThePornDB call per result.
function releaseMatches(scene, rel) {
    // Movie (DVD) releases rarely carry a studio or a date: most of the
    // title's words, and at least two of them, must be in the release name.
    if (scene.kind === 'movie') {
        const want = norm(scene.name).split(' ').filter((w) => w.length > 2 && !/^(the|and|vol|xxx)$/.test(w));
        const have = new Set(norm(rel.name).split(' '));
        const hit = want.filter((w) => have.has(w)).length;
        return want.length >= 2 && hit / want.length >= 0.75;
    }
    if (scene.tpdbId) return knownSceneMatches(scene, rel);
    const fk = fallbackKey(rel);
    if (scene.id.startsWith('inc:scene:k:')) {
        try { return fk === base64UrlDecode(scene.id.slice('inc:scene:k:'.length)); } catch { return false; }
    }
    return false;
}

// Put releases a stored favorite carried back into the registry.
function seed(sceneTitle, releases) {
    const valid = (Array.isArray(releases) ? releases : [])
        .filter((r) => r && typeof r.key === 'string' && typeof r.href === 'string' && r.href.startsWith('#/torrent/'));
    if (!valid.length) return;
    remember(registry.get(sceneTitle.id)?.title || sceneTitle, valid);
}

function addReleases(sceneTitle, metas) {
    const rels = (metas || []).map(releaseFromMeta).filter((r) => releaseMatches(sceneTitle, r));
    const entry = remember(registry.get(sceneTitle.id)?.title || sceneTitle, rels);
    return [...entry.releases.values()];
}

module.exports = { build, get, releasesOf, addReleases, seed, releaseFromMeta, parseName, fallbackKey, releaseMatches };
