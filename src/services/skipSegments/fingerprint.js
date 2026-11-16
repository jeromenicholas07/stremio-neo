// Audio fingerprint for finding the stretch of audio two episodes share (the
// intro). Plain JS with no DOM or Node dependencies so it runs in a Web Worker
// and under Node for offline testing.
//
// The scheme is the Haitsma-Kalker "robust hash": per frame, the energy in 33
// log-spaced bands; each of the 32 bits is the sign of the energy difference
// between neighbouring bands, differenced again against the previous frame.
// Two encodes of the same audio disagree on roughly 10-30% of the bits,
// unrelated audio on about 50%, so a low bit-error rate held over a couple of
// seconds is strong evidence of the same sound.

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 4096; // 256 ms analysis window
const HOP_SIZE = 1000; // 62.5 ms -> exactly 16 frames per second
const FRAMES_PER_SECOND = SAMPLE_RATE / HOP_SIZE;
const BANDS = 33;
const MIN_HZ = 300;
const MAX_HZ = 3000;
// Frames quieter than this carry no usable spectrum: digital silence hashes to
// all-zero bits and would "match" every other silence perfectly.
const SILENCE_RMS = 0.0008;

let cached = null;

function setup() {
    if (cached) return cached;
    const n = FRAME_SIZE;
    const window = new Float32Array(n);
    for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const levels = Math.log2(n);
    const reverse = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
        let r = 0;
        for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
        reverse[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / n);
        sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    // Band edges as FFT bin indices, log-spaced between MIN_HZ and MAX_HZ.
    const edges = new Uint32Array(BANDS + 1);
    for (let b = 0; b <= BANDS; b++) {
        const hz = MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, b / BANDS);
        edges[b] = Math.round((hz * n) / SAMPLE_RATE);
    }
    cached = { window, reverse, cos, sin, edges, re: new Float64Array(n), im: new Float64Array(n) };
    return cached;
}

function fft(re, im, tables) {
    const n = re.length;
    const { cos, sin } = tables;
    for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
            for (let k = 0, t = 0; k < half; k++, t += step) {
                const a = start + k;
                const b = a + half;
                const xr = re[b] * cos[t] + im[b] * sin[t];
                const xi = im[b] * cos[t] - re[b] * sin[t];
                re[b] = re[a] - xr;
                im[b] = im[a] - xi;
                re[a] += xr;
                im[a] += xi;
            }
        }
    }
}

/**
 * Fingerprint 16 kHz mono PCM.
 *
 * @param {Float32Array} pcm
 * @param {{ maxFrames?: number }} [options] - cap the number of frames, so a
 *   chunk requested slightly longer than its slot yields exactly the slot.
 * @returns {{ hashes: Int32Array, valid: Uint8Array, rms: Float32Array }}
 *   One entry per frame, FRAMES_PER_SECOND frames per second. `valid` is 0 for
 *   silent frames and for the first frame (which has no predecessor).
 */
function fingerprintPcm(pcm, options) {
    const tables = setup();
    const { window, reverse, edges, re, im } = tables;
    const available = pcm.length >= FRAME_SIZE ? Math.floor((pcm.length - FRAME_SIZE) / HOP_SIZE) + 1 : 0;
    const count = options && options.maxFrames ? Math.min(available, options.maxFrames) : available;
    const hashes = new Int32Array(count);
    const valid = new Uint8Array(count);
    const rms = new Float32Array(count);
    let previous = new Float64Array(BANDS);
    let current = new Float64Array(BANDS);
    let previousUsable = false;

    for (let f = 0; f < count; f++) {
        const offset = f * HOP_SIZE;
        let power = 0;
        for (let i = 0; i < FRAME_SIZE; i++) {
            const sample = pcm[offset + i];
            power += sample * sample;
            re[reverse[i]] = sample * window[i];
            im[reverse[i]] = 0;
        }
        const level = Math.sqrt(power / FRAME_SIZE);
        rms[f] = level;
        fft(re, im, tables);
        for (let b = 0; b < BANDS; b++) {
            let energy = 0;
            for (let k = edges[b]; k < edges[b + 1]; k++) energy += re[k] * re[k] + im[k] * im[k];
            current[b] = energy;
        }
        const usable = level >= SILENCE_RMS;
        if (usable && previousUsable) {
            let hash = 0;
            for (let b = 0; b < BANDS - 1; b++) {
                const delta = (current[b] - current[b + 1]) - (previous[b] - previous[b + 1]);
                if (delta > 0) hash |= 1 << b;
            }
            hashes[f] = hash;
            valid[f] = 1;
        }
        previousUsable = usable;
        const swap = previous;
        previous = current;
        current = swap;
    }
    return { hashes, valid, rms };
}

module.exports = {
    SAMPLE_RATE,
    FRAME_SIZE,
    HOP_SIZE,
    FRAMES_PER_SECOND,
    fingerprintPcm,
};
