// Order clearnet search results: studio scenes and movies with a P2P release
// auto-pick can play (≥ 5 live seeders) first, then other titles with
// releases, then the rest of the catalogue; tube videos as their own section.
// Stable within each group.
//
// When the query named several performers, the addon puts the scenes that
// feature all of them first (`together` of them); they stay a group of their
// own, ordered the same way, ahead of everything else.

const healthy = (t) => t.releaseCount > 0 && t.seeders >= 5;

function ordered(list) {
    const rank = (t) => (healthy(t) ? 0 : t.releaseCount > 0 ? 1 : 2);
    return list.map((t, i) => [t, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);
}

function searchSections(titles, together = 0) {
    const pro = titles.filter((t) => t.kind === 'scene' || t.kind === 'movie');
    const tube = titles.filter((t) => t.kind === 'tube');
    const n = Math.max(0, Math.min(Number(together) || 0, pro.length));
    return {
        together: ordered(pro.slice(0, n)),
        pro: ordered(pro.slice(n)),
        tube,
        playable: pro.filter(healthy).length,
        scenes: pro.length,
    };
}

module.exports = searchSections;
