// Live swarm health from public BitTorrent trackers (UDP scrape, BEP 15).
//
// The seeder counts torrent indexes report are often stale. Measured
// 2026-11-22 on 15 Blacked releases: listed "428 seeders" was 2–3 live; five
// releases listed at 81–147 had 0; one listed at 50 had 48–57. A scrape
// returns current seeders for up to ~70 hashes per tracker in one round trip
// (about a second) and downloads nothing, so P2P streams are ranked by it.
//
// Counts are a lower bound (DHT-only peers don't show up), so the best of the
// trackers is used, and a failed scrape falls back to the indexer's number.

const dgram = require('dgram');
const crypto = require('crypto');
const { LRUCache } = require('lru-cache');

const TRACKERS = [
    ['tracker.opentrackr.org', 1337],
    ['open.stealth.si', 80],
    ['tracker.torrent.eu.org', 451],
];
const TIMEOUT_MS = 3000;
const MAX_PER_REQUEST = 70;
const PROTOCOL_ID = Buffer.from('0000041727101980', 'hex');
const cache = new LRUCache({ max: 5000, ttl: 10 * 60 * 1000 });

function scrapeTracker(host, port, hashes) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket('udp4');
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { sock.close(); } catch { /* already closed */ }
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), TIMEOUT_MS);
        sock.on('error', () => finish(null));
        sock.on('message', (msg) => {
            if (msg.length < 8) return;
            const action = msg.readUInt32BE(0);
            if (action === 0 && msg.length >= 16) {
                // Connected: send the scrape with the connection id.
                const req = Buffer.concat([
                    msg.subarray(8, 16), Buffer.from([0, 0, 0, 2]), crypto.randomBytes(4),
                    ...hashes.map((h) => Buffer.from(h, 'hex')),
                ]);
                sock.send(req, port, host);
            } else if (action === 2) {
                const out = new Map();
                hashes.forEach((h, i) => {
                    const off = 8 + i * 12;
                    if (msg.length >= off + 12) {
                        out.set(h, { seeders: msg.readUInt32BE(off), leechers: msg.readUInt32BE(off + 8) });
                    }
                });
                finish(out);
            } else if (action === 3) {
                finish(null);
            }
        });
        sock.send(Buffer.concat([PROTOCOL_ID, Buffer.from([0, 0, 0, 0]), crypto.randomBytes(4)]), port, host);
    });
}

/**
 * hashes → Map(hash → { seeders, leechers }) with the best count across
 * trackers. Hashes no tracker answered for are absent from the map.
 */
async function liveSwarm(hashes) {
    const want = [...new Set((hashes || []).map((h) => String(h).toLowerCase()).filter((h) => /^[a-f0-9]{40}$/.test(h)))];
    const result = new Map();
    const todo = [];
    for (const h of want) {
        const hit = cache.get(h);
        if (hit) result.set(h, hit); else todo.push(h);
    }
    for (let i = 0; i < todo.length; i += MAX_PER_REQUEST) {
        const batch = todo.slice(i, i + MAX_PER_REQUEST);
        const answers = await Promise.all(TRACKERS.map(([host, port]) => scrapeTracker(host, port, batch)));
        for (const h of batch) {
            let best = null;
            for (const a of answers) {
                const v = a && a.get(h);
                if (v && (!best || v.seeders > best.seeders)) best = v;
            }
            if (best) {
                cache.set(h, best);
                result.set(h, best);
            }
        }
    }
    return result;
}

module.exports = { liveSwarm };
