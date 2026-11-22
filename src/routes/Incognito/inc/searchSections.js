// Order clearnet search results: studio scenes and movies with a healthy P2P
// release first (same bar as auto-pick on the title page: ≥ 5 live seeders),
// then other titles with releases, then the rest of the catalogue; tube
// videos as their own section. Stable within each group.

const healthy = (t) => t.releaseCount > 0 && t.seeders >= 5;

function searchSections(titles) {
    const pro = titles.filter((t) => t.kind === 'scene' || t.kind === 'movie');
    const tube = titles.filter((t) => t.kind === 'tube');
    const rank = (t) => (healthy(t) ? 0 : t.releaseCount > 0 ? 1 : 2);
    const ordered = pro.map((t, i) => [t, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([t]) => t);
    return { pro: ordered, tube, playable: pro.filter(healthy).length };
}

module.exports = searchSections;
