// Credits from the text in the picture, on any background: the text
// detector (textDetector, a PaddleOCR detection model) marks where letters
// are in each frame, and this file decides which frames look like credits and
// where a run of them starts.
//
// Credits are lines of small text stacked in a column: a roll scrolling up,
// a list of names, or a card of a role and a name or two, over black or over
// the closing scene. What else has text is kept out by shape and by time:
// subtitles sit at the bottom and are one or two lines, a sign or a phone
// screen is one block that does not last, and a story card ("Three weeks
// later") is a single line. Over footage the run must also last: credits
// change card every few seconds for well over a minute.

const PROBABILITY = 0.3; // a pixel is text above this
const BOX_SCORE = 0.55; // a component's mean probability, below it is noise
const MIN_BOX_HEIGHT = 3; // px on a 352-high frame: thin crew-list text is 4-6
const MIN_BOX_WIDTH = 6;
const MAX_LINE_HEIGHT = 0.1; // of the frame height; taller is a title or a sign
const SUBTITLE_TOP = 0.75; // lines starting below this are subtitles
const STACK_GAP = 2.4; // line gaps, in line heights, still in one column
const STACK_HEIGHT_RATIO = 2; // lines in one column are about the same size
const ALIGN = 0.06; // of the width: lefts, rights or centres this close line up
// Lines of a credits column are words: each this wide at least, the widest
// wider still (a skull's eyes and teeth on a window are two tiny "lines").
const MIN_COLUMN_LINE_WIDTH = 0.035;
const MIN_COLUMN_WIDEST = 0.08;

/**
 * Text boxes from the detector's probability map: connected areas of
 * text pixels, kept when the model is sure enough of them.
 *
 * @param {Float32Array} map - probabilities, row by row
 * @returns {Array<{ x0: number, y0: number, x1: number, y1: number }>}
 */
function boxesFromMap(map, width, height) {
    const labels = new Int32Array(width * height);
    const boxes = [];
    const stack = [];
    let next = 1;
    for (let start = 0; start < map.length; start++) {
        if (labels[start] !== 0 || map[start] <= PROBABILITY) continue;
        const label = next++;
        labels[start] = label;
        stack.push(start);
        let x0 = width, y0 = height, x1 = -1, y1 = -1, sum = 0, count = 0;
        while (stack.length > 0) {
            const at = stack.pop();
            const x = at % width;
            const y = (at - x) / width;
            sum += map[at];
            count++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
            if (x > 0 && labels[at - 1] === 0 && map[at - 1] > PROBABILITY) { labels[at - 1] = label; stack.push(at - 1); }
            if (x + 1 < width && labels[at + 1] === 0 && map[at + 1] > PROBABILITY) { labels[at + 1] = label; stack.push(at + 1); }
            if (y > 0 && labels[at - width] === 0 && map[at - width] > PROBABILITY) { labels[at - width] = label; stack.push(at - width); }
            if (y + 1 < height && labels[at + width] === 0 && map[at + width] > PROBABILITY) { labels[at + width] = label; stack.push(at + width); }
        }
        if (sum / count < BOX_SCORE) continue;
        if (y1 - y0 + 1 < MIN_BOX_HEIGHT || x1 - x0 + 1 < MIN_BOX_WIDTH) continue;
        boxes.push({ x0, y0, x1, y1 });
    }
    return boxes;
}

/**
 * Boxes side by side on the same baseline joined into lines (the detector
 * splits a line at wide gaps, "Director of Photography   JOHN SMITH").
 */
function linesFromBoxes(boxes) {
    const sorted = boxes.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const lines = [];
    for (const box of sorted) {
        const height = box.y1 - box.y0 + 1;
        const line = lines.find((other) => {
            const overlap = Math.min(other.y1, box.y1) - Math.max(other.y0, box.y0) + 1;
            const otherHeight = other.y1 - other.y0 + 1;
            const gap = Math.max(other.x0, box.x0) - Math.min(other.x1, box.x1);
            return overlap >= 0.5 * Math.min(height, otherHeight) && gap <= 6 * Math.max(height, otherHeight);
        });
        if (line) {
            line.x0 = Math.min(line.x0, box.x0);
            line.x1 = Math.max(line.x1, box.x1);
            line.y0 = Math.min(line.y0, box.y0);
            line.y1 = Math.max(line.y1, box.y1);
        } else {
            lines.push({ ...box });
        }
    }
    return lines.sort((a, b) => a.y0 - b.y0);
}

function lineHeight(line) {
    return line.y1 - line.y0 + 1;
}

