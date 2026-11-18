// Turns the evidence gathered for one file into the segments the player acts
// on, each with a confidence:
//
//   high   - confirmed by two independent sources, or named by a chapter in the
//            file itself. Only these may be skipped automatically.
//   medium - one trustworthy source. Shown as a Skip button.
//   low    - one thin source (a single database vote, a partial audio match).
//            Also a button.
//
// Evidence measured on the file (chapters, audio shared with other episodes)
// outranks the databases, whose timestamps may belong to a different cut.

const START_TOLERANCE = 5; // starts matter less: nobody skips at the first frame
const END_TOLERANCE = 3;
const HEAD_SECONDS = 8; // two starts this close to the beginning count as the same
const MARK_TOLERANCE = 2; // an edge this close to a chapter boundary snaps to it
const MARK_REACH = 6; // ...and one this far outside the matched stretch, see snapToMarks
const STRONG_BIT_ERROR_RATE = 0.30;
// How much further than the audio match a database end may reach and still
// be taken as the same intro.
const DB_EXTEND_SECONDS = 60;
// Studio logos and network idents run up to about this long.
const LOGO_SECONDS = 20;
const MIN_SECONDS = 5;
const MAX_SECONDS = { intro: 200, recap: 480, credits: 900, preview: 600 };
// Longest segment that may be skipped without asking. Title sequences run
// about two minutes at most (Game of Thrones, Westworld).
const AUTO_SKIP_MAX_SECONDS = { intro: 150, recap: 240 };
const TYPES = ['recap', 'intro', 'credits', 'preview'];

function sameStart(a, b) {
    return Math.abs(a.start - b.start) <= START_TOLERANCE || (a.start <= HEAD_SECONDS && b.start <= HEAD_SECONDS);
}

function agree(a, b) {
    const sameStart = Math.abs(a.start - b.start) <= START_TOLERANCE || (a.start <= HEAD_SECONDS && b.start <= HEAD_SECONDS);
    return sameStart && Math.abs(a.end - b.end) <= END_TOLERANCE;
}

function plausible(type, candidate, duration) {
    const length = candidate.end - candidate.start;
    if (!(candidate.start >= 0) || length < MIN_SECONDS || length > MAX_SECONDS[type]) return false;
    if (!Number.isFinite(duration)) return true;
    if (candidate.end > duration + 1) return false;
    // An "intro" in the back half is a mislabelled segment.
    return type !== 'intro' && type !== 'recap' ? true : candidate.start < duration * 0.6;
}

// Audio matching stops a little inside the intro on both sides (a fade at
// either end differs between episodes), so a chapter mark slightly outside
// the matched stretch is taken as the true edge.
function snapToMarks(candidate, marks) {
    const within = (time, before, after) => marks.find((mark) => mark >= time - before && mark <= time + after);
    const end = within(candidate.end, MARK_TOLERANCE, MARK_REACH);
    const start = within(candidate.start, MARK_REACH, MARK_TOLERANCE);
    return {
        start: start !== undefined && (end === undefined || start < end) ? start : candidate.start,
        end: end !== undefined ? end : candidate.end,
        snapped: end !== undefined,
    };
}

function fromDatabases(entries, localDone) {
    if (entries.length === 0) return null;
    const ranked = entries.slice().sort((a, b) => (b.sameCut === true) - (a.sameCut === true) || b.votes - a.votes);
    const base = ranked[0];
    const second = entries.find((other) => other.source !== base.source && agree(base, other));
    let confidence = 'low';
    if (second) {
        // Two databases can share the same wrong cut, so agreement alone is not
        // enough to skip unattended: one of them must match this file's length.
        confidence = base.sameCut === true || second.sameCut === true ? 'high' : 'medium';
    } else if (base.votes >= 3 && base.sameCut !== false) {
        confidence = 'medium';
    }
    // Local analysis looked and found nothing to back this up.
    if (localDone && confidence === 'high') confidence = 'medium';
    return { start: base.start, end: base.end, confidence, sources: second ? [base.source, second.source] : [base.source] };
}

