// Where the story ends, which is where the next episode is offered and,
// four seconds later, played. The credits starting is not always it: names
// often run over the last scene while it is still playing (Seinfeld's
// stand-up, a sitcom's tag scene under the cast list, a party montage). So
// the end is the credits start, the last words spoken over the picture, or
// the last of the scene still moving under the names, whichever is latest.
//
// Not everything after the credits start is story:
// - a roll of credits on black: the story is over once it starts, and the
//   singing under it is the theme song (Two and a Half Men, Ted Lasso);
// - the studio logos closing the file, with their own voices and jingles
//   (Brooklyn Nine-Nine, The Simpsons);
// - credits over still art (The Mandalorian's concept paintings): no speech
//   and hardly any movement.
// A scene with talking after the roll is an extra scene (Rick and Morty),
// and the viewer wants to see it: then the end is after it.

// A roll on black: dark frames, nearly all with text, for at least this
// long, with little talking. A single card on black before a closing scene
// (Friends) is too short; a dark comedy club with a comic talking over the
// names (Seinfeld) has too much talking and too little text.
const ROLL_SECONDS = 12;
const ROLL_TEXT_SHARE = 0.75;
const ROLL_SPEECH_SHARE = 0.6;
// Dark frames inside a roll can be broken by this much (a logo card).
const ROLL_GAP_SECONDS = 4;
// Speech running on this far into the roll is singing over it.
const INTO_ROLL_SECONDS = 1.5;
// Logos: two coarse frames in a row this different from the one before,
// in the file's last seconds. A cut in a scene changes one frame.
const LOGO_MOTION = 90;
const LOGO_WITHIN_SECONDS = 30;
// A scene still playing: out of the dark, and the picture changing by at
// least this much (median over five coarse frames). Still art and slow
// pans over paintings change less.
const LIVE_MOTION = 10;
const LIVE_WINDOW = 5;
// An extra scene after the roll: this long out of the dark, with at least
// this much talking. A voice over the closing logos is shorter.
const SCENE_SECONDS = 12;
const SCENE_SPEECH_SECONDS = 3;
// Speech this short is a gasp or a laugh, not a line.
const MIN_WORDS_SECONDS = 0.4;

const spoken = (speech, from, to) => (speech || [])
    .filter((words) => words.end - words.start >= MIN_WORDS_SECONDS && words.end > from && words.start < to)
    .reduce((sum, words) => sum + Math.min(words.end, to) - Math.max(words.start, from), 0);

/**
 * The first roll on black from frame `first` on, as frame indexes.
 *
 * @param {Array<{ dark: boolean, text: boolean }>} frames
 */
function findRoll(frames, first, fps, at, speech) {
    const gap = Math.max(1, Math.round(ROLL_GAP_SECONDS * fps));
    const need = Math.round(ROLL_SECONDS * fps);
    for (let i = first; i < frames.length; i++) {
        if (!frames[i].dark) continue;
        // Up to the last dark frame with text: the dark logo cards after a
        // roll are not part of it.
        let last = i;
        let reach = i;
        let dark = 0;
        let text = 0;
        let darkThen = 0;
        let miss = 0;
        for (let k = i; k < frames.length; k++) {
            if (frames[k].dark) {
                reach = k;
                dark++;
                miss = 0;
                if (frames[k].text) {
                    text++;
                    last = k;
                    darkThen = dark;
                }
            } else if (++miss > gap) {
                break;
            }
        }
        const seconds = (last - i + 1) / fps;
        if (last - i + 1 >= need && text >= darkThen * ROLL_TEXT_SHARE
            && spoken(speech, at(i), at(last + 1)) <= seconds * ROLL_SPEECH_SHARE) {
            return { from: i, to: last };
        }
        i = reach;
    }
    return null;
}

// Where the closing logos start, as a frame index (or -1).
function findLogos(frames, first, fps, at, duration) {
    for (let i = first; i + 1 < frames.length; i++) {
        if (at(i) < duration - LOGO_WITHIN_SECONDS) continue;
        if ((frames[i].motion || 0) >= LOGO_MOTION && (frames[i + 1].motion || 0) >= LOGO_MOTION) return i;
    }
    return -1;
}

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// A scene still playing moves in every frame a little at least, into the
// next one too: a still card right after a moving scene (a vanity card)
// does not count, though its first frame differs from the scene's last and
// the median around it still holds the scene's frames.
const LIVE_OWN_MOTION = 5;
const isLive = (frames, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].motion || 0 : Infinity;
    if (frames[i].dark || Math.min(frames[i].motion || 0, next) < LIVE_OWN_MOTION) return false;
    const half = Math.floor(LIVE_WINDOW / 2);
    const near = frames.slice(Math.max(0, i - half), i + half + 1).map((frame) => frame.motion || 0);
    return median(near) >= LIVE_MOTION;
};

/**
 * @param {{
 *   start: number,
 *   frames: Array<{ dark: boolean, text: boolean, motion?: number }>, framesFrom: number, fps: number,
 *   speech: Array<{ start: number, end: number }> | null,
 *   duration: number,
 * }} options - `start` where the credits start; `frames` the picture's
 *   coarse verdicts from `framesFrom` seconds at `fps` to the end of the
 *   file; `speech` what was heard from `start` on (null when not known)
 * @returns {{ end: number, words: number | null, live: number | null, roll: number | null, logos: number | null, scene: boolean }}
 *   `end` where the story ends, before snapping to the picture's cuts;
 *   `words` and `live` the last words and the last moving frame that moved
 *   it; `roll` and `logos` where those start; `scene` whether an extra scene
 *   follows the roll
 */
