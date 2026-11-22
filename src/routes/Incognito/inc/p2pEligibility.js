// Which Incognito P2P streams auto-pick may try. Auto-pick ranks quality
// before seeders (1080p › 720p › 480p › untagged, then most seeders), so
// letting a stream in means "play the best quality that has enough
// seeders":
//
//   - 1080p, 720p, 480p and untagged releases qualify with at least
//     MIN_SEEDERS live seeders, whatever the best release has. You prefer
//     quality; a 1080p copy with 15 seeders shouldn't lose to a 480p one with
//     180. If the better copy stalls, the Player's 60 s watchdog moves on to
//     the next one down;
//   - untagged releases rank last on their own (auto-pick's "Other / SD");
//     the addon labels the ones whose size can only be 1080p "~1080p";
//   - 4K only when no 1080p qualifies, and with at least MIN_4K_SEEDERS: the
//     files are 2–4× larger and P2P here often runs at a few hundred KB/s
//     (measured: "Green Eyed Monster" picked a 6-seeder 4K over two 1080p
//     copies with 20+);
//   - under MIN_SEEDERS a swarm rarely starts, and an unverified listed count
//     ("👤 ~428 listed") never counts.
//
// The rest stay in the list for picking by hand.

const MIN_SEEDERS = 5;
const MIN_4K_SEEDERS = 10;

// Live seeders as the addon reports them ("👤 48"; an unverified listed
// count reads "👤 ~428 listed" and doesn't match).
function liveSeeders(s) {
    const m = String((s && s.description) || '').match(/👤\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
}

// The quality line of an Incognito stream name ("Incognito P2P\n1080p";
// "~1080p" when estimated from the file size).
function qualityOf(s) {
    return String(((s && s.name) || '').split('\n')[1] || '').trim().toLowerCase().replace(/^~/, '');
}

/** streams → predicate: may auto-pick try this P2P stream? */
function p2pEligibility(streams) {
    const p2p = (streams || []).filter((s) => s && s.infoHash);
    const any1080 = p2p.some((s) => qualityOf(s) === '1080p' && liveSeeders(s) >= MIN_SEEDERS);
    return (s) => {
        if (!s || !s.infoHash) return false;
        const live = liveSeeders(s);
        if (qualityOf(s) === '4k') return !any1080 && live >= MIN_4K_SEEDERS;
        return live >= MIN_SEEDERS;
    };
}

module.exports = { p2pEligibility, liveSeeders, qualityOf, MIN_SEEDERS, MIN_4K_SEEDERS };