function fuseType(type, evidence) {
    const duration = evidence.duration;
    const marks = evidence.chapters ? evidence.chapters.marks : [];
    const named = (evidence.chapters ? evidence.chapters.named : [])
        .filter((chapter) => chapter.type === type && plausible(type, chapter, duration));
    const audio = (type === 'intro' ? evidence.repetition || [] : [])
        .filter((match) => plausible(type, match, duration));
    const databases = (evidence.database ? evidence.database.segments : [])
        .filter((entry) => entry.type === type && plausible(type, entry, duration));

    if (named.length > 0) {
        const chapter = named[0];
        return { type, start: chapter.start, end: chapter.end, confidence: 'high', sources: ['chapter'] };
    }

    const strong = audio.filter((match) => match.bitErrorRate <= STRONG_BIT_ERROR_RATE);
    if (strong.length > 0) {
        // Matches that start together describe the same intro. Where each one
        // stops can differ: the shared stretch ends early against an episode
        // whose intro is cut shorter, and runs late against one that repeats
        // a scene. So the end is picked separately, and a longer end is only
        // taken when something else confirms it.
        const weightOf = (list) => list.reduce((sum, match) => sum + (match.weight || 1), 0);
        const groupOf = (seed) => strong.filter((other) => sameStart(seed, other));
        const inDatabase = (seed) => databases.some((entry) => sameStart(seed, entry));
        // Episodes can share more than the intro, typically a studio logo just
        // before it. The best supported group wins; on a tie, the one a
        // database places there, then the longer one.
        const seed = strong.slice().sort((a, b) => weightOf(groupOf(b)) - weightOf(groupOf(a))
            || inDatabase(b) - inDatabase(a)
            || (b.end - b.start) - (a.end - a.start)
            || a.bitErrorRate - b.bitErrorRate)[0];
        const group = groupOf(seed);
        // A match that starts later inside the same intro still shows where
        // it ends.
        const overlapping = strong.filter((other) => other.start < Math.max(...group.map((m) => m.end)) && other.end > seed.start);
        const nearMark = (time) => marks.find((mark) => Math.abs(mark - time) <= MARK_TOLERANCE);
        const ends = group.map((match) => ({ end: match.end, weight: weightOf(overlapping.filter((other) => Math.abs(other.end - match.end) <= END_TOLERANCE)) }));
        const onMark = ends.filter(({ end }) => nearMark(end) !== undefined).sort((a, b) => b.end - a.end)[0];
        const dbEnd = ends.find(({ end }) => databases.some((entry) => sameStart(seed, entry) && Math.abs(entry.end - end) <= END_TOLERANCE));
        // A shared stretch only shows the intro lasts at least that long. A
        // database entry for this very cut that starts with it and runs a
        // little further is consistent with that, and gives the real end.
        const longest = Math.max(...ends.map(({ end }) => end));
        // A chapter mark at the database's end lets it reach further.
        const reach = (entry) => (marks.some((mark) => Math.abs(mark - entry.end) <= MARK_TOLERANCE + 1) ? MAX_SECONDS[type] : DB_EXTEND_SECONDS);
        const extended = databases
            .filter((entry) => entry.sameCut === true && entry.votes >= 3 && sameStart(seed, entry) && entry.end > longest + END_TOLERANCE && entry.end <= longest + reach(entry))
            .map((entry) => ({ end: entry.end, weight: 1 }))[0];
        // Without confirmation, the end most matches share, and the later one
        // on a tie. Checked against the video, a shorter shared stretch was
        // almost always a neighbour with a trimmed intro, not the end of this
        // one. A disputed end is never skipped automatically (see below).
        const usual = ends.slice().sort((a, b) => b.weight - a.weight || b.end - a.end)[0];
        const chosen = onMark || dbEnd || extended || usual;
        const disputed = ends.some(({ end }) => Math.abs(end - chosen.end) > END_TOLERANCE) && chosen !== extended;
        const start = Math.min(...group.map((match) => match.start));
        const backing = databases.filter((entry) => agree({ start, end: chosen.end }, entry));
        const edges = snapToMarks({ start, end: chosen.end }, marks);
        const confirmed = Boolean(onMark) || backing.length > 0 || (chosen.weight >= 2 && !disputed);
        // A database entry for this very cut that puts the intro somewhere
        // else entirely. A short shared stretch near the start is then most
        // likely a studio logo, and the database is right; otherwise keep the
        // audio, but do not skip on it unattended.
        const elsewhere = databases.find((entry) => entry.sameCut === true && entry.votes >= 3
            && Math.min(entry.end, edges.end) - Math.max(entry.start, edges.start) <= 0);
        if (elsewhere && edges.end - edges.start <= LOGO_SECONDS) {
            return { type, start: elsewhere.start, end: elsewhere.end, confidence: 'medium', sources: [elsewhere.source] };
        }
        return {
            type,
            start: edges.start,
            end: edges.end,
            confidence: confirmed && !elsewhere ? 'high' : 'medium',
            sources: ['audio', ...backing.map((entry) => entry.source), ...(edges.snapped ? ['chapter-mark'] : [])],
        };
    }

    const fromDb = fromDatabases(databases, evidence.localDone === true && type === 'intro');
    if (fromDb) {
        // A partial audio match cannot place the edges, but it does show the
        // database is talking about this file.
        const weakBacking = audio.some((match) => match.start < fromDb.end && match.end > fromDb.start);
        const edges = snapToMarks(fromDb, marks);
        const confidence = fromDb.confidence === 'low' && (weakBacking || edges.snapped) ? 'medium' : fromDb.confidence;
        return { type, start: edges.start, end: edges.end, confidence, sources: fromDb.sources };
    }

    // A weak audio match with nothing else behind it is not offered at all:
    // checked against the video, it was a shared music cue inside a scene
    // (Lupin), and a button there would skip part of the episode.
    return null;
}

