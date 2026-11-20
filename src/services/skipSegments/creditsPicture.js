// Where the credits start, from the picture: a coarse look over the window
// where they can be (one frame every two seconds), then a dense look around
// the first credits frame it finds (four a second) and the scene cuts there,
// so the start is known to the frame the credits begin on.
//
// Every frame is judged two ways: the dark-frame test (creditFrames, text
// on black, cheap) and the text detector (creditText, any background, on
// the GPU). Either seeing credits counts.

const { fetchFrames, fetchSceneCuts } = require('./chapters');
const { findClosingRoll } = require('./creditFrames');
const { findTextRun, firstCreditsFrame, markStill, snapToCut } = require('./creditText');
const { judgeFrames, SMALL_WIDTH, SMALL_HEIGHT } = require('./creditJudge');
const { judgeInWorker } = require('./textDetector');

// The detector's input: 16:9 at a height that is a multiple of 32.
const WIDTH = 640;
const HEIGHT = 352;
const COARSE_FPS = 0.5;
const FINE_FPS = 4;
// The launcher's longest read; longer windows are read in two at once.
const MAX_READ_SECONDS = 360;
const SINGLE_READ_SECONDS = 240;
// A run with this share of its text on black is a roll on black.
const DARK_RUN_SHARE = 0.6;
// A run over footage must last this long: a page of text in a scene does not.
const MIN_RUN_SECONDS = 20;
// Over footage a card shows for a few seconds, then the scene alone for one
// or two: at least this share of a run is credits or black.
const RUN_SHARE = 0.55;
// A run starting this close to the window's start may start earlier.
const EDGE_SECONDS = 4;
const WIDEN_SECONDS = 240;
// Around the coarse start: the true first frame is at most one coarse step
// before it.
const FINE_BEFORE = 4;
const FINE_SECONDS = 7;
const SCENE_BEFORE = 10;
// A last read this many frames short ends where the picture ends.
const SHORT_READ_FRAMES = 3;
// The picture's verdicts kept from this long before the credits start.
const TAIL_BEFORE = 10;
// Dense looks further on when the first finds no card (FINE_SECONDS each).
const FURTHER_LOOKS = 3;

/**
 * [from, to) at `fps`, in one read or two side by side. Frames of a read that
 * failed count as nothing seen; null when the last part failed, as without
 * the end nothing can be said about the credits running out.
 */
// In the worker with the text detector; without one, the dark test here.
async function judge(frames, judgeWith) {
    return (await judgeWith(frames)) || judgeFrames(frames, async () => null);
}

async function readWindow(read, mediaUrl, from, to, fps, judgeWith, atEnd = false) {
    const seconds = to - from;
    const parts = seconds <= SINGLE_READ_SECONDS ? [[from, to]] : [[from, from + seconds / 2], [from + seconds / 2, to]];
    if (parts.some(([a, b]) => b - a > MAX_READ_SECONDS)) {
        throw new Error('picture window too long');
    }
    const reads = await Promise.all(parts.map(([a, b]) => read((signal) => fetchFrames(mediaUrl, a, b - a, signal, { width: WIDTH, height: HEIGHT, fps }))));
    const last = reads[reads.length - 1];
    if (!last) return null;
    let total = Math.round(seconds * fps);
    // The picture can stop well before the length the file claims (two
    // minutes early, a Stranger Things web release): where the last read
    // runs out of frames is the end.
    const lastFrom = Math.round((parts[parts.length - 1][0] - from) * fps);
    const lastCount = Math.floor(last.data.length / (last.width * last.height));
    if (atEnd && lastFrom + lastCount < total - SHORT_READ_FRAMES) total = lastFrom + lastCount;
    const verdicts = Array.from({ length: total }, () => ({ text: false, fits: false, darkText: false }));
    const small = new Uint8Array(total * SMALL_WIDTH * SMALL_HEIGHT);
    let device = null;
    for (let p = 0; p < parts.length; p++) {
        const frames = reads[p];
        if (!frames) continue;
        const judged = await judge(frames, judgeWith);
        device = device || judged.device;
        const offset = Math.round((parts[p][0] - from) * fps);
        judged.verdicts.forEach((verdict, i) => {
            if (offset + i >= total) return;
            verdicts[offset + i] = verdict;
            small.set(judged.small.subarray(i * SMALL_WIDTH * SMALL_HEIGHT, (i + 1) * SMALL_WIDTH * SMALL_HEIGHT), (offset + i) * SMALL_WIDTH * SMALL_HEIGHT);
        });
    }
    return { from, fps, verdicts, small, device };
}