function aligned(a, b, width) {
    const tolerance = ALIGN * width;
    return Math.abs(a.x0 - b.x0) <= tolerance
        || Math.abs(a.x1 - b.x1) <= tolerance
        || Math.abs((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2) <= tolerance;
}

/**
 * The tallest column of lines in a frame: consecutive lines of about the
 * same size, close above one another and lined up on one side or the centre.
 *
 * @returns {Array<{ x0: number, y0: number, x1: number, y1: number }>}
 */
function tallestColumn(lines, width, height) {
    const small = lines.filter((line) => lineHeight(line) <= MAX_LINE_HEIGHT * height && line.x1 - line.x0 + 1 >= MIN_COLUMN_LINE_WIDTH * width);
    let best = [];
    const used = new Set();
    for (let i = 0; i < small.length; i++) {
        if (used.has(i)) continue;
        const column = [small[i]];
        used.add(i);
        for (let j = i + 1; j < small.length; j++) {
            if (used.has(j)) continue;
            const last = column[column.length - 1];
            const line = small[j];
            const size = Math.max(lineHeight(last), lineHeight(line));
            const ratio = size / Math.min(lineHeight(last), lineHeight(line));
            if (line.y0 - last.y1 > STACK_GAP * size) break;
            if (ratio <= STACK_HEIGHT_RATIO && aligned(last, line, width)) {
                column.push(line);
                used.add(j);
            }
        }
        if (column.length > best.length) best = column;
    }
    return best;
}

// A lone credit line ("Co-Producer  DAVID HYMAN"): this wide at least, small
// text, in the lower part of the picture where such credits go (T-shirts,
// signs and lights in a scene are mostly higher up).
const MIN_LONE_LINE_WIDTH = 0.08;
const MAX_LONE_LINE_HEIGHT = 0.06;
const LONE_LINE_TOP = 0.7;

/**
 * One frame's verdict from its text lines.
 *
 * @returns {{ text: boolean, weak: boolean, weakY: number | null, box: number[] | null, list: boolean, lines: number }}
 *   `text`: credits-like text (a column of two or more lines above the
 *   subtitles, or three or more anywhere); `weak`: that, or a lone line of
 *   small text low in the picture, which some shows run their credits as
 *   (Parks and Recreation) and which only counts in a run that lasts to the
 *   end of the file, at the same height as the rest of it; `weakY` where
 *   that line is (its middle, as a share of the height); `box` around the
 *   column (or the lone line), [x0, y0, x1, y1] in pixels; `list`: four or
 *   more lines
 */
function textFrame(lines, width, height) {
    const column = tallestColumn(lines, width, height);
    const aboveSubtitles = column.some((line) => line.y0 < SUBTITLE_TOP * height);
    const wide = column.some((line) => line.x1 - line.x0 + 1 >= MIN_COLUMN_WIDEST * width);
    const text = wide && (column.length >= 3 || (column.length >= 2 && aboveSubtitles));
    const lone = lines
        .filter((line) => lineHeight(line) <= MAX_LONE_LINE_HEIGHT * height && line.x1 - line.x0 + 1 >= MIN_LONE_LINE_WIDTH * width && line.y0 >= LONE_LINE_TOP * height)
        .sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0];
    const weakY = lone ? (lone.y0 + lone.y1) / 2 / height : null;
    const around = text ? column : (lone ? [lone] : []);
    const box = around.length > 0
        ? [Math.min(...around.map((l) => l.x0)), Math.min(...around.map((l) => l.y0)), Math.max(...around.map((l) => l.x1)), Math.max(...around.map((l) => l.y1))]
        : null;
    return { text, weak: text || Boolean(lone), weakY, box, list: column.length >= 4, lines: column.length };
}

// ── Runs ────────────────────────────────────────────────────────────────────

// Between cards over footage there are a few seconds of the scene alone.
const MAX_GAP_SECONDS = 4;
// A run's first seconds must hold, so one shot of a page of text before the
// credits is not where they start.
const HOLD_SECONDS = 2;
const HOLD_SHARE = 0.75;
// Studio and network logos and vanity cards close many files (BoJack
// Horseman: four of them, 16 s), as fusion.LOGO_SECONDS allows.
const LOGO_TAIL_SECONDS = 20;

/**
 * The last run of credits-like frames in a read, and where it starts.
 *
 * @param {Array<{ text: boolean, fits: boolean }>} frames - one verdict per
 *   frame: `text` credits text in it, `fits` text or a dark frame between
 *   cards (which keeps a run going but cannot start one)
 * @param {{ start: number, fps: number, minSeconds?: number, share?: number, atEnd?: boolean }} options -
 *   `atEnd` when the read reaches the end of the file
 * @returns {{ start: number, end: number, runsOut: boolean | null } | null}
 *   seconds; `runsOut` whether it reaches the end of the file (null when the
 *   read does not reach it)
 */