// ── Credits ─────────────────────────────────────────────────────────────────
//
// End credits usually play the same music every episode, often followed by a
// short studio card, so the audio shared with other episodes near the end is
// a chain of stretches with small gaps. The credits start where the chain
// that runs out the file begins. What can go wrong is a start too early: a
// score cue that recurs in the final act. So the chain must end near the
// file's end, and only one that runs right to it may advance to the next
// episode on its own; a longer unshared tail could be a preview or a scene
// after the credits, which only gets the popup.
const CREDITS_TAIL_MAX = 120; // unshared seconds after the chain, at most
const CREDITS_TO_END = 15; // a chain ending this close to the end runs to it
const CREDITS_CHAIN_GAP = 10;
const CREDITS_REACH = 600; // credits start in the last 10 minutes
const CREDITS_MIN_SECONDS = 10;
// How far before the shared music a credit roll seen in the picture may start.
const PICTURE_BEFORE_CHAIN = 10;
// The picture is read over the last 8 minutes at most, widened once.
const PICTURE_REACH = 900;
// The picture's start is to the frame: only a chapter mark this close moves it.
const PICTURE_MARK_TOLERANCE = 1.5;
// Shared music starting this close to the picture's start agrees with it.
const PICTURE_MUSIC_TOLERANCE = 3;
// Credits this close in length to those of this many other episodes agree...
const LEARNED_TOLERANCE = 2;
const LEARNED_EPISODES = 2;
// ...and stands in for one in a file within this much of the same length.
const LEARNED_SAME_LENGTH = 5;