function concatWindows(before, after) {
    const small = new Uint8Array(before.small.length + after.small.length);
    small.set(before.small);
    small.set(after.small, before.small.length);
    return { from: before.from, fps: before.fps, verdicts: before.verdicts.concat(after.verdicts), small, device: before.device || after.device };
}

// Lone lines of text count as credits (verdict.weak), as text does; with a
// height given, only lone lines at about that height (`band`).
const LONE_BAND = 0.05;
const asWeak = (verdicts, band) => verdicts.map((verdict) => {
    const lone = verdict.weak && (band === undefined || verdict.text || (verdict.weakY !== null && Math.abs(verdict.weakY - band) <= LONE_BAND));
    return { text: lone, fits: lone || verdict.dark };
});

// The height most lone lines of a run sit at: credits keep their place.
function loneBand(window, run) {
    const from = Math.round((run.start - window.from) * window.fps);
    const to = Math.round((run.end - window.from) * window.fps);
    const heights = window.verdicts.slice(Math.max(0, from), to)
        .filter((verdict) => !verdict.text && verdict.weakY !== null)
        .map((verdict) => verdict.weakY)
        .sort((a, b) => a - b);
    return heights.length > 0 ? heights[Math.floor(heights.length / 2)] : undefined;
}

function darkShareIn(window, run) {
    const from = Math.round((run.start - window.from) * window.fps);
    const to = Math.round((run.end - window.from) * window.fps);
    const frames = window.verdicts.slice(Math.max(0, from), to);
    return frames.filter((verdict) => verdict.darkText).length / Math.max(1, frames.filter((verdict) => verdict.text).length);
}

/**
 * The credits run in a window of coarse frames. Text over footage counts
 * only in a run that lasts to the end of the file (a sign or a page in a
 * scene does not); a roll on black may stop before it (a scene after the
 * credits). Lone lines of text count too, in a run that reaches the end
 * (credits one line at a time at the bottom of the picture), when no run
 * of columns of text does.
 */
function pickRun(window, atEnd) {
    const options = { start: window.from, fps: window.fps, minSeconds: MIN_RUN_SECONDS, share: RUN_SHARE, atEnd };
    const strong = findTextRun(window.verdicts, options);
    // Lone lines: a first look, then again with only those at the height
    // most of the run's sit at, so text in the closing scene is left out.
    const loose = atEnd ? findTextRun(asWeak(window.verdicts), options) : null;
    const band = loose ? loneBand(window, loose) : undefined;
    const weak = loose ? findTextRun(asWeak(window.verdicts, band), options) : null;
    // Of the runs that reach the end, the earlier start: a card on black
    // followed by role-and-name lines low over a closing scene (Friends) is
    // one run only when the lone lines count.
    const out = [
        strong && strong.runsOut === true ? { ...strong, weak: false } : null,
        weak && weak.runsOut === true ? { ...weak, weak: true, band } : null,
    ].filter(Boolean).sort((a, b) => a.start - b.start);
    if (out.length > 0) return out[0];
    if (strong && (strong.runsOut === null || darkShareIn(window, strong) >= DARK_RUN_SHARE)) return { ...strong, weak: false };
    return null;
}

/**
 * @param {{
 *   mediaUrl: string, duration: number, from: number, to: number,
 *   read: (fetcher: (signal: AbortSignal) => Promise<any>) => Promise<any>,
 *   check: () => void, widen?: boolean, judgeWith?: Function,
 * }} options - `read` runs one launcher read in the analyzer's read queue;
 *   `judgeWith` judges a read's frames (judgeInWorker; tests pass their own)
 * @returns {Promise<{ run: { start: number, end: number, runsOut: boolean | null, solid: boolean } | null, device: string | null } | null>}
 *   null when the frames could not be read
 */
