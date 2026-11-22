// Rows, titles, streams and search for the Incognito catalog.
//
// Row ids:
//   favorites          your ♥ titles (served from favorites.json by api.js)
//   scenes:new         newest studio scenes (ThePornDB, clip stores left out)
//   scenes:available   studio scenes built from torrent releases (all playable)
//   movies             full movies (ThePornDB)
//   perf:<name>        a performer's filmography (ThePornDB)
//   studio:<name>      a studio's catalogue (ThePornDB)
//   tag:<name>         a category (ThePornDB search)
//   amateur            tube videos, Eporner + RedTube merged (the bonus row)
//   claude             Claude's weekly picks turned into titles (taste.js)
//   foryou             "More like what you like", from favorites + plays
const { LRUCache } = require('lru-cache');
const { handleCatalog } = require('../catalog');
const eporner = require('./sources/eporner');
const redtube = require('./sources/redtube');
const tpdb = require('./sources/theporndb');
const scenes = require('./scenes');
const relay = require('./relay');
const streamsOut = require('./streams');
const store = require('./store');
const { checkCached } = require('../rd');
const { liveSwarm } = require('./scrape');
const taste = require('./taste');
const { mapLimit } = require('./net');

const TUBE = { ep: eporner, rt: redtube };
const rowCache = new LRUCache({ max: 300 });
const ROW_TTL_MS = 20 * 60 * 1000;
const PENDING_TTL_MS = 15 * 1000;
const titleCache = new LRUCache({ max: 5000 });

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function remember(titles) {
    for (const t of titles) if (t && t.id) titleCache.set(t.id, t);
    return titles;
}

async function safe(p) {
    try { return await p; } catch { return []; }
}

// Merge tube lists from several sites: interleave so neither site dominates,
// and fold the same video found on both into one title (`alsoOn`).
function mergeTube(lists) {
    const out = [];
    const byKey = new Map();
    const max = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < max; i++) {
        for (const list of lists) {
            const t = list[i];
            if (!t) continue;
            const key = norm(t.name);
            const twin = key && byKey.get(key);
            if (twin && Math.abs((twin.duration || 0) - (t.duration || 0)) <= 3) {
                twin.alsoOn = twin.alsoOn || [];
                if (!twin.alsoOn.some((x) => x.site === t.site)) {
                    twin.alsoOn.push({ site: t.site, siteId: t.siteId, siteName: t.siteName });
                }
                continue;
            }
            if (key) byKey.set(key, t);
            out.push(t);
        }
    }
    return out;
}

// Short clips (RedTube's weekly most-viewed is full of 30-second ones) make
// poor catalog rows.
const MIN_ROW_DURATION_S = 240;
const fullLength = (list) => list.filter((t) => !t.duration || t.duration >= MIN_ROW_DURATION_S);

// Newest releases first (by the date in the release name), then seeders, and
// only the top slice: every name costs a ThePornDB lookup the first time.
const SCENE_ROW_RELEASES = 80;
function newestFirst(metas) {
    const seen = new Set();
    const uniq = [];
    for (const m of metas || []) {
        const key = m && (m.infoHash || m.id);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        uniq.push(m);
    }
    const dated = uniq.map((m) => ({ m, d: scenes.parseName(scenes.releaseFromMeta(m).name).date || '' }));
    dated.sort((a, b) => b.d.localeCompare(a.d) || (Number(b.m.seeders) || 0) - (Number(a.m.seeders) || 0));
    return dated.slice(0, SCENE_ROW_RELEASES).map((x) => x.m);
}

async function sceneRow(metas) {
    const { titles, pending } = await scenes.build(newestFirst(metas));
    // Scenes ThePornDB knows (artwork, performers) lead; the rest follow.
    const known = titles.filter((t) => t.tpdbId);
    const raw = titles.filter((t) => !t.tpdbId);
    return { titles: await rowWithLiveCounts([...known, ...raw]), pending };
}

