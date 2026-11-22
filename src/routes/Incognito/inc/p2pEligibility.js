// Which Incognito P2P streams auto-pick may try. Auto-pick ranks quality
// before seeders, so this decides what it can reach:
//
//   - every stream needs at least MIN_SEEDERS live seeders (a weaker swarm
//     rarely starts);
//   - 1080p qualifies on that alone. You prefer 1080p, and a 1080p copy with
//     15 seeders shouldn't lose to a 480p one with 180. If it stalls, the
//     Player's 60 s watchdog moves on to the next stream;
//   - 4K only when no 1080p qualifies, and with at least MIN_4K_SEEDERS: the
//     files are 2–4× larger and P2P here often runs at a few hundred KB/s
//     (measured: "Green Eyed Monster" picked a 6-seeder 4K over two 1080p
//     copies with 21–22);
//   - 720p and below keep the relative bar (a tenth of the best release's
//     live count), so a 7-seeder 720p doesn't beat a 180-seeder 480p.
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

// The quality line of an Incognito stream name ("Incognito P2P\n1080p").
function qualityOf(s) {
    return String(((s && s.name) || '').split('\n')[1] || '').trim().toLowerCase();
}

/** streams → predicate: may auto-pick try this P2P stream? */
function p2pEligibility(streams) {
    const p2p = (streams || []).filter((s) => s && s.infoHash);
    const best = Math.max(0, ...p2p.map(liveSeeders));
    const relative = Math.max(MIN_SEEDERS, Math.ceil(best / 10));
    const ok1080 = (s) => qualityOf(s) === '1080p' && liveSeeders(s) >= MIN_SEEDERS;
    const any1080 = p2p.some(ok1080);
    return (s) => {
        if (!s || !s.infoHash) return false;
        const live = liveSeeders(s);
        if (live < MIN_SEEDERS) return false;
        const q = qualityOf(s);
        if (q === '1080p') return true;
        if (q === '4k') return !any1080 && live >= Math.max(MIN_4K_SEEDERS, relative);
        return live >= relative;
    };
}

module.exports = { p2pEligibility, liveSeeders, qualityOf, MIN_SEEDERS, MIN_4K_SEEDERS };
