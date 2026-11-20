// Where the story ends, which is where the next episode is offered and,
// four seconds later, played. The credits starting is not always it: names
// often run over the last scene while people are still talking (Seinfeld's
// stand-up, a sitcom's tag scene under the cast list). So the end is the
// credits start or the last words spoken over the picture after it,
// whichever is later.
//
// Not every voice is the story. Singing under a roll of credits on black is
// the theme song (Two and a Half Men), and a line over the studio logo at
// the very end is a gag (The Simpsons): once a roll on black has started,
// the story is over. A scene with talking after the roll is an extra scene,
// and the viewer wants to see it: then the end is after it.

// A roll on black: dark frames, most with text, for at least this long. A
// single card on black before a closing scene (Friends) is not one.
const ROLL_SECONDS = 12;
const ROLL_TEXT_SHARE = 0.5;
// Dark frames inside a roll can be broken by this much (a logo card).
const ROLL_GAP_SECONDS = 4;
// An extra scene after the roll: this long out of the dark, with at least
// this much talking. A voice over the closing logos is shorter.
const SCENE_SECONDS = 12;
const SCENE_SPEECH_SECONDS = 3;
// Speech this short is a gasp or a laugh, not a line.
const MIN_WORDS_SECONDS = 0.4;

/**
 * The first roll on black from `from` on, as frame indexes.
 *
 * @param {Array<{ dark: boolean, text: boolean }>} frames
 */
function findRoll(frames, first, fps) {
    const gap = Math.max(1, Math.round(ROLL_GAP_SECONDS * fps));
    const need = Math.round(ROLL_SECONDS * fps);
    for (let i = first; i < frames.length; i++) {
        if (!frames[i].dark) continue;
        let last = i;
        let dark = 0;
        let text = 0;
        let miss = 0;
        for (let k = i; k < frames.length; k++) {
            if (frames[k].dark) {
                last = k;
                dark++;
                if (frames[k].text) text++;
                miss = 0;
            } else if (++miss > gap) {
                break;
            }
        }
        if (last - i + 1 >= need && text >= dark * ROLL_TEXT_SHARE) return { from: i, to: last };
        i = last;
    }
    return null;
}

const talking = (speech, from, to) => speech
    .filter((words) => words.end - words.start >= MIN_WORDS_SECONDS && words.end > from && words.start < to)
    .map((words) => ({ start: Math.max(words.start, from), end: Math.min(words.end, to) }));

/**
 * @param {{
 *   start: number,
 *   frames: Array<{ dark: boolean, text: boolean }>, framesFrom: number, fps: number,
 *   speech: Array<{ start: number, end: number }> | null,
 *   duration: number,
 * }} options - `start` where the credits start; `frames` the picture's
 *   verdicts from `framesFrom` seconds at `fps` to the end of the file;
 *   `speech` the speech heard from `start` on (null when not known)
 * @returns {{ end: number, words: number | null, roll: number | null, scene: boolean }}
 *   `end` where the story ends (before snapping to the picture's cuts),
 *   `words` the last words that moved it, `roll` where a roll on black
 *   starts, `scene` whether an extra scene follows the roll
 */
function storyEnd({ start, frames, framesFrom, fps, speech, duration }) {
    const at = (i) => framesFrom + i / fps;
    const first = Math.max(0, Math.ceil((start - framesFrom) * fps));
    const roll = frames && frames.length > 0 ? findRoll(frames, first, fps) : null;
    const storyTo = roll ? at(roll.from) : duration;
    const result = { end: start, words: null, roll: roll ? at(roll.from) : null, scene: false };
    if (!speech) return result;

    const words = talking(speech, start, storyTo);
    if (words.length > 0) {
        result.words = Math.max(...words.map((w) => w.end));
        result.end = Math.max(start, result.words);
    }

    // After the roll: picture out of the dark for a while, with talking.
    if (roll) {
        let i = roll.to + 1;
        while (i < frames.length) {
            while (i < frames.length && frames[i].dark) i++;
            let k = i;
            while (k + 1 < frames.length && !frames[k + 1].dark) k++;
            if (i < frames.length && (k - i + 1) / fps >= SCENE_SECONDS) {
                const lines = talking(speech, at(i), at(k + 1));
                const said = lines.reduce((sum, w) => sum + (w.end - w.start), 0);
                if (said >= SCENE_SPEECH_SECONDS) {
                    result.scene = true;
                    result.words = Math.max(...lines.map((w) => w.end));
                    result.end = Math.max(result.end, result.words);
                }
            }
            i = k + 1;
        }
    }
    return result;
}

// After the last words the scene still holds for a laugh or a look: the end
// moves on to the next cut or fade to black, this far at most.
const SNAP_AFTER_WORDS = 5;
const WORDS_TAIL = 1;

/**
 * The story end on the picture's own boundary: after the last words, the
 * next cut or black within a few seconds, else a second after them.
 *
 * @param {{ cuts: number[], blacks: Array<[number, number]> } | null} scene
 */
function snapAfterWords(words, scene) {
    if (!scene) return words + WORDS_TAIL;
    const edges = scene.cuts.concat(scene.blacks.map(([from]) => from))
        .filter((edge) => edge >= words - 0.25 && edge <= words + SNAP_AFTER_WORDS);
    return edges.length > 0 ? Math.max(words, Math.min(...edges)) : words + WORDS_TAIL;
}

module.exports = {
    storyEnd,
    snapAfterWords,
    ROLL_SECONDS,
};