function findTextRun(frames, { start, fps, minSeconds = 20, share = 0.55, atEnd = false }) {
    const count = frames.length;
    const maxGap = Math.max(1, Math.round(MAX_GAP_SECONDS * fps));
    // Stretches of frames that fit, joined across short gaps.
    const runs = [];
    let open = null;
    let gap = 0;
    for (let i = 0; i < count; i++) {
        if (frames[i].fits) {
            if (open === null) open = { from: i, to: i, fit: 0, text: 0 };
            open.to = i;
            open.fit++;
            if (frames[i].text) open.text++;
            gap = 0;
        } else if (open !== null && ++gap > maxGap) {
            runs.push(open);
            open = null;
            gap = 0;
        }
    }
    if (open !== null) runs.push(open);
    const hold = Math.max(1, Math.round(HOLD_SECONDS * fps));
    const tail = atEnd ? Math.round(LOGO_TAIL_SECONDS * fps) : 0;
    for (let r = runs.length - 1; r >= 0; r--) {
        const run = runs[r];
        // The run starts on its first text frame whose next seconds hold.
        let first = -1;
        for (let i = run.from; i <= run.to; i++) {
            if (!frames[i].text) continue;
            let held = 0;
            const until = Math.min(run.to, i + hold - 1);
            for (let k = i; k <= until; k++) if (frames[k].fits) held++;
            if (held / (until - i + 1) >= HOLD_SHARE) { first = i; break; }
        }
        if (first < 0) continue;
        const length = (run.to - first + 1) / fps;
        let fitted = 0;
        let texted = 0;
        for (let i = first; i <= run.to; i++) {
            if (frames[i].fits) fitted++;
            if (frames[i].text) texted++;
        }
        const span = run.to - first + 1;
        if (length < minSeconds || fitted / span < share || texted / span < share / 2) continue;
        return {
            start: start + first / fps,
            end: start + (run.to + 1) / fps,
            runsOut: atEnd ? run.to >= count - 1 - tail - maxGap : null,
        };
    }
    return null;
}

// Text laid over the picture stays put to the pixel while the shot moves
// under it; a poster or sign in the shot moves with the camera.
const STILL_PIXELS = 3;
const still = (a, b) => Boolean(a && b) && a.every((value, i) => Math.abs(value - b[i]) <= STILL_PIXELS);

/**
 * Marks each frame of a dense read whose text holds still over three frames
 * in a row, it among them (`still`): a card shows for seconds, a pan that
 * slows for a moment does not hold that long. Frames need `box` (textFrame).
 */
function markStill(frames) {
    const same = (i, j) => Boolean(frames[i] && frames[j]) && still(frames[i].box, frames[j].box);
    return frames.map((frame, i) => ({
        ...frame,
        still: Boolean(frame.box) && ((same(i - 1, i) && same(i, i + 1)) || (same(i, i + 1) && same(i + 1, i + 2)) || (same(i - 2, i - 1) && same(i - 1, i))),
    }));
}

/**
 * The first credits frame, from a dense read around a frame the coarse look
 * found to be credits (`near`): the earliest frame from a moment before it
 * that is credits (text on black, or text over the picture that holds still),
 * then back through the frames that are credits too, no further than one
 * coarse step, as the coarse frame before it was not credits. A poster or
 * sign in the shot before is not reached through the black or the cut
 * between them, and is not taken for the first card.
 *
 * @returns {number | null} seconds
 */
function firstCreditsFrame(frames, { start, fps, near, reach = 2.25, ahead = 2.5 }) {
    const credits = (i) => Boolean(frames[i]) && frames[i].text && (frames[i].dark || frames[i].still !== false);
    const at = Math.round((near - start) * fps);
    let k = -1;
    for (let i = Math.max(0, at - 2); i < frames.length && i <= at + Math.round(ahead * fps); i++) {
        if (credits(i)) { k = i; break; }
    }
    if (k < 0) return null;
    const limit = Math.max(0, Math.floor((near - reach - start) * fps));
    while (k - 1 >= limit && credits(k - 1)) k--;
    return start + k / fps;
}

/**
 * The start snapped onto the picture's own boundary: where a black screen
 * before the first card begins (the story ends there), else a cut within a
 * second before the text.
 *
 * @param {{ cuts: number[], blacks: Array<[number, number]> } | null} scene
 */
function snapToCut(time, scene, tolerance = 1) {
    if (!scene) return time;
    const blacks = scene.blacks.filter(([from, to]) => from <= time + 0.25 && to >= time - tolerance && from >= time - BLACK_BEFORE_CARD);
    if (blacks.length > 0) return Math.min(...blacks.map(([from]) => from));
    const cuts = scene.cuts.filter((edge) => edge <= time + 0.25 && edge >= time - CUT_REACH);
    return cuts.length > 0 ? Math.max(...cuts) : time;
}
// A card that appears on a cut is seen within a frame of it (4 a second);
// text fading in over a shot is not moved back to an earlier cut.
const CUT_REACH = 0.5;
// A black screen this long before the first card is still part of the credits.
const BLACK_BEFORE_CARD = 8;

module.exports = {
    boxesFromMap,
    linesFromBoxes,
    tallestColumn,
    textFrame,
    findTextRun,
    firstCreditsFrame,
    markStill,
    snapToCut,
};