function storyEnd({ start, frames, framesFrom, fps, speech, duration }) {
    const result = { end: start, by: 'start', words: null, live: null, roll: null, logos: null, scene: false };
    if (!frames || frames.length === 0) return result;
    const at = (i) => framesFrom + i / fps;
    const first = Math.max(0, Math.ceil((start - framesFrom) * fps - 0.01));
    const roll = findRoll(frames, first, fps, at, speech);
    const logos = findLogos(frames, first, fps, at, duration);
    if (roll) result.roll = at(roll.from);
    if (logos >= 0) result.logos = at(logos);
    const storyTo = Math.min(roll ? at(roll.from) : duration, logos >= 0 ? at(logos) : duration);

    // The scene still playing under the names.
    for (let i = first; i < frames.length && at(i) < storyTo; i++) {
        if (isLive(frames, i)) result.live = at(i);
    }
    // The last words over it; not singing that carries on into the roll.
    const words = (speech || []).filter((w) => w.end - w.start >= MIN_WORDS_SECONDS && w.end > start && w.start < storyTo
        && !(roll && w.end > storyTo + INTO_ROLL_SECONDS));
    if (words.length > 0) result.words = Math.min(storyTo, Math.max(...words.map((w) => w.end)));
    if (result.words !== null && result.words > result.end) {
        result.end = result.words;
        result.by = 'words';
    }
    if (result.live !== null && result.live >= result.end) {
        result.end = result.live;
        result.by = 'live';
    }
    // A scene still going under the names plays until the cut to the roll
    // (The Simpsons' last shot holds, still, under the song).
    if (roll && result.by !== 'start') {
        result.end = at(roll.from);
        result.by = 'roll';
    }

    // After the roll: picture out of the dark for a while, with talking. It
    // ends with its last words or its last moving frame, whichever is later.
    if (roll && speech) {
        let i = roll.to + 1;
        while (i < frames.length) {
            while (i < frames.length && frames[i].dark) i++;
            let k = i;
            while (k + 1 < frames.length && !frames[k + 1].dark) k++;
            const to = Math.min(at(k + 1), logos >= 0 && logos > roll.to ? at(logos) : Infinity);
            if (i < frames.length && to - at(i) >= SCENE_SECONDS && spoken(speech, at(i), to) >= SCENE_SPEECH_SECONDS) {
                const lines = speech.filter((w) => w.end - w.start >= MIN_WORDS_SECONDS && w.end > at(i) && w.start < to);
                result.scene = true;
                result.words = Math.max(...lines.map((w) => Math.min(w.end, to)));
                result.end = result.words;
                result.by = 'words';
                for (let f = i; f <= k && at(f) < to; f++) {
                    if (isLive(frames, f) && at(f) >= result.end) {
                        result.live = at(f);
                        result.end = at(f);
                        result.by = 'live';
                    }
                }
            }
            i = k + 1;
        }
    }
    return result;
}

// After the last words or the last moving frame the scene still holds a
// moment: the end moves on to the next cut or fade to black, this far at
// most, else this long after.
const SNAP_SECONDS = 5;
const HOLD_SECONDS = 1;

/**
 * The story end on the picture's own boundary: the next cut or black
 * within a few seconds after `time`, else a second after it.
 *
 * @param {{ cuts: number[], blacks: Array<[number, number]> } | null} scene
 */
function snapAfter(time, scene) {
    if (!scene) return time + HOLD_SECONDS;
    const edges = scene.cuts.concat(scene.blacks.map(([from]) => from))
        .filter((edge) => edge >= time - 0.25 && edge <= time + SNAP_SECONDS);
    return edges.length > 0 ? Math.max(time, Math.min(...edges)) : time + HOLD_SECONDS;
}

/**
 * The end of a scene seen moving at coarse frame `time` and not at the next
 * one (`step` later): the last cut or black between them, else the next
 * frame's time.
 */
function snapLive(time, step, scene) {
    if (!scene) return time + step;
    const edges = scene.cuts.concat(scene.blacks.map(([from]) => from))
        .filter((edge) => edge >= time && edge <= time + step + 0.25);
    return edges.length > 0 ? Math.max(...edges) : time + step;
}

/**
 * The story end snapped onto the picture's boundary: unchanged when it is
 * the credits start (already snapped), the next cut after the last words,
 * the cut to the roll, or the cut ending the scene still moving. A black
 * screen after the last words ends the story there, whatever moves after
 * it: the closing logos (Seinfeld's black card, then Castle Rock's).
 *
 * @param {{ cuts: number[], blacks: Array<[number, number]> } | null} scene
 *   the scene cuts from the last words (or a little before the end) on
 */
function snapStoryEnd(story, start, step, scene) {
    if (story.by === 'start' || story.end <= start) return start;
    if (story.by === 'words') return snapAfter(story.words, scene);
    if (story.by === 'roll') return snapLive(story.end - step, step, scene);
    if (scene && story.words !== null && story.words < story.end) {
        const black = scene.blacks.map(([from]) => from).filter((from) => from >= story.words && from <= story.end + step);
        if (black.length > 0) return Math.min(...black);
    }
    return snapLive(story.end, step, scene);
}

/**
 * The stretch the scene cuts are needed for to snap the story end: from the
 * last words when they came shortly before, else a little before the end;
 * at most 15 s (the launcher's longest scene read).
 */
function snapWindow(story, step) {
    const to = story.end + step + 0.5;
    const from = story.words !== null && story.words < story.end ? Math.max(story.words - 0.5, to - 15) : story.end - step - 1;
    return { from: Math.max(0, from), to };
}

module.exports = {
    storyEnd,
    snapAfter,
    snapLive,
    snapStoryEnd,
    snapWindow,
};