function fuseCredits(evidence) {
    const type = 'credits';
    const duration = evidence.duration;
    const marks = evidence.chapters ? evidence.chapters.marks : [];
    const named = (evidence.chapters ? evidence.chapters.named : [])
        .filter((chapter) => chapter.type === type && plausible(type, chapter, duration));
    if (named.length > 0) return { type, start: named[0].start, end: named[0].end, confidence: 'high', sources: ['chapter'] };
    const databases = (evidence.database ? evidence.database.segments : [])
        .filter((entry) => entry.type === type && plausible(type, entry, duration));

    const chain = creditsChain(evidence);

    // The credits seen in the picture (creditText, creditFrames): their first
    // card is where the credits start, whatever the music does. Advancing on
    // its own needs it to run out the file and something else to agree on
    // the start, unless it is a roll on black that the strict test is sure of.
    const run = evidence.creditsPicture && evidence.creditsPicture.run;
    if (run && Number.isFinite(duration) && run.start >= duration - PICTURE_REACH && run.start < duration - CREDITS_MIN_SECONDS) {
        const mark = marks.find((time) => Math.abs(time - run.start) <= PICTURE_MARK_TOLERANCE);
        const start = mark !== undefined ? mark : run.start;
        // The shared music agrees only when it starts with the credits: music
        // that swells over the closing scene would agree with a start taken
        // from a poster in that scene too.
        const audio = Boolean(chain) && Math.abs(start - chain.start) <= PICTURE_MUSIC_TOLERANCE;
        const backing = databases.filter((entry) => entry.sameCut !== false && Math.abs(entry.start - start) <= START_TOLERANCE);
        // Credits as long as in two other episodes of the season.
        const learned = (evidence.creditsLengths || [])
            .filter((sample) => Math.abs(sample.seconds - (duration - start)) <= LEARNED_TOLERANCE).length >= LEARNED_EPISODES;
        const runsOut = run.runsOut === true || (run.runsOut === null && audio && chain.end >= duration - CREDITS_TO_END);
        const agreed = audio || backing.length > 0 || mark !== undefined || learned;
        return {
            type,
            start,
            end: runsOut ? duration : run.end,
            confidence: runsOut && (agreed || run.solid === true) ? 'high' : 'medium',
            sources: [
                'picture',
                ...(audio ? ['audio'] : []),
                ...backing.map((entry) => entry.source),
                ...(mark !== undefined ? ['chapter-mark'] : []),
                ...(learned ? ['season-length'] : []),
            ],
        };
    }

    if (chain) {
        const support = chain.matches
            .filter((match) => Math.abs(match.start - chain.start) <= START_TOLERANCE)
            .reduce((sum, match) => sum + (match.weight || 1), 0);
        // The picture's credit roll (creditFrames), when it starts within
        // the shared music: these are credits, not music over the final
        // scene, and the roll's first frame is where they start (the music
        // often begins a moment before the cut).
        const picture = evidence.creditsPicture && evidence.creditsPicture.roll;
        const rolled = Boolean(picture) && picture.start >= chain.start - PICTURE_BEFORE_CHAIN && picture.start <= chain.end;
        const near = rolled ? picture.start : chain.start;
        const mark = marks.find((time) => Math.abs(time - near) <= MARK_TOLERANCE);
        const start = mark !== undefined ? mark : near;
        // Not an entry made on a different cut: its times are for another file.
        const backing = databases.filter((entry) => entry.sameCut !== false && Math.abs(entry.start - start) <= START_TOLERANCE);
        const runsOut = chain.end >= duration - CREDITS_TO_END;
        // Other episodes sharing the music only shows it recurs: closing
        // music can start over the final scene. Advancing on its own needs
        // something that knows where the credits are: the picture, a
        // database, a chapter boundary, or the season's credits theme,
        // itself confirmed one of those ways.
        const themed = chain.matches.some((match) => (match.weight || 1) >= 2 && Math.abs(match.start - chain.start) <= START_TOLERANCE);
        const placed = rolled || backing.length > 0 || mark !== undefined || themed;
        return {
            type,
            start,
            end: runsOut ? duration : chain.end,
            confidence: runsOut && placed ? 'high' : (runsOut || placed || support >= 2 ? 'medium' : 'low'),
            sources: ['audio', ...(rolled ? ['picture'] : []), ...backing.map((entry) => entry.source), ...(mark !== undefined ? ['chapter-mark'] : [])],
        };
    }

    // No shared music (a new song every episode): the picture alone, only
    // when it is sure (creditFrames.findClosingRoll), and then it is high.
    const closing = evidence.creditsPicture && evidence.creditsPicture.closing;
    if (closing && Number.isFinite(duration) && closing.start >= duration - CREDITS_REACH) {
        const mark = marks.find((time) => Math.abs(time - closing.start) <= MARK_TOLERANCE);
        return {
            type,
            start: mark !== undefined ? mark : closing.start,
            end: duration,
            confidence: 'high',
            sources: ['picture', ...(mark !== undefined ? ['chapter-mark'] : [])],
        };
    }

    const fromDb = fromDatabases(databases, false);
    const edges = fromDb ? snapToMarks(fromDb, marks) : null;
    const dbConfidence = fromDb ? (fromDb.confidence === 'low' && edges.snapped ? 'medium' : fromDb.confidence) : null;
    if (fromDb && dbConfidence !== 'low') return { type, start: edges.start, end: edges.end, confidence: dbConfidence, sources: fromDb.sources };

    // Nothing measured on this file: the season's credits run about as long
    // in every episode of the same length, so where they usually start is
    // worth the popup, never an advance.
    const length = evidence.creditsLength;
    if (length && Number.isFinite(duration) && Math.abs(length.duration - duration) <= LEARNED_SAME_LENGTH) {
        const near = duration - length.seconds;
        const mark = marks.find((time) => Math.abs(time - near) <= MARK_TOLERANCE);
        return { type, start: mark !== undefined ? mark : near, end: duration, confidence: 'medium', sources: ['season-length'] };
    }
    return fromDb ? { type, start: edges.start, end: edges.end, confidence: dbConfidence, sources: fromDb.sources } : null;
}