// The torrent "latest" feed depends on Prowlarr and is often empty; the fast
// direct sources answer studio-name searches well, so "latest studio scenes"
// is built from the big studios' newest releases.
const STUDIOS = ['Brazzers', 'Blacked', 'Vixen', 'Tushy', 'BangBros', 'RealityKings', 'TeamSkeet', 'NaughtyAmerica'];

// Tube rows are the "amateur & clips" bonus; full-length studio work comes
// from ThePornDB.
async function tubeRow(sort, page, { query = '', tag = '' } = {}) {
    const [a, b] = await Promise.all([
        safe(eporner.list({ sort, page, query: query || tag })),
        safe(redtube.list({ sort, page, query, tag })),
    ]);
    return { titles: fullLength(mergeTube([b, a])), pending: 0 };
}

// Torrent-first studio scenes: every card has releases behind it.
async function availableScenes(page) {
    if (page > 1) return { titles: [], pending: 0 };
    const results = await Promise.all(STUDIOS.map((s) => safe(handleCatalog('adult-search', { search: s }))));
    return sceneRow(results.flatMap((r) => (r && r.metas) || []));
}

// ThePornDB sometimes lists one scene twice (once per site that sells it):
// same title, same day. Keep the first.
function dedupeScenes(titles) {
    const seen = new Set();
    return titles.filter((t) => {
        if (!t) return false;
        const key = t.kind === 'tube' ? t.id : `${norm(t.name)}|${t.date || ''}`;
        if (seen.has(key) || seen.has(t.id)) return false;
        seen.add(key);
        seen.add(t.id);
        return true;
    });
}

function tpdbRow(result) {
    return { titles: dedupeScenes((result && result.titles) || []), pending: 0, total: result && result.total };
}

// A performer's or studio's row: their ThePornDB filmography, plus (on the
// first page) the scenes one torrent search finds for them. Scenes with
// torrents are listed first, so a filmography that starts with brand-new,
// not-yet-torrented scenes still opens on something playable.
async function indexRowWithTorrents(listing, query, page) {
    const [idx, torrents] = await Promise.all([
        safe(listing),
        page === 1 ? safe(handleCatalog('adult-search', { search: query })) : Promise.resolve(null),
    ]);
    let found = [];
    let pending = 0;
    if (torrents && torrents.metas && torrents.metas.length) {
        const built = await scenes.build(newestFirst(torrents.metas), { waitMs: 1500 });
        found = built.titles.filter((t) => t.tpdbId);
        pending = built.pending;
    }
    const titles = dedupeScenes([...(await rowWithLiveCounts(found)), ...((idx && idx.titles) || [])]);
    return { titles, pending, total: idx && idx.total, availableFirst: true };
}

// ── Recommendation rows ──────────────────────────────────────
//
// A pick names a performer, studio, category, search or scene; it becomes a
// few real titles (playable ones first), each carrying the pick's reason.
// Picks are interleaved so the front of the row shows one title per pick,
// in the order given (the picks file is ordered by confidence).
const PER_PICK = 3;
const PLAYABLE_SEEDERS = 5;
const playable = (t) => t && t.releaseCount > 0 && t.seeders >= PLAYABLE_SEEDERS;
// A pick's torrent search can take a minute cold (all indexers). Past this
// budget the row answers with the ThePornDB titles alone and says it is
// pending; the search keeps going (handleCatalog caches it for 3 h), so the
// UI's follow-up fetch gets the playable-first order.
const PICK_BUDGET_MS = 6000;
const withinBudget = (promise, fallback) => {
    promise.catch(() => { /* the fallback already answered */ });
    return Promise.race([promise, new Promise((r) => setTimeout(() => r(null), PICK_BUDGET_MS))])
        .then((v) => v || fallback());
};

