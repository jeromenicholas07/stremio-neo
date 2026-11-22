// Understand a search query: which part of it names a performer or a studio
// (typos included), and which words are left over to filter by.
//
//   "lena pual"        → performer Lena Paul (ThePornDB's performer search
//                         corrects typos; we check the answer is a near spelling)
//   "lena paul anal"   → performer Lena Paul, keyword "anal"
//   "tushy"            → studio Tushy
//   "brazers"          → studio Brazzers (ThePornDB's site search has no typo
//                         tolerance, so big studios are also matched locally)
//   "vixen laying it bare" → studio Vixen, keywords "laying it bare"
//
// Measured 2026-11-22: "lena pual" found no scenes, "tushy" returned titles
// containing the word, "lena paul anal" had 2 playable results.

const levenshtein = require('fast-levenshtein');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Big studios, for typo correction when ThePornDB's site search (exact names
// only) finds nothing.
const KNOWN_STUDIOS = [
    'Brazzers', 'Brazzers Exxtra', 'Blacked', 'Blacked Raw', 'Vixen', 'Tushy', 'Tushy Raw', 'Deeper', 'Slayed', 'Milfy',
    'Bang Bros', 'Reality Kings', 'Team Skeet', 'Naughty America', 'Evil Angel', 'Jules Jordan', 'Hard X', 'Digital Playground',
    'Wicked', 'Mofos', 'Babes', 'Twistys', 'Nubiles', 'Passion HD', 'Mylf', 'Pure Taboo', 'Adult Time', 'Elegant Angel',
    'Girlsway', 'Bellesa', 'Sex Art', 'Dark X', 'Lubed', 'Private', 'Dorcel', 'Lets Doe It', 'Fake Taxi', 'Public Agent',
    'Family Strokes', 'Sis Loves Me', 'Moms Teach Sex', 'Exxxtra Small', 'Bratty Sis', 'Pervz', 'Spizoo', 'Manuel Ferrara',
];

/** True when `a` is the same name as `b`, or a near spelling of it. */
function closeName(a, b) {
    const A = norm(a);
    const B = norm(b);
    if (!A || !B) return false;
    if (A === B || A.replace(/ /g, '') === B.replace(/ /g, '')) return true;
    const d = levenshtein.get(A, B);
    if (A.length >= 8) return d <= 2;
    if (A.length >= 5) return d <= 1;
    return false;
}

/**
 * Candidate spans of the query, longest first: the whole query, then its
 * prefixes and suffixes. `rest` is what's left outside the span.
 */
function spans(query, { minWords = 1, max = 6 } = {}) {
    const w = norm(query).split(' ').filter(Boolean);
    const out = [];
    for (let k = w.length; k >= Math.max(1, minWords); k--) {
        const pre = { text: w.slice(0, k).join(' '), rest: w.slice(k) };
        out.push(pre);
        if (k < w.length) out.push({ text: w.slice(w.length - k).join(' '), rest: w.slice(0, w.length - k) });
    }
    const seen = new Set();
    return out.filter((s) => !seen.has(s.text) && seen.add(s.text)).slice(0, max);
}

function knownStudio(text) {
    return KNOWN_STUDIOS.find((s) => closeName(text, s)) || null;
}

/**
 * Resolve the query to { kind: 'performer'|'studio', name, span, rest } or
 * null. `lookup(kind, text)` is ThePornDB's performer/site search
 * ([{ name, shortName }]). Tries the whole query first and stops there when
 * it is a name, so the common case costs one round of lookups.
 */
async function resolve(query, lookup) {
    const performerSpans = spans(query, { minWords: 2, max: 3 });
    // Studio names are often one word at either end ("vixen laying it
    // bare"), so the first and last words are always tried too.
    const all = spans(query, { minWords: 1, max: 20 });
    const siteSpans = all.slice(0, 5);
    const w = norm(query).split(' ').filter(Boolean);
    for (const edge of all.filter((s) => s.text === w[0] || s.text === w[w.length - 1])) {
        if (!siteSpans.includes(edge)) siteSpans.push(edge);
    }
    if (!siteSpans.length) return null;

    const tryPerformer = async (s) => {
        const list = await lookup('performers', s.text).catch(() => []);
        const hit = list.find((x) => closeName(s.text, x.name));
        return hit ? { kind: 'performer', name: hit.name, span: s.text, rest: s.rest } : null;
    };
    // Studios: typos are forgiven only against the known big studios. Other
    // sites must match ThePornDB's name exactly, and need two words or more:
    // measured, "laying it bare" fuzzily became the site "Playing" and
    // "angela" the site "ANGELA".
    const trySite = async (s) => {
        const local = knownStudio(s.text);
        if (!local && !s.text.includes(' ')) return null;
        const want = local || s.text;
        const list = await lookup('sites', want).catch(() => []);
        const exact = (x) => norm(x.name) === norm(want) || norm(x.shortName) === norm(want).replace(/ /g, '');
        const hit = list.find(exact);
        if (hit) return { kind: 'studio', name: hit.name, shortName: hit.shortName || '', span: s.text, rest: s.rest };
        return local ? { kind: 'studio', name: local, shortName: '', span: s.text, rest: s.rest } : null;
    };

    // Round 1: the whole query.
    const whole = siteSpans[0];
    const [p0, s0] = await Promise.all([
        whole.text.includes(' ') ? tryPerformer(whole) : Promise.resolve(null),
        trySite(whole),
    ]);
    if (p0 || s0) return p0 || s0;

    // Round 2: parts of it. Longest span wins; a performer wins a tie.
    const subP = performerSpans.slice(1);
    const subS = siteSpans.slice(1);
    const found = (await Promise.all([...subP.map(tryPerformer), ...subS.map(trySite)])).filter(Boolean);
    found.sort((a, b) => b.span.split(' ').length - a.span.split(' ').length || (a.kind === 'performer' ? -1 : 1));
    return found[0] || null;
}

/** Does a title match every leftover keyword (prefix or substring)? */
function matchesKeywords(title, rest) {
    if (!rest || !rest.length) return true;
    const hay = norm([title.name, title.studio, ...(title.tags || []), ...(title.performers || [])].join(' '));
    return rest.every((w) => hay.includes(w));
}

/** The query as it should read once the entity's name is spelled right. */
function correctedQuery(query, entity) {
    if (!entity || norm(entity.name) === entity.span) return null;
    const w = norm(query).split(' ').filter(Boolean);
    const spanWords = entity.span.split(' ');
    const at = w.findIndex((_, i) => w.slice(i, i + spanWords.length).join(' ') === entity.span);
    if (at === -1) return entity.name;
    return [...w.slice(0, at), entity.name, ...w.slice(at + spanWords.length)].join(' ');
}

module.exports = { resolve, spans, closeName, matchesKeywords, correctedQuery, knownStudio, KNOWN_STUDIOS };