async function findPictureCredits({ mediaUrl, duration, from, to, read, check, widen = true, judgeWith = judgeInWorker }) {
    const atEnd = to >= duration - 1;
    let window = await readWindow(read, mediaUrl, from, to, COARSE_FPS, judgeWith, atEnd);
    check();
    if (!window) return null;
    let run = pickRun(window, atEnd);
    if (run && widen && run.start <= window.from + EDGE_SECONDS && window.from > 0) {
        const earlier = Math.max(0, window.from - WIDEN_SECONDS);
        const before = await readWindow(read, mediaUrl, earlier, window.from, COARSE_FPS, judgeWith);
        check();
        if (before) {
            window = concatWindows(before, window);
            run = pickRun(window, atEnd);
        }
    }
    if (!run) return { run: null, device: window.device };

    // The frame they start on, and the cut or the black just before it
    // (read from further back: a black screen can hold for seconds before
    // the first card).
    const fineFrom = Math.max(0, run.start - FINE_BEFORE);
    const sceneFrom = Math.max(0, run.start - SCENE_BEFORE);
    const [fine, scene] = await Promise.all([
        read((signal) => fetchFrames(mediaUrl, fineFrom, FINE_SECONDS, signal, { width: WIDTH, height: HEIGHT, fps: FINE_FPS })),
        read((signal) => fetchSceneCuts(mediaUrl, sceneFrom, run.start + 1 - sceneFrom, signal)),
    ]);
    check();
    const denseLook = async (frames, from, near, ahead) => {
        const judged = await judge(frames, judgeWith);
        // A lone line must hold still even on a dark frame (lit sandals in a
        // dim last shot, Shōgun); only a column of text on black may move.
        const dense = run.weak ? asWeak(judged.verdicts, run.band).map((verdict, i) => ({ ...verdict, box: judged.verdicts[i].box, dark: judged.verdicts[i].dark && judged.verdicts[i].text })) : judged.verdicts;
        return firstCreditsFrame(markStill(dense), { start: from, fps: FINE_FPS, near, ahead });
    };
    let found = fine ? await denseLook(fine, fineFrom, run.start) : null;
    // Text in the closing shot (a poster on the wall) can start the coarse
    // run seconds early: no card near its start, so look on to the first.
    for (let look = 0, from = fineFrom + FINE_SECONDS; fine && found === null && look < FURTHER_LOOKS && from < run.end; look++, from += FINE_SECONDS) {
        const lookFrom = from;
        const more = await read((signal) => fetchFrames(mediaUrl, lookFrom, FINE_SECONDS, signal, { width: WIDTH, height: HEIGHT, fps: FINE_FPS }));
        check();
        if (!more) break;
        found = await denseLook(more, lookFrom, lookFrom, FINE_SECONDS);
    }
    const first = found !== null ? found : run.start;
    let cuts = scene;
    if (first > run.start + 1) {
        const from = Math.max(0, first - SCENE_BEFORE);
        cuts = await read((signal) => fetchSceneCuts(mediaUrl, from, first + 1 - from, signal));
        check();
    }
    const start = snapToCut(first, cuts, 1);

    // A roll on black that the strict test is sure of (findClosingRoll) needs
    // nothing else to advance on.
    const darkShare = window.verdicts.filter((verdict) => verdict.darkText).length
        / Math.max(1, window.verdicts.filter((verdict) => verdict.text).length);
    const closing = atEnd && darkShare >= DARK_RUN_SHARE
        ? findClosingRoll(window.small, { start: window.from, fps: COARSE_FPS, width: SMALL_WIDTH, height: SMALL_HEIGHT })
        : null;
    const solid = Boolean(closing) && closing.start >= run.start - 5 && run.runsOut === true;
    // What the picture shows from just before the credits to the end, for
    // where the story ends (storyEnd): dark or not, text or not.
    const tailFrom = Math.max(0, Math.round((Math.min(start, run.start) - TAIL_BEFORE - window.from) * window.fps));
    const tail = {
        from: window.from + tailFrom / window.fps,
        fps: window.fps,
        frames: window.verdicts.slice(tailFrom).map((verdict) => ({ dark: Boolean(verdict.dark), text: Boolean(verdict.text || verdict.darkText) })),
    };
    return { run: { start, end: run.end, runsOut: run.runsOut, solid, coarseStart: run.start }, tail, device: window.device };
}

module.exports = {
    findPictureCredits,
    WIDTH,
    HEIGHT,
};
