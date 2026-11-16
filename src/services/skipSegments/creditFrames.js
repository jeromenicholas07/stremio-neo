// Recognises an end-credits roll in small grayscale frames (160x90, 2 per
// second, from the launcher's /frames). Credits are text on a dark
// background: most of the frame is dark, and several horizontal bands carry
// the dense, sharp strokes of letters. What else is dark with bright detail
// is kept out by those bands: a starfield has scattered points rather than
// dense rows, burned-in subtitles sit only in the bottom fifth, and a
// letter, phone or "three weeks later" card is too short to count as a roll.
// Credits over footage are not recognised at all, which only means the
// credits are not confirmed this way (no auto-next), never a wrong one.

const DARK_LEVEL = 25; // near black: limited-range black is 16
// Measured share of near-black pixels: credit frames 87-99%; dark final shots
// well below (a room lit by a window 32-39%, a sign or car window at night).
const DARK_SHARE = 0.85;
// The longest bright run in a line of text: letter strokes are short, a lit
// sign or window behind text is a long run (measured 2-13 vs 11-39 px).
const MAX_BRIGHT_RUN = 16;
// Thin small text averages down to grey at this size (The Sopranos' crew list).
const BRIGHT_LEVEL = 100;
const STROKE = 45; // brightness step between neighbouring pixels in a letter
const TEXT_ROW_STROKES = 10;
const TEXT_ROW_BRIGHT = 3;
const BAND_MAX_ROWS = 10; // taller is an object, not a line of text
const MIN_BANDS = 2;
const SUBTITLE_TOP = 0.78; // subtitles live below this fraction of the height

/**
 * @param {Uint8Array} pixels - one frame, row by row
 * @returns {{ dark: number, bands: Array<{ top: number, bottom: number, run: number }> }}
 *   `run` is the longest bright run in the band's rows
 */
function frameFeatures(pixels, width, height) {
    let dark = 0;
    const bands = [];
    let open = null;
    for (let y = 0; y < height; y++) {
        let strokes = 0;
        let bright = 0;
        let run = 0;
        let longest = 0;
        const row = y * width;
        for (let x = 0; x < width; x++) {
            const value = pixels[row + x];
            if (value < DARK_LEVEL) dark++;
            if (value > BRIGHT_LEVEL) {
                bright++;
                run++;
                if (run > longest) longest = run;
            } else {
                run = 0;
            }
            if (x + 1 < width && Math.abs(pixels[row + x + 1] - value) >= STROKE) strokes++;
        }
        const text = strokes >= TEXT_ROW_STROKES && bright >= TEXT_ROW_BRIGHT;
        if (text && open === null) open = { top: y, bottom: y, run: longest };
        else if (text) {
            open.bottom = y;
            open.run = Math.max(open.run, longest);
        } else if (open !== null) {
            bands.push(open);
            open = null;
        }
    }
    if (open !== null) bands.push(open);
    return { dark: dark / (width * height), bands };
}

function isCreditsFrame(features, height) {
    if (features.dark < DARK_SHARE) return false;
    const lines = features.bands.filter((band) => band.bottom - band.top + 1 <= BAND_MAX_ROWS);
    // A single line counts only on near-total black: the one-name cards a
    // roll often opens with ("Producer  Cami Patton", Justified).
    if (lines.length < (features.dark >= SINGLE_LINE_DARK ? 1 : MIN_BANDS)) return false;
    if (lines.some((band) => band.run > MAX_BRIGHT_RUN)) return false;
    return !lines.every((band) => band.top >= height * SUBTITLE_TOP);
}
const SINGLE_LINE_DARK = 0.95;

// A mostly dark frame (black between cards, a studio logo card after them)
// does not break a roll, but a roll cannot start on it.
const isDarkFrame = (features) => features.dark >= DARK_SHARE;

// A roll's first seconds must hold: one dark shot that looks like text just
// before the credits (a car interior in Peep Show) is not where they start.
const HOLD_SECONDS = 3;
const HOLD_SHARE = 5 / 6;

/**
 * The credit roll in a run of frames: the earliest credits-like frame, no
 * earlier than `from`, from which at least `share` of the frames to the end
 * of what was read are credits-like, for at least `minSeconds`. Null when
 * there is none: the credits do not reach the end of the read, are over
 * footage, or are not there.
 *
 * @param {Uint8Array} data - frames back to back
 * @param {{ start: number, fps: number, width: number, height: number, from?: number, atEnd?: boolean }} options -
 *   seconds; `atEnd` when the frames reach the end of the file, whose last
 *   seconds (studio and network logos) then do not count against the roll
 * @returns {{ start: number, end: number } | null}
 */
function findCreditRoll(data, { start, fps, width, height, from = start, minSeconds = 12, share = 0.8, atEnd = false, startOnList = false }) {
    const size = width * height;
    const read = Math.floor(data.length / size);
    const count = atEnd ? Math.max(1, read - Math.round(LOGO_TAIL_SECONDS * fps)) : read;
    const text = [];
    const fits = [];
    for (let i = 0; i < count; i++) {
        const features = frameFeatures(data.subarray(i * size, (i + 1) * size), width, height);
        const credits = isCreditsFrame(features, height);
        // `startOnList`: the roll may only start on a list of names, not on
        // a card of one or two lines, which could be the story's last words.
        text.push(credits && (!startOnList || isListFrame(features)));
        fits.push(credits || isDarkFrame(features));
    }
    const after = new Array(count + 1).fill(0);
    for (let i = count - 1; i >= 0; i--) after[i] = after[i + 1] + (fits[i] ? 1 : 0);
    const hold = Math.max(1, Math.round(HOLD_SECONDS * fps));
    const first = Math.max(0, Math.ceil((from - start) * fps));
    for (let i = first; i < count; i++) {
        const left = count - i;
        if (left / fps < minSeconds) break;
        if (!text[i] || after[i] / left < share) continue;
        if ((after[i] - after[Math.min(count, i + hold)]) / Math.min(hold, left) < HOLD_SHARE) continue;
        return { start: start + i / fps, end: start + read / fps };
    }
    return null;
}

// Studio and network logos close many files (FX, Sony: grey, not dark).
const LOGO_TAIL_SECONDS = 10;

// A list of credits: several thin lines of names (measured 4-16 lines on
// credit frames). A closing story card ("In memory of", an epilogue) has a
// line or two.
const LIST_LINES = 4;
function isListFrame(features) {
    return features.bands.filter((band) => band.bottom - band.top + 1 <= BAND_MAX_ROWS).length >= LIST_LINES;
}

/**
 * Credits from the picture alone, at the very end of a file, held to a
 * stricter standard than a roll that only confirms shared music: it has to
 * run to the end of the file, for at least 20 s, with nearly every frame
 * credits-like, and it starts on the first list of names. Late on a roll
 * that opens with single cards, never early.
 *
 * @param {Uint8Array} data - frames back to back, reaching the end of the file
 * @param {{ start: number, fps: number, width: number, height: number }} options - seconds
 * @returns {{ start: number, end: number } | null}
 */
function findClosingRoll(data, options) {
    return findCreditRoll(data, { ...options, atEnd: true, startOnList: true, minSeconds: 20, share: 0.9 });
}

module.exports = {
    frameFeatures,
    isCreditsFrame,
    findCreditRoll,
    findClosingRoll,
};
