// One verdict per frame of a read, two ways: the dark-frame test
// (creditFrames: text on black, cheap) and the text detector (creditText,
// any background). Runs in creditTextWorker, off the player's thread; the
// same code runs on the calling thread, dark test only, without a worker.

const { frameFeatures, isCreditsFrame } = require('./creditFrames');

// The dark-frame test was tuned on 160x90; a 4x4 average is that, near enough.
const SMALL_WIDTH = 160;
const SMALL_HEIGHT = 88;
const DARK_SHARE = 0.85;

function downscale(frame, width, height) {
    const fx = width / SMALL_WIDTH;
    const fy = height / SMALL_HEIGHT;
    const small = new Uint8Array(SMALL_WIDTH * SMALL_HEIGHT);
    for (let y = 0; y < SMALL_HEIGHT; y++) {
        const y0 = Math.floor(y * fy);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
        for (let x = 0; x < SMALL_WIDTH; x++) {
            const x0 = Math.floor(x * fx);
            const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
            let sum = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += frame[yy * width + xx];
            small[y * SMALL_WIDTH + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
        }
    }
    return small;
}

/**
 * @param {{ data: Uint8Array, width: number, height: number }} frames
 * @param {(frames: object) => Promise<{ verdicts: Array<{ text: boolean }>, device: string } | null>} detect -
 *   the text detector, or one that answers null
 * @returns {Promise<{ verdicts: Array<{ text: boolean, weak: boolean, weakY: number | null, box: number[] | null, dark: boolean, fits: boolean, darkText: boolean }>, small: Uint8Array, device: string | null }>}
 *   `small` the frames at 160x88, for the strict dark-frame test
 */
async function judgeFrames(frames, detect) {
    const size = frames.width * frames.height;
    const count = Math.floor(frames.data.length / size);
    const small = new Uint8Array(count * SMALL_WIDTH * SMALL_HEIGHT);
    const dark = [];
    for (let i = 0; i < count; i++) {
        const frame = downscale(frames.data.subarray(i * size, (i + 1) * size), frames.width, frames.height);
        small.set(frame, i * frame.length);
        const features = frameFeatures(frame, SMALL_WIDTH, SMALL_HEIGHT);
        dark.push({ text: isCreditsFrame(features, SMALL_HEIGHT), dark: features.dark >= DARK_SHARE });
    }
    const detected = await detect(frames);
    const verdicts = dark.map((frame, i) => {
        const seen = detected && detected.verdicts[i] ? detected.verdicts[i] : null;
        const text = frame.text || Boolean(seen && seen.text);
        const weak = text || Boolean(seen && seen.weak);
        const weakY = seen && typeof seen.weakY === 'number' ? seen.weakY : null;
        const box = seen && Array.isArray(seen.box) ? seen.box : null;
        return { text, weak, weakY, box, dark: frame.dark, fits: text || frame.dark, darkText: frame.text };
    });
    return { verdicts, small, device: detected ? detected.device : null };
}

module.exports = { judgeFrames, downscale, SMALL_WIDTH, SMALL_HEIGHT };
