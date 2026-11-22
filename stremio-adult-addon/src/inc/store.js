// Durable storage for the Incognito catalog: favorites, the ThePornDB token,
// and small on-disk caches.
//
// Lives in the launcher's `shared/` folder, which survives both addon
// re-extracts (every ADDON_VERSION bump wipes the addon dir) and launcher
// updates. The launcher passes PROWLARR_DATA_DIR = <appRoot>/shared/prowlarr-data,
// so the data dir is its sibling `<appRoot>/shared/incognito`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let _dataDir = null;

function resolveDataDir() {
    if (process.env.INCOGNITO_DATA_DIR) return process.env.INCOGNITO_DATA_DIR;
    if (process.env.PROWLARR_DATA_DIR) {
        return path.join(path.dirname(process.env.PROWLARR_DATA_DIR), 'incognito');
    }
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        return path.join(process.env.LOCALAPPDATA, 'StremioLauncherFULL', 'shared', 'incognito');
    }
    return path.join(process.env.HOME || os.tmpdir(), '.incognito-addon');
}

function getDataDir() {
    if (_dataDir) return _dataDir;
    const dir = resolveDataDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported on first write */ }
    _dataDir = dir;
    return dir;
}

function subDir(name) {
    const dir = path.join(getDataDir(), name);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return dir;
}

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(path.join(getDataDir(), file), 'utf8'));
    } catch {
        return fallback;
    }
}

// Write to a temp file and rename, so a crash mid-write never leaves a
// truncated favorites.json behind.
function writeJson(file, value) {
    const full = path.join(getDataDir(), file);
    const tmp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, full);
}

function hashKey(s) {
    return crypto.createHash('sha1').update(String(s)).digest('hex');
}

// ── ThePornDB token ──
// Never logged, never returned over HTTP. INCOGNITO_TPDB_TOKEN_FILE lets a
// dev instance with its own data dir use the real token file.
function tokenFile() {
    return process.env.INCOGNITO_TPDB_TOKEN_FILE || path.join(getDataDir(), 'theporndb-token.txt');
}

let _token = null;
let _tokenReadAt = 0;
function getTpdbToken() {
    // Re-read at most every 30 s so a token saved while running is picked up.
    if (_token !== null && Date.now() - _tokenReadAt < 30000) return _token;
    _tokenReadAt = Date.now();
    try {
        _token = fs.readFileSync(tokenFile(), 'utf8').trim();
    } catch {
        _token = '';
    }
    return _token;
}

function setTpdbToken(token) {
    const value = String(token || '').trim();
    if (value) fs.writeFileSync(tokenFile(), value + '\n');
    else {
        try { fs.unlinkSync(tokenFile()); } catch { /* already gone */ }
    }
    _token = value;
    _tokenReadAt = Date.now();
}

// ── Real-Debrid token ──
// The UI keeps it in its own storage; it also hands it here so RD stream
// URLs (/inc/rd/…) can resolve when the Player — which sends no page
// storage — opens them. Same rules as the ThePornDB token.
function rdTokenFile() {
    return path.join(getDataDir(), 'realdebrid-token.txt');
}

function getRdToken() {
    try { return fs.readFileSync(rdTokenFile(), 'utf8').trim(); } catch { return ''; }
}

function setRdToken(token) {
    const value = String(token || '').trim();
    if (value) fs.writeFileSync(rdTokenFile(), value + '\n');
    else {
        try { fs.unlinkSync(rdTokenFile()); } catch { /* already gone */ }
    }
}

// ── Per-install secret ──
// Signs stream tokens (/inc/rd/<token>), so the addon only spends the RD
// token on links it handed out itself — not on any infoHash a web page
// could put in a URL.
let _secret = null;
function getSecret() {
    if (_secret) return _secret;
    const file = path.join(getDataDir(), 'install-secret');
    try {
        _secret = fs.readFileSync(file, 'utf8').trim();
    } catch { /* first run */ }
    if (!_secret || _secret.length < 32) {
        _secret = crypto.randomBytes(32).toString('hex');
        try { fs.writeFileSync(file, _secret); } catch { /* in-memory for this run */ }
    }
    return _secret;
}

function sign(payload) {
    return crypto.createHmac('sha256', getSecret()).update(String(payload)).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}

// ── Small keyed disk cache (one JSON file per key) ──
// Used for ThePornDB lookups, which are immutable enough to keep for weeks
// and expensive enough (~1 s each) to never repeat.
function cacheGet(bucket, key, maxAgeMs) {
    const file = path.join(subDir(bucket), hashKey(key) + '.json');
    try {
        const st = fs.statSync(file);
        if (maxAgeMs && Date.now() - st.mtimeMs > maxAgeMs) return undefined;
        return JSON.parse(fs.readFileSync(file, 'utf8')).v;
    } catch {
        return undefined;
    }
}

function cacheSet(bucket, key, value) {
    const file = path.join(subDir(bucket), hashKey(key) + '.json');
    try { fs.writeFileSync(file, JSON.stringify({ v: value })); } catch { /* cache is best-effort */ }
}

module.exports = {
    getDataDir, subDir, readJson, writeJson, hashKey,
    getTpdbToken, setTpdbToken, getRdToken, setRdToken, sign,
    cacheGet, cacheSet,
};