async function resolvePick(pick) {
    const hasIndex = tpdb.hasToken();
    const v = pick.value;
    let listing = null;
    if (hasIndex) {
        if (pick.kind === 'performer') listing = tpdb.performerScenes(v, 1);
        else if (pick.kind === 'studio') listing = tpdb.siteScenes(v, 1);
        else listing = tpdb.searchScenes(v, 1);
    }
    const query = pick.kind === 'scene' && pick.studio ? `${pick.studio} ${v}` : v;
    let result;
    if (listing) {
        result = await withinBudget(indexRowWithTorrents(listing, query, 1),
            async () => ({ ...tpdbRow(await safe(listing)), pending: 1 }));
    } else {
        result = await withinBudget(
            safe(handleCatalog('adult-search', { search: query })).then((t) => sceneRow((t && t.metas) || [])),
            async () => ({ titles: [], pending: 1 }));
    }
    let titles = withAvailability(result.titles || []);
    if (pick.kind === 'scene') {
        // A named scene: the titles that actually carry that name, or none.
        const want = norm(v);
        titles = titles.filter((t) => norm(t.name).includes(want) || want.includes(norm(t.name)));
        if (pick.studio) {
            const s = norm(pick.studio);
            const sameStudio = titles.filter((t) => norm(t.studio).includes(s) || norm(t.studioShort).includes(s.replace(/ /g, '')));
            if (sameStudio.length) titles = sameStudio;
        }
        titles = titles.slice(0, 1);
    }
    titles = [...titles.filter(playable), ...titles.filter((t) => !playable(t))];
    return { titles: titles.map((t) => ({ ...t, reason: pick.reason })), pending: result.pending || 0 };
}

async function recommendationRow(picks, perPick = PER_PICK) {
    const resolved = await mapLimit(picks, 3, resolvePick);
    const lists = resolved.map((r) => (r ? r.titles : []));
    const seen = taste.seenIds();
    // Round-robin, up to perPick titles per pick; already favorited or played
    // titles are skipped, and a title two picks share is listed once.
    const out = [];
    const used = new Set();
    for (let round = 0; round < perPick; round++) {
        for (const list of lists) {
            const t = list.find((x) => !used.has(x.id) && !seen.has(x.id));
            if (!t) continue;
            used.add(t.id);
            out.push(t);
        }
    }
    const pending = resolved.reduce((n, r) => n + ((r && r.pending) || 0), 0);
    return { titles: dedupeScenes(out), pending };
}

function signalPicks() {
    return taste.localSignals().map((s) => ({
        kind: s.kind,
        value: s.name,
        studio: '',
        reason: s.kind === 'tag' ? `More from “${s.name}”, a category that keeps coming up in what you watch`
            : `Because ${s.name} keeps coming up in your favorites and plays`,
    }));
}

async function computeRow(rowId, page) {
    const hasIndex = tpdb.hasToken();
    if (rowId === 'claude' || rowId === 'foryou') {
        if (page > 1) return { titles: [], pending: 0 };
        const picks = rowId === 'claude' ? ((taste.readPicks() || {}).picks || []) : signalPicks();
        if (!picks.length) return { titles: [], pending: 0 };
        // The picks run (or a play) is a good moment to refresh the snapshot.
        if (rowId === 'claude') taste.exportTaste();
        return recommendationRow(picks);
    }
    if (rowId === 'scenes:new') {
        return hasIndex ? tpdbRow(await safe(tpdb.latestScenes(page))) : availableScenes(page);
    }
    if (rowId === 'scenes:available' || rowId === 'scenes:latest') return availableScenes(page);
    if (rowId === 'movies') return tpdbRow(await safe(tpdb.movies(page)));
    if (rowId.startsWith('perf:')) {
        const name = rowId.slice(5);
        if (hasIndex) return indexRowWithTorrents(tpdb.performerScenes(name, page), name, page);
        const torrents = await safe(handleCatalog('adult-search', { search: name, skip: String((page - 1) * 100) }));
        return sceneRow((torrents && torrents.metas) || []);
    }
    if (rowId.startsWith('studio:')) {
        const studio = rowId.slice(7);
        if (hasIndex) return indexRowWithTorrents(tpdb.siteScenes(studio, page), studio, page);
        const res = await safe(handleCatalog('adult-search', { search: studio, skip: String((page - 1) * 100) }));
        return sceneRow((res && res.metas) || []);
    }
    if (rowId.startsWith('tag:')) {
        const tag = rowId.slice(4);
        // ThePornDB's tag filter doesn't take names, so a category is a search.
        if (hasIndex) return tpdbRow(await safe(tpdb.searchScenes(tag, page)));
        return tubeRow('trending', page, { tag });
    }
    if (rowId === 'amateur' || rowId === 'trending') return tubeRow('trending', page);
    if (rowId === 'latest') return tubeRow('latest', page);
    if (rowId === 'top') return tubeRow('top', page);
    return { titles: [], pending: 0 };
}

