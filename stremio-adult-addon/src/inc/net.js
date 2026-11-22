// Network layer for the clearnet catalog sources.
//
// The user's ISP resets connections to some adult sites' domains (anything
// under eporner.com, redtube's API and pages) roughly half the time. The reset
// always lands while connecting — before any response byte arrives — so
// retrying that phase is safe: it can never duplicate or corrupt data.
//
// Measured 2026-11-21: with up to ~10 attempts every request got through.
// A hung connect (no reset, no answer) is cut short by HEADERS_TIMEOUT_MS so
// one dead attempt doesn't stall a whole retry budget.
//
// IPv4 only: the user's Wi-Fi synthesises dead NAT64 AAAA records, so IPv6
// connects can black-hole (see the launcher's own IPv4 preference).

const http = require('http');
const https = require('https');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const HEADERS_TIMEOUT_MS = 3500;
const DEFAULT_TRIES = 10;
const MAX_REDIRECTS = 5;

const agentOpts = { keepAlive: true, maxSockets: 16, family: 4 };
const httpsAgent = new https.Agent(agentOpts);
const httpAgent = new http.Agent(agentOpts);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One attempt: resolves with the response once headers arrive, rejects on
 * any error or when headers don't arrive within `headersTimeoutMs`.
 */
function requestOnce(url, { method = 'GET', headers = {}, headersTimeoutMs = HEADERS_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(url); } catch (e) { reject(e); return; }
        const isHttps = u.protocol === 'https:';
        const lib = isHttps ? https : http;
        const req = lib.request(u, {
            method,
            agent: isHttps ? httpsAgent : httpAgent,
            family: 4,
            headers: { 'User-Agent': UA, ...headers },
        });
        const timer = setTimeout(() => {
            const err = new Error('headers timeout');
            err.code = 'HEADERS_TIMEOUT';
            req.destroy(err);
        }, headersTimeoutMs);
        req.on('response', (res) => {
            clearTimeout(timer);
            resolve(res);
        });
        req.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        req.end();
    });
}

/**
 * Open a URL, retrying failures that happen before the response starts and
 * following redirects. Returns the live response (a readable stream) — the
 * caller must consume or destroy it.
 */
async function open(url, { method = 'GET', headers = {}, tries = DEFAULT_TRIES, headersTimeoutMs, onAttempt } = {}) {
    let current = url;
    let lastErr = null;
    let redirects = 0;
    for (let attempt = 0; attempt < tries; attempt++) {
        if (onAttempt) onAttempt(attempt);
        let res;
        try {
            res = await requestOnce(current, { method, headers, headersTimeoutMs });
        } catch (err) {
            lastErr = err;
            await sleep(Math.min(150 * (attempt + 1), 600));
            continue;
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
            res.resume();
            current = new URL(res.headers.location, current).href;
            redirects++;
            attempt--; // a redirect isn't a failed attempt
            continue;
        }
        res.finalUrl = current;
        return res;
    }
    const err = new Error(`unreachable after ${tries} tries: ${lastErr ? (lastErr.code || lastErr.message) : 'unknown'}`);
    err.code = 'UNREACHABLE';
    throw err;
}

function readBody(res, { maxBytes = 8 * 1024 * 1024, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        const timer = setTimeout(() => {
            res.destroy(new Error('body timeout'));
        }, timeoutMs);
        res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
                res.destroy(new Error('body too large'));
                return;
            }
            chunks.push(c);
        });
        res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
        res.on('error', (err) => { clearTimeout(timer); reject(err); });
        res.on('aborted', () => { clearTimeout(timer); reject(new Error('aborted')); });
    });
}

/**
 * GET a small document (JSON/HTML) with retries. A body cut off mid-way is
 * retried too — documents are small, so re-reading is cheap.
 * Resolves { status, headers, body (string), finalUrl }.
 */
async function fetchText(url, opts = {}) {
    const tries = opts.tries || DEFAULT_TRIES;
    let lastErr = null;
    for (let round = 0; round < 3; round++) {
        let res;
        try {
            res = await open(url, { ...opts, tries });
        } catch (err) {
            lastErr = err;
            break; // open() already spent its retry budget
        }
        try {
            const buf = await readBody(res, opts);
            return { status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), finalUrl: res.finalUrl };
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('fetch failed');
}

async function fetchJson(url, opts = {}) {
    const r = await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } });
    if (r.status !== 200) {
        const err = new Error(`HTTP ${r.status}`);
        err.status = r.status;
        throw err;
    }
    try {
        return JSON.parse(r.body);
    } catch (err) {
        throw new Error('bad JSON: ' + err.message);
    }
}

/** Run `fn` over `items` with at most `n` in flight. */
async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            try { out[i] = await fn(items[i], i); } catch { out[i] = undefined; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
}

module.exports = { UA, open, fetchText, fetchJson, readBody, mapLimit, sleep };
