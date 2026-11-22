// HTTP endpoints for the Incognito clearnet catalog (/inc/*).
//
// Plain JSON over the addon's own HTTP server. Public catalog data is served
// with `Access-Control-Allow-Origin: *` like the rest of the addon, but
// anything personal (favorites, the ThePornDB token) only answers pages from
// the app's own origins, so another site open on this PC can't read it.

const relay = require('./relay');
const catalog = require('./catalog');
const favorites = require('./favorites');
const taste = require('./taste');
const searchHistory = require('./searchHistory');
const store = require('./store');
const streamsOut = require('./streams');
const { resolveWithRD } = require('../rd');

const PERSONAL_ORIGINS = [
    /^https:\/\/jeromenicholas07\.github\.io$/,
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

function originAllowed(req) {
    const origin = req.headers.origin;
    // No Origin header: not a cross-site browser request (mpv, curl, the
    // launcher). Those are local processes and may proceed.
    if (!origin) return true;
    return PERSONAL_ORIGINS.some((re) => re.test(origin));
}

function sendJson(req, res, status, body, { personal = false } = {}) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (personal) {
        if (req.headers.origin) {
            headers['Access-Control-Allow-Origin'] = req.headers.origin;
            headers.Vary = 'Origin';
        }
    } else {
        headers['Access-Control-Allow-Origin'] = '*';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', (c) => {
            body += c;
            if (body.length > limit) req.destroy();
        });
        req.on('end', () => {
            try { resolve(JSON.parse(body || '{}')); } catch { resolve(null); }
        });
        req.on('error', () => resolve(null));
    });
}

function preflight(req, res, personal) {
    const origin = req.headers.origin;
    if (personal && !originAllowed(req)) { res.statusCode = 403; res.end(); return; }
    res.writeHead(204, {
        'Access-Control-Allow-Origin': personal ? origin : '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        ...(personal ? { Vary: 'Origin' } : {}),
    });
    res.end();
}