// Mark ThePornDB titles we've already seen releases for ("▲ seeders"), so
// playable scenes stand out in full-catalogue rows.
function withAvailability(titles) {
    return titles.map((t) => {
        if (!t || t.kind !== 'scene' || !t.tpdbId) return t;
        const known = scenes.get(t.id);
        return known && known.releaseCount ? { ...t, releaseCount: known.releaseCount, seeders: known.seeders, qualities: known.qualities } : t;
    });
}

async function row(rowId, page = 1) {
    // New picks (a new generatedAt) get a fresh cache entry at once.
    const version = rowId === 'claude' ? `@${(taste.readPicks() || {}).generatedAt || ''}` : '';
    const key = `${rowId}${version}|${page}`;
    const hit = rowCache.get(key);
    const result = hit || await computeRow(rowId, page);
    if (!hit) {
        remember(result.titles);
        // Rows still waiting on ThePornDB are cached only briefly so the UI's
        // follow-up fetch picks up the filled-in artwork.
        if (result.titles.length) rowCache.set(key, result, { ttl: result.pending ? PENDING_TTL_MS : ROW_TTL_MS });
    }
    let titles = withAvailability(result.titles);
    if (result.availableFirst) {
        // Stable: playable scenes first, each group keeps its own order.
        // Playable = a release with enough live seeders to start (same bar
        // as auto-pick on the title page).
        titles = [...titles.filter(playable), ...titles.filter((t) => !playable(t))];
    }
    if (rowId === 'claude' || rowId === 'foryou') {
        // A title played since the row was cached drops out now.
        const seen = taste.seenIds();
        titles = titles.filter((t) => !seen.has(t.id));
    }
    return { ...result, titles };
}

function rowList(fav) {
    const hasIndex = tpdb.hasToken();
    const rows = [];
    if (fav.titles.length) rows.push({ id: 'favorites', name: 'Favorites' });
    for (const p of fav.performers) rows.push({ id: `perf:${p.name}`, name: p.name, kind: 'performer' });
    for (const s of fav.studios || []) rows.push({ id: `studio:${s.name}`, name: s.name, kind: 'studio' });
    for (const t of fav.tags) rows.push({ id: `tag:${t.name}`, name: t.name, kind: 'tag' });
    // Claude's picks when you run the weekly task; otherwise the local row,
    // once your favorites and plays say enough.
    const picks = taste.readPicks();
    if (picks && picks.picks.length) rows.push({ id: 'claude', name: 'Claude picks', kind: 'recommended' });
    else if (taste.localSignals().length) rows.push({ id: 'foryou', name: 'More like what you like', kind: 'recommended' });
    if (hasIndex) rows.push({ id: 'scenes:new', name: 'New scenes' });
    rows.push({ id: 'scenes:available', name: 'Studio releases with torrents' });
    if (hasIndex) rows.push({ id: 'movies', name: 'Full movies' });
    rows.push({ id: 'amateur', name: 'Amateur & clips' });
    return rows;
}

function parseTubeId(id) {
    const m = String(id).match(/^inc:tube:(ep|rt):(.+)$/);
    return m ? { site: m[1], siteId: m[2] } : null;
}

