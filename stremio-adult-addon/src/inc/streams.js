// Stremio-shaped streams for a catalog title.
//
// The Incognito title page renders Stremio's own StreamsList, so streams
// here look like what Torrentio returns:
//
//   name:        "[RD+] Incognito\n1080p"  (auto-pick buckets read the
//                 [RD…] tag; quality is read from name/description)
//   description: "<release name>\n👤 785 💾 289 MB ⚙️ Knaben"  (auto-pick reads
//                 seeders from the 👤 count)
//   url / infoHash: what the Player plays
//
// Each stream also carries `source` ("torrents" | "clearnet") so the page can
// group them the way StreamsList groups addons.
//
//   RD          url → /inc/rd/<token>: resolves through Real-Debrid on demand
//               and redirects to the file (the Torrentio pattern, so the
//               existing preflight and copyright checks apply).
//   P2P         infoHash (+ trackers) for the streaming server.
//   unresolved  releases with only a download link open the existing torrent
//               screen, which resolves them.
//   clearnet    the site's own file through the play relay.

const { base64UrlEncode, base64UrlDecode } = require('./titles');
const store = require('./store');

const TRACKERS = [
    'tracker:udp://tracker.opentrackr.org:1337/announce',
    'tracker:udp://open.stealth.si:80/announce',
    'tracker:udp://tracker.torrent.eu.org:451/announce',
    'tracker:udp://exodus.desync.com:6969/announce',
];