// GET|HEAD /inc/rd/<token> — a Real-Debrid stream. Resolves the torrent
// through RD (cached torrents answer in seconds) and redirects the Player to
// the file, like Torrentio's resolve URLs. The stream list only offers RD for
// releases RD reported as cached, so this is normally quick; if one has
// dropped out of the cache, it answers 503 after RD_WAIT_MS rather than
// keeping the Player waiting while RD downloads.
const RD_WAIT_MS = 20000;
async function handleRdPlay(req, res, tokenStr) {
    const t = streamsOut.parseRdToken(tokenStr);
    if (!t) { res.statusCode = 400; res.end('bad token'); return; }
    const rdToken = store.getRdToken();
    if (!rdToken) { res.statusCode = 503; res.end('Real-Debrid token not set in Incognito Settings'); return; }
    try {
        const result = await Promise.race([
            resolveWithRD({ infoHash: t.h, title: t.n, token: rdToken, readyTimeoutMs: 12000 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Real-Debrid is still downloading this torrent')), RD_WAIT_MS)),
        ]);
        res.writeHead(302, { Location: result.url, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end();
    } catch (err) {
        console.warn(`[inc/rd] ${t.h.slice(0, 8)}…: ${err.message}`);
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(err.message);
    }
}

// A favorite's stored card data stands in when the live lookup has nothing
// (site down, addon restarted before the scene was seen again).
function favoriteSnapshot(id) {
    const f = favorites.get().titles.find((t) => t.id === id);
    return f ? f.snapshot : undefined;
}

const ENDPOINTS = [
    '/inc/rows', '/inc/row/<id>', '/inc/title/<id>', '/inc/streams/<id>', '/inc/search',
    '/inc/play/<token>', '/inc/rd/<token>', '/inc/img', '/inc/tags', '/inc/favorites', '/inc/config',
    '/inc/played', '/inc/search-click',
];

// Rows built from your favorites and plays answer only the app's own pages.
const PERSONAL_ROWS = new Set(['favorites', 'claude', 'foryou']);

/** Returns true when the request was an /inc/* request (handled here). */
function handle(req, res) {
    const u = new URL(req.url || '/', 'http://local');
    const p = u.pathname;
    if (!p.startsWith('/inc/')) return false;

    // Search writes your local search history, so it is personal too.
    const personal = p === '/inc/favorites' || p === '/inc/config' || p === '/inc/rows' || p === '/inc/played'
        || p === '/inc/search' || p === '/inc/search-click';
    if (req.method === 'OPTIONS') { preflight(req, res, personal); return true; }
    if (personal && !originAllowed(req)) { res.statusCode = 403; res.end(); return true; }

    const run = async () => {
        let m;
        if ((m = p.match(/^\/inc\/play\/([^/]+)$/))) {
            await relay.handlePlay(req, res, m[1]);
            return;
        }
        if (p === '/inc/img') {
            await relay.handleImage(req, res, u.searchParams);
            return;
        }
        if ((m = p.match(/^\/inc\/rd\/([^/]+)$/))) {
            await handleRdPlay(req, res, m[1]);
            return;
        }
        if (p === '/inc/version') {
            sendJson(req, res, 200, { endpoints: ENDPOINTS });
            return;
        }
        if (p === '/inc/rows') {
            sendJson(req, res, 200, { rows: catalog.rowList(favorites.get()) }, { personal: true });
            return;
        }
        if ((m = p.match(/^\/inc\/row\/(.+)$/))) {
            const rowId = decodeURIComponent(m[1]);
            const page = parseInt(u.searchParams.get('page') || '1', 10) || 1;
            const personalRow = PERSONAL_ROWS.has(rowId);
            if (personalRow && !originAllowed(req)) { res.statusCode = 403; res.end(); return; }
            if (rowId === 'favorites') {
                const titles = favorites.get().titles.map((f) => f.snapshot).filter(Boolean);
                sendJson(req, res, 200, { titles, pending: 0 }, { personal: true });
                return;
            }
            sendJson(req, res, 200, await catalog.row(rowId, page), { personal: personalRow });
            return;
        }
        if ((m = p.match(/^\/inc\/title\/(.+)$/))) {
            const id = decodeURIComponent(m[1]);
            const title = await catalog.title(id, favoriteSnapshot(id));
            sendJson(req, res, title ? 200 : 404, { title });
            return;
        }
        if ((m = p.match(/^\/inc\/streams\/(.+)$/))) {
            const id = decodeURIComponent(m[1]);
            const streams = await catalog.streams(id, favoriteSnapshot(id));
            sendJson(req, res, 200, { streams });
            return;
        }
        if (p === '/inc/search') {
            const q = (u.searchParams.get('q') || '').trim().slice(0, 200);
            const result = q ? await catalog.search(q) : { titles: [], pending: 0 };
            if (q) searchHistory.recordSearch(q, result);
            sendJson(req, res, 200, result, { personal: true });
            return;
        }
        if (p === '/inc/search-click') {
            // The search page reports which result was opened (history only).
            if (req.method !== 'POST') { sendJson(req, res, 405, { ok: false }, { personal: true }); return; }
            const body = await readBody(req, 4096);
            const ok = Boolean(body && typeof body.q === 'string' && body.title
                && searchHistory.recordClick(body.q, body.title, body.rank));
            sendJson(req, res, 200, { ok }, { personal: true });
            return;
        }
        if (p === '/inc/tags') {
            sendJson(req, res, 200, { tags: await catalog.tags() });
            return;
        }
        if (p === '/inc/favorites') {
            if (req.method === 'POST') {
                const body = await readBody(req);
                if (!body) { sendJson(req, res, 400, { error: 'bad body' }, { personal: true }); return; }
                const next = favorites.apply(body);
                taste.exportTaste();
                sendJson(req, res, 200, next, { personal: true });
                return;
            }
            sendJson(req, res, 200, favorites.get(), { personal: true });
            return;
        }
        if (p === '/inc/played') {
            // The Player reports an Incognito title once it starts playing.
            // Only the title's name, studio, performers and tags are kept.
            if (req.method !== 'POST') { sendJson(req, res, 405, { ok: false }, { personal: true }); return; }
            const body = await readBody(req, 4096);
            const id = body && typeof body.id === 'string' ? body.id.slice(0, 300) : '';
            if (!id.startsWith('inc:')) { sendJson(req, res, 400, { ok: false }, { personal: true }); return; }
            const title = await catalog.title(id, favoriteSnapshot(id));
            sendJson(req, res, 200, { ok: taste.recordPlay(title) }, { personal: true });
            return;
        }
        if (p === '/inc/config') {
            if (req.method === 'POST') {
                const body = await readBody(req, 4096);
                if (body && typeof body.theporndbToken === 'string') store.setTpdbToken(body.theporndbToken);
                if (body && typeof body.realDebridToken === 'string') store.setRdToken(body.realDebridToken);
            }
            // Tokens are never returned — only whether one is set.
            sendJson(req, res, 200, {
                theporndbTokenSet: Boolean(store.getTpdbToken()),
                realDebridTokenSet: Boolean(store.getRdToken()),
            }, { personal: true });
            return;
        }
        sendJson(req, res, 404, { error: 'not found' });
    };

    run().catch((err) => {
        console.warn(`[inc] ${p} failed: ${err.message}`);
        if (!res.headersSent) sendJson(req, res, 500, { error: err.message });
        else res.destroy();
    });
    return true;
}

module.exports = { handle, ENDPOINTS };