// The chain of music shared with other episodes that runs out the file, if
// there is one (see fuseCredits).
function creditsChain(evidence) {
    const duration = evidence.duration;
    const strong = (evidence.creditsRepetition || [])
        .filter((match) => match.bitErrorRate <= STRONG_BIT_ERROR_RATE)
        .sort((a, b) => a.start - b.start);
    if (strong.length === 0 || !Number.isFinite(duration)) return null;
    const chains = [];
    for (const match of strong) {
        const chain = chains[chains.length - 1];
        if (chain && match.start <= chain.end + CREDITS_CHAIN_GAP) {
            chain.end = Math.max(chain.end, match.end);
            chain.matches.push(match);
        } else {
            chains.push({ start: match.start, end: match.end, matches: [match] });
        }
    }
    return chains.reverse().find((candidate) => candidate.end >= duration - CREDITS_TAIL_MAX
        && candidate.start >= duration - CREDITS_REACH && candidate.end - candidate.start >= CREDITS_MIN_SECONDS) || null;
}

/**
 * @param {{
 *   duration?: number,
 *   chapters?: { named: Array, marks: number[] } | null,
 *   database?: { segments: Array } | null,
 *   repetition?: Array<{ start: number, end: number, bitErrorRate: number, weight?: number }>,
 *   creditsRepetition?: Array<{ start: number, end: number, bitErrorRate: number, weight?: number }>,
 *   localDone?: boolean,
 * }} evidence
 * @returns {Array<{ type: string, start: number, end: number, confidence: 'high'|'medium'|'low', sources: string[] }>}
 */
function fuse(evidence) {
    return TYPES
        .map((type) => (type === 'credits' ? fuseCredits(evidence) : fuseType(type, evidence)))
        .filter(Boolean)
        // Failsafe: a segment longer than any real intro or recap is offered
        // as a button but never skipped on its own, whatever backs it.
        .map((segment) => (segment.confidence === 'high' && AUTO_SKIP_MAX_SECONDS[segment.type] && segment.end - segment.start > AUTO_SKIP_MAX_SECONDS[segment.type]
            ? { ...segment, confidence: 'medium' }
            : segment))
        .sort((a, b) => a.start - b.start);
}