async function title(id, fallback) {
    const cached = titleCache.get(id);
    const tube = parseTubeId(id);
    if (tube) {
        if (cached) return cached;
        const t = await safe(TUBE[tube.site].get(tube.siteId));
        if (t && t.id) { titleCache.set(t.id, t); return t; }
        return fallback || null;
    }
    if (id.startsWith('inc:movie:')) {
        const t = cached || await tpdb.getMovie(id.slice('inc:movie:'.length));
        return t ? { ...(fallback || {}), ...t } : (fallback || null);
    }
    if (id.startsWith('inc:scene:')) {
        const known = scenes.get(id);
        if (known) return known;
        if (!id.startsWith('inc:scene:k:') && !id.startsWith('inc:scene:r:')) {
            const t = cached || await tpdb.getScene(id.slice('inc:scene:'.length));
            if (t) return { ...(fallback || {}), ...t };
        }
        return fallback || null;
    }
    return null;
}

async function resolveDirect(site, siteId) {
    let lastErr;
    // The page fetch occasionally loses every retry to the ISP's resets; one
    // more full attempt almost always gets through.
    for (let attempt = 0; attempt < 2; attempt++) {
        try { return await relay.resolveStreams(site, siteId); } catch (err) { lastErr = err; }
    }
    console.warn(`[inc/streams] ${site}:${siteId} failed: ${lastErr && lastErr.message}`);
    return [];
}

// Search terms that find a scene's releases: "<Studio> yy mm dd", the
// performers, and the lead performer with the title (for undated releases).
function releaseQueries(t) {
    const q = [];
    const perf = (t.performers || []).slice(0, 2);
    if (t.kind === 'movie') {
        q.push(t.name);
        if (t.studio) q.push(`${t.name} ${t.studio}`);
        return q;
    }
    const m = String(t.date || '').match(/^\d{2}(\d{2})-(\d{2})-(\d{2})$/);
    const studio = t.studioShort || String(t.studio || '').replace(/\s+/g, '');
    if (studio && m) q.push(`${studio} ${m[1]} ${m[2]} ${m[3]}`);
    if (perf.length) q.push(perf.join(' '));
    if (perf.length && t.name) q.push(`${perf[0]} ${t.name}`);
    if (!q.length && t.searchHint) q.push(t.searchHint);
    return [...new Set(q)].slice(0, 3);
}

// A clearnet copy of a studio scene: a tube video naming the lead performer
// and most of the title, about as long as the scene. Unverified matching, so
// only the two best candidates are offered.
async function clearnetCopies(t) {
    const lead = (t.performers || [])[0];
    if (!lead || !t.name) return [];
    const query = `${lead} ${t.name}`;
    const [a, b] = await Promise.all([safe(eporner.search(query)), safe(redtube.search(query))]);
    const want = norm(t.name).split(' ').filter((w) => w.length > 2);
    const candidates = [...b, ...a].filter((v) => {
        const n = norm(`${v.name} ${(v.tags || []).join(' ')}`);
        if (!n.includes(norm(lead))) return false;
        const hit = want.filter((w) => n.includes(w)).length;
        if (!want.length || hit / want.length < 0.6) return false;
        if (t.duration && v.duration && Math.abs(v.duration - t.duration) / t.duration > 0.2) return false;
        return true;
    }).slice(0, 2);
    const lists = await Promise.all(candidates.map(async (v) => {
        const files = await resolveDirect(v.site, v.siteId);
        return streamsOut.fromDirect(v.site, v.siteName, v.siteId, files, relay.makePlayToken, { label: v.name });
    }));
    return lists.flat();
}

