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

// Words that join names: "lena paul, abella danger", "lena paul and abella
// danger", "lena paul & abella danger", "lena paul x abella danger".
const SEPARATOR = /\s*(?:,|&|\+|\/|;|\band\b|\bwith\b|\bvs\.?\b|\bx\b|\bft\.?\b|\bfeat\.?\b)\s*/i;
const MAX_PERFORMERS = 3;
const MAX_WORDS = 10;

function makeLookups(lookup) {
    const performer = async (text) => {
        const list = await lookup('performers', text).catch(() => []);
        const hit = list.find((x) => closeName(text, x.name));
        return hit ? { name: hit.name, span: text } : null;
    };
    // Studios: typos are forgiven only against the known big studios. Other
    // sites must match ThePornDB's name exactly, and need two words or more
    // (measured: "laying it bare" fuzzily became the site "Playing" and
    // "angela" the site "ANGELA") — unless the word sits beside a recognised
    // performer ("jenna foxx shoplyfter"): `beside` allows one exact word.
    const studio = async (text, { beside = false } = {}) => {
        const local = knownStudio(text);
        if (!local && !text.includes(' ') && !beside) return null;
        const want = local || text;
        const list = await lookup('sites', want).catch(() => []);
        const exact = (x) => norm(x.name) === norm(want) || norm(x.shortName) === norm(want).replace(/ /g, '');
        const hit = list.find(exact);
        if (hit) return { name: hit.name, shortName: hit.shortName || '', span: text };
        return local ? { name: local, shortName: '', span: text } : null;
    };
    return { performer, studio };
}

/**
 * Performers in one run of words, left to right, longest name first at each
 * position ("lena paul abella danger" → Lena Paul, Abella Danger). Names are
 * 2–3 words; one-word names are too ambiguous ("angela"). All windows are
 * looked up at once. → { found: [{ name, span }], leftover: [words] }
 */
async function performersIn(words, performer) {
    const windows = new Map();
    for (let i = 0; i < words.length; i++) {
        for (const len of [3, 2]) {
            if (i + len <= words.length) windows.set(words.slice(i, i + len).join(' '), null);
        }
    }
    await Promise.all([...windows.keys()].map(async (t) => { windows.set(t, await performer(t)); }));
    const found = [];
    const leftover = [];
    for (let i = 0; i < words.length;) {
        const hit = [3, 2].map((len) => (i + len <= words.length ? windows.get(words.slice(i, i + len).join(' ')) : null)).find(Boolean);
        if (hit && found.length < MAX_PERFORMERS && !found.some((f) => f.name === hit.name)) {
            found.push(hit);
            i += hit.span.split(' ').length;
        } else {
            leftover.push(words[i]);
            i++;
        }
    }
    return { found, leftover };
}

/**
 * Understand a query: → { performers: [{ name, span }], studio: { name,
 * shortName, span } | null, rest: [words] } or null when it names nobody.
 * `lookup(kind, text)` is ThePornDB's performer/site search ([{ name,
 * shortName }]). The whole query is tried first, so typing one name costs
 * one round of lookups.
 */
async function resolve(query, lookup) {
    const { performer, studio } = makeLookups(lookup);
    const all = norm(query).split(' ').filter(Boolean).slice(0, MAX_WORDS);
    if (!all.length) return null;
    const whole = all.join(' ');

    // Round 1: the whole query is one name.
    const [p0, s0] = await Promise.all([
        all.length >= 2 && all.length <= 4 ? performer(whole) : Promise.resolve(null),
        studio(whole),
    ]);
    if (p0) return { performers: [p0], studio: null, rest: [] };
    if (s0) return { performers: [], studio: s0, rest: [] };

    // Round 2: names inside it, per segment between separators.
    const segments = String(query || '').split(SEPARATOR).map((s) => norm(s).split(' ').filter(Boolean)).filter((s) => s.length);
    const performers = [];
    let leftover = [];
    for (const seg of segments) {
        const r = await performersIn(seg, performer);
        for (const f of r.found) if (performers.length < MAX_PERFORMERS && !performers.some((p) => p.name === f.name)) performers.push(f);
        leftover = leftover.concat(r.leftover);
    }
    // A studio among the leftovers: the longest run that is one ("blacked
    // raw lena paul"), else a big studio's one-word name at either end.
    let st = null;
    const runs = spans(leftover.join(' '), { minWords: 1, max: 20 });
    const tries = runs.filter((s) => s.text.includes(' ')).slice(0, 4)
        .concat(runs.filter((s) => !s.text.includes(' ') && (s.text === leftover[0] || s.text === leftover[leftover.length - 1])));
    for (const s of tries) {
        st = await studio(s.text, { beside: performers.length > 0 });
        if (st) {
            leftover = s.rest.length ? leftover.filter((w) => !s.text.split(' ').includes(w)) : [];
            break;
        }
    }
    if (!performers.length && !st) return null;
    return { performers, studio: st, rest: leftover };
}

/** Does a title match every leftover keyword (prefix or substring)? */
function matchesKeywords(title, rest) {
    if (!rest || !rest.length) return true;
    const hay = norm([title.name, title.studio, ...(title.tags || []), ...(title.performers || [])].join(' '));
    return rest.every((w) => hay.includes(w));
}

/** Does a title feature every one of these performers? */
function featuresAll(title, names) {
    const cast = (title.performers || []).map(norm);
    return names.every((n) => cast.some((c) => closeName(c, n) || c.includes(norm(n))));
}

/** The query as it should read once names are spelled right, or null. */
function correctedQuery(query, resolved) {
    if (!resolved) return null;
    const named = [...(resolved.performers || []), ...(resolved.studio ? [resolved.studio] : [])];
    if (!named.some((e) => norm(e.name) !== e.span)) return null;
    let text = norm(query);
    for (const e of named) text = text.replace(e.span, e.name);
    return text.replace(/\s+/g, ' ').trim();
}

module.exports = { resolve, spans, closeName, matchesKeywords, featuresAll, correctedQuery, knownStudio, KNOWN_STUDIOS };