// Where the episode's first frame is, near the end the intro's audio (or a
// chapter mark) gives. Checked against the picture on 11 shows, that end was
// up to 2.5 s early (a black gap or creator credit after the theme, or the
// theme playing on over black) or up to 0.7 s late. Landing at the end of a
// black stretch that touches it, or else on a hard cut close to it, put all
// 11 on the first frame. A montage cut inside the intro is a risk, so only a
// cut this close is taken.
const BLACK_BEFORE = 1;
const BLACK_AFTER = 1.5;
const BLACK_MIN = 0.2; // shorter blacks are flicker inside the title (The IT Crowd)
const BLACK_MAX_PAST_END = 5;
const CUT_BEFORE = 0.8;
const CUT_AFTER = 0.8;

// A fade in from black still counts as black to ffmpeg for a while: Star
// Trek: TNG's opening starfield for 1.3 s. The episode starts at the frame
// after the last one still at the black level, looking back from where the
// black was said to end (so noise early in the black does not matter).
const DARK_TOLERANCE = 0.0025; // of the luma range
function firstLight([from, to], luma) {
    const inside = luma.filter(([time]) => time >= from - 0.05 && time <= to + 0.05);
    if (inside.length < 2) return to;
    const floor = Math.min(...inside.map(([, value]) => value));
    // Limited-range black is 16 in 8-bit sources and 64 in 10-bit ones.
    const tolerance = (floor >= 48 ? 876 : 219) * DARK_TOLERANCE;
    for (let i = inside.length - 1; i > 0; i--) {
        if (inside[i - 1][1] <= floor + tolerance && inside[i][0] <= to + 0.05) return inside[i][0];
    }
    return to;
}

/**
 * @param {number} end - seconds
 * @param {{ cuts: number[], blacks: Array<[number, number]>, luma?: Array<[number, number]> }} scene - from the launcher's /scene-cuts
 * @returns {number} the refined end
 */
function landingAfter(end, scene) {
    const luma = scene.luma || [];
    const black = (scene.blacks || []).find(([from, to]) => to - from >= BLACK_MIN
        && from <= end + BLACK_AFTER && to >= end - BLACK_BEFORE && to - end <= BLACK_MAX_PAST_END);
    if (black) return firstLight(black, luma);
    const cut = (scene.cuts || [])
        .filter((time) => time >= end - CUT_BEFORE && time <= end + CUT_AFTER)
        .sort((a, b) => Math.abs(a - end) - Math.abs(b - end))[0];
    if (cut !== undefined) return cut;
    // A title or creator card can hold still for a moment after the music
    // before the episode starts: Bluey's title card, 1.1 s to the cut; The
    // Big Bang Theory's creator credit, 2.4 s, then black. When the picture
    // does not change from the end to the next black stretch or cut, land
    // there. A first shot of the episode would move, so that is never skipped.
    const nextBlack = (scene.blacks || []).find(([from, to]) => to - from >= BLACK_MIN && from > end && from <= end + STILL_REACH && to - end <= BLACK_MAX_PAST_END);
    const nextCut = (scene.cuts || []).filter((time) => time > end && time <= end + STILL_REACH).sort((a, b) => a - b)[0];
    if (nextBlack && (nextCut === undefined || nextBlack[0] <= nextCut) && still(end, nextBlack[0], luma)) return firstLight(nextBlack, luma);
    if (nextCut !== undefined && still(end, nextCut, luma)) return nextCut;
    return end;
}

// How far after the end a still card may run, and how little the mean
// brightness may vary across it to count as still.
const STILL_REACH = 3;
const STILL_TOLERANCE = 0.01; // of the luma range

function still(from, to, luma) {
    const frames = luma.filter(([time]) => time >= from - 0.05 && time < to - 0.05).map(([, value]) => value);
    if (frames.length < 3) return false;
    const low = Math.min(...frames);
    return Math.max(...frames) - low <= (low >= 48 ? 876 : 219) * STILL_TOLERANCE;
}

module.exports = {
    STRONG_BIT_ERROR_RATE,
    agree,
    fuse,
    landingAfter,
};
