// Speech segments from Silero VAD's per-chunk probabilities (the model runs
// in creditTextWorker): where people talk at the end of an episode, so the
// story is not called over while they still do (storyEnd).

// Silero v5 at 16 kHz: 512 new samples per run, with the previous run's
// last 64 in front of them.
const RATE = 16000;
const CHUNK = 512;
const CONTEXT = 64;
// Speech starts at this probability and ends after this long under the
// lower one (the model's own recommended hysteresis).
const START = 0.5;
const END = 0.35;
const MIN_SILENCE_SECONDS = 0.3;
const MIN_SPEECH_SECONDS = 0.25;

/**
 * @param {ArrayLike<number>} probabilities - one per CHUNK samples
 * @param {number} from - seconds of the first chunk in the file
 * @returns {Array<{ start: number, end: number }>} seconds in the file
 */
function speechSegments(probabilities, from = 0) {
    const step = CHUNK / RATE;
    const segments = [];
    let open = null;
    let quiet = 0;
    for (let i = 0; i < probabilities.length; i++) {
        const t = from + i * step;
        const p = probabilities[i];
        if (open === null) {
            if (p >= START) {
                open = { start: t, end: t + step };
                quiet = 0;
            }
        } else if (p < END) {
            quiet++;
            if (quiet * step >= MIN_SILENCE_SECONDS) {
                segments.push(open);
                open = null;
            }
        } else {
            quiet = 0;
            open.end = t + step;
        }
    }
    if (open) segments.push(open);
    return segments
        .filter((segment) => segment.end - segment.start >= MIN_SPEECH_SECONDS)
        .map((segment) => ({ start: Math.round(segment.start * 100) / 100, end: Math.round(segment.end * 100) / 100 }));
}

module.exports = {
    speechSegments,
    RATE,
    CHUNK,
    CONTEXT,
};