/** Stremio-shaped streams for a title (see streams.js). */
async function streams(id, fallback) {
    const tube = parseTubeId(id);
    if (tube) {
        const t = titleCache.get(id) || fallback;
        const sites = [{ site: tube.site, siteId: tube.siteId, siteName: TUBE[tube.site].name }, ...((t && t.alsoOn) || [])];
        const lists = await Promise.all(sites.map(async ({ site, siteId }) => {
            const files = await resolveDirect(site, siteId);
            return streamsOut.fromDirect(site, TUBE[site].name, siteId, files, relay.makePlayToken);
        }));
        return lists.flat();
    }
    if (id.startsWith('inc:scene:') || id.startsWith('inc:movie:')) {
        const t = (await title(id, fallback)) || fallback;
        if (!t) return [];
        if (fallback && fallback.releases) scenes.seed({ ...t, id }, fallback.releases);
        const [results, clearnet] = await Promise.all([
            Promise.all(releaseQueries(t).map((q) => safe(handleCatalog('adult-search', { search: q })))),
            t.kind === 'scene' ? safe(clearnetCopies(t)) : Promise.resolve([]),
        ]);
        const found = scenes.addReleases({ ...t, id }, results.flatMap((r) => (r && r.metas) || []));
        // Live seeders and the RD cache check run side by side (RD checks the
        // releases with the most listed seeders; it only adds [RD+] entries).
        // No pre-warming: opening a title doesn't touch any swarm. The
        // streaming server joins one only when Play (or auto-pick) starts it.
        const [releases, rdCached] = await Promise.all([withLiveCounts(found), rdCacheVerdicts(found)]);
        return [...streamsOut.fromReleases(releases, { title: t, rdCached }), ...clearnet];
    }
    return [];
}

// Replace each release's indexed seeder count with the live tracker count
// (see scrape.js). Releases no tracker answered for keep the indexed number,
// marked unverified.
async function withLiveCounts(releases) {
    let live = new Map();
    try { live = await liveSwarm(releases.filter((r) => r.infoHash).map((r) => r.infoHash)); } catch { /* keep indexed counts */ }
    for (const r of releases) {
        const l = r.infoHash && live.get(r.infoHash.toLowerCase());
        if (l) {
            // Update the registry's object too, so row badges follow.
            r.seeders = l.seeders;
            r.peers = l.leechers;
            r.liveChecked = true;
        }
    }
    return releases;
}

// Live counts for every release behind a row's scenes, so card badges and
// "playable first" use them. One scrape round trip for the whole row.
async function rowWithLiveCounts(titles) {
    const all = titles.filter((t) => t && t.releaseCount > 0).flatMap((t) => scenes.releasesOf(t.id));
    if (!all.length) return titles;
    await withLiveCounts(all);
    return titles.map((t) => (t && t.releaseCount > 0 ? (scenes.get(t.id) || t) : t));
}

// Which of the best-seeded releases Real-Debrid already has cached. Checks
// at most RD_CHECKS of them, in parallel, within the checker's time budget.
const RD_CHECKS = 6;
async function rdCacheVerdicts(releases) {
    const verdicts = new Map();
    const token = store.getRdToken();
    if (!token) return verdicts;
    const top = releases
        .filter((r) => r.infoHash)
        .sort((a, b) => (b.seeders || 0) - (a.seeders || 0))
        .slice(0, RD_CHECKS);
    await Promise.all(top.map(async (r) => {
        const cached = await checkCached({ infoHash: r.infoHash, title: r.name, token }).catch(() => false);
        verdicts.set(r.infoHash.toLowerCase(), cached);
    }));
    return verdicts;
}

async function search(q) {
    const [index, a, b, torrents] = await Promise.all([
        safe(tpdb.searchScenes(q)),
        safe(eporner.search(q)),
        safe(redtube.search(q)),
        safe(handleCatalog('adult-search', { search: q })),
    ]);
    const sc = await sceneRow((torrents && torrents.metas) || []);
    const seen = new Set();
    const pro = [...((index && index.titles) || []), ...sc.titles.filter((t) => t.tpdbId)]
        .filter((t) => !seen.has(t.id) && seen.add(t.id));
    // `pending`: releases still being matched to scenes; the UI asks again.
    return { titles: remember(withAvailability([...pro, ...mergeTube([b, a])])), pending: sc.pending || 0 };
}

let tagCache = null;
async function tags() {
    if (tagCache) return tagCache;
    const rt = await redtube.tags();
    const seen = new Set();
    tagCache = [...eporner.TAGS, ...rt].filter((t) => {
        const k = norm(t);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
    }).sort((x, y) => x.localeCompare(y));
    return tagCache;
}

module.exports = { row, rowList, title, streams, search, tags, mergeTube, releaseQueries };