function formatSize(bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 ** 3);
    return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / (1024 ** 2))} MB`;
}

function qualityOf(text) {
    const t = String(text || '').toLowerCase();
    if (/\b(2160p|4k|uhd)\b/.test(t)) return '4k';
    if (/\b1080p\b/.test(t)) return '1080p';
    if (/\b720p\b/.test(t)) return '720p';
    if (/\b(480p|sd)\b/.test(t)) return '480p';
    return '';
}

function sizeBytes(r) {
    if (Number(r && r.size) > 0) return Number(r.size);
    const m = /([\d.]+)\s*(GiB|GB|MiB|MB)/i.exec((r && r.sizeLabel) || '');
    return m ? parseFloat(m[1]) * (/^g/i.test(m[2]) ? 1e9 : 1e6) : 0;
}

// Untagged releases: only a size that can only be HD gets a label. Measured
// 2026-11-22 on ~300 tagged releases (bit rate = size × 8 / scene length):
// 480p ≈ 1.1 Mbps, 720p ≈ 1.4 (p90 2.0), 1080p HEVC ≈ 2.0 (p90 2.5), 1080p
// H.264 ≈ 11.6, 4K ≈ 23 (p10 18). Below ~6 Mbps the qualities overlap, so
// nothing is guessed there; above 15 it could be 4K or a multi-scene pack.
function estimateQuality(r, durationSec) {
    const bytes = sizeBytes(r);
    if (!bytes || !(durationSec >= 300)) return '';
    const mbps = (bytes * 8) / durationSec / 1e6;
    return mbps >= 6 && mbps <= 15 ? '~1080p' : '';
}

// "<payload>.<signature>": only links this addon handed out are honoured.
function makeRdToken(release) {
    const payload = base64UrlEncode(JSON.stringify({ h: release.infoHash, n: String(release.name || '').slice(0, 160) }));
    return `${payload}.${store.sign(payload)}`;
}

function parseRdToken(token) {
    const [payload, sig] = String(token || '').split('.');
    if (!payload || !sig || store.sign(payload) !== sig) return null;
    try {
        const t = JSON.parse(base64UrlDecode(payload));
        if (t && /^[a-f0-9]{40}$/i.test(t.h)) return t;
    } catch { /* fall through */ }
    return null;
}

// "👤 48" is a live tracker count (what auto-pick reads as seeders). A count
// only the torrent index reported is shown as "👤 ~428 listed": often stale,
// and auto-pick reads it as unknown (0), so verified releases win.
function describe(release) {
    const facts = [release.liveChecked
        ? `👤 ${release.seeders || 0}`
        : `👤 ~${release.seeders || 0} listed`];
    const size = release.sizeLabel || formatSize(release.size);
    if (size) facts.push(`💾 ${size}`);
    if (release.indexer) facts.push(`⚙️ ${release.indexer}`);
    return `${release.name}\n${facts.join(' ')}`;
}

// How popular a release is on the indexes (the count before the live
// tracker check replaced `seeders`): what RD's cache follows.
const listedOf = (r) => (r.listedSeeders !== undefined ? r.listedSeeders : r.seeders) || 0;

/**
 * Real-Debrid entries RD hasn't confirmed (its check said "unknown", or the
 * release wasn't checked), played the way the old torrent screen plays: ask
 * RD on click and wait up to ~20 s. The safety net for a check that couldn't
 * tell; RD often has popular releases even when their swarm is gone.
 *   - nothing else playable (no [RD+], no P2P with ≥ 5 live seeders): the
 *     two most popular releases as "[RD download]", which auto-pick tries;
 *   - otherwise one, named so auto-pick leaves it alone (manual only).
 */
function unverifiedRd(sorted, { title, rdCached, qualityLabel }) {
    const withHash = sorted.filter((r) => r.infoHash);
    const verdict = (r) => (rdCached ? rdCached.get(r.infoHash.toLowerCase()) : undefined);
    const anyRdPlus = withHash.some((r) => verdict(r) === true);
    const healthyP2P = withHash.some((r) => r.liveChecked && (r.seeders || 0) >= 5);
    const rescue = !anyRdPlus && !healthyP2P;
    const picks = withHash
        .filter((r) => verdict(r) !== true && verdict(r) !== false && listedOf(r) >= 1)
        .sort((a, b) => listedOf(b) - listedOf(a))
        .slice(0, rescue ? 2 : (anyRdPlus ? 0 : 1));
    const group = `incognito:${(title && title.id) || ''}`;
    return picks.map((r) => ({
        source: 'torrents',
        name: rescue ? `[RD download] Incognito\n${qualityLabel(r)}` : `RD (unconfirmed)\n${qualityLabel(r)}`,
        description: `${describe(r)}\nNot confirmed on Real-Debrid: asks RD when played (up to 20 s)`,
        url: `/inc/rd/${makeRdToken(r)}`,
        behaviorHints: { bingeGroup: `${group}:rd`, filename: r.name },
    }));
}

/**
 * Torrent releases → RD + P2P streams (best seeded first).
 *   - "[RD+]" for releases Real-Debrid confirmed it has (`rdCached` true,
 *     from rd.checkCached): instant;
 *   - unconfirmed RD entries when RD is set up (`rdEnabled`), see
 *     unverifiedRd;
 *   - every release with an infoHash as P2P.
 */
function fromReleases(releases, { title, rdCached, rdEnabled = false } = {}) {
    const out = [];
    // Live-checked releases by live seeders, then the unverified ones (by
    // their listed count) — unless nothing could be checked at all.
    const anyLive = (releases || []).some((r) => r.liveChecked);
    const rank = (r) => (anyLive ? (r.liveChecked ? r.seeders || 0 : -1) : r.seeders || 0);
    const sorted = (releases || []).slice().sort((a, b) => rank(b) - rank(a) || (b.seeders || 0) - (a.seeders || 0));
    const qualityLabel = (r) => qualityOf(r.quality) || qualityOf(r.name) || estimateQuality(r, title && title.duration) || 'SD';
    if (rdEnabled) out.push(...unverifiedRd(sorted, { title, rdCached, qualityLabel }));
    for (const r of sorted) {
        const qLabel = qualityLabel(r);
        const description = describe(r);
        const group = `incognito:${(title && title.id) || ''}`;
        if (r.infoHash) {
            if (rdCached && rdCached.get(r.infoHash.toLowerCase()) === true) {
                out.push({
                    source: 'torrents',
                    name: `[RD+] Incognito\n${qLabel}`,
                    description,
                    url: `/inc/rd/${makeRdToken(r)}`,
                    behaviorHints: { bingeGroup: `${group}:rd`, filename: r.name },
                });
            }
            out.push({
                source: 'torrents',
                name: `Incognito P2P\n${qLabel}`,
                description,
                infoHash: r.infoHash.toLowerCase(),
                // DHT too, as Torrentio's streams do: with trackers alone the
                // streaming server never searches DHT for peers (seen in the
                // Shell 2026-11-22: 4 tracker sources, no dht).
                sources: [...TRACKERS, `dht:${r.infoHash.toLowerCase()}`],
                behaviorHints: { bingeGroup: `${group}:p2p`, filename: r.name },
            });
        } else if (r.href) {
            // No infoHash yet: the torrent screen resolves it, then offers RD or P2P.
            out.push({
                source: 'torrents',
                name: `Incognito\n${qLabel}`,
                description: `${description}\nResolves when opened`,
                externalHref: r.href,
            });
        }
    }
    return out;
}

/** Tube files (from relay.resolveStreams) → clearnet streams. */
function fromDirect(site, siteName, siteId, files, makePlayToken, { label } = {}) {
    return files.map((f) => ({
        source: 'clearnet',
        name: `${siteName}\n${f.quality ? `${f.quality}p` : f.label}`,
        description: label ? `${label}\n${siteName} · direct` : `${siteName} · direct`,
        url: `/inc/play/${makePlayToken(site, siteId, f.quality)}`,
        behaviorHints: { bingeGroup: `incognito-direct:${site}` },
    }));
}

module.exports = { fromReleases, fromDirect, makeRdToken, parseRdToken, qualityOf, estimateQuality, TRACKERS };
