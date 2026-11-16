// Finds the stretch of audio two fingerprints share. Both episodes are laid
// against each other at every possible time offset; along each offset the
// bit-error rate is averaged over a short window, and the longest run that
// stays low is the shared segment (the intro, when the two are episodes of the
// same season).

const { FRAMES_PER_SECOND } = require('./fingerprint');

const DEFAULTS = {
    windowSeconds: 2, // averaging window for the coarse pass
    maxBitErrorRate: 0.35, // coarse pass: same audio sits well under this, unrelated audio near 0.5
    edgeWindowSeconds: 0.5, // window used to place the two edges
    edgeBitErrorRate: 0.38,
    maxGapSeconds: 3, // a dip this short does not end a run
    minSeconds: 8,
    maxSeconds: 200, // longer than any intro: the same episode twice, or a shared recap reel
    maxResults: 3,
};

const POPCOUNT = new Uint8Array(65536);
for (let i = 1; i < 65536; i++) POPCOUNT[i] = POPCOUNT[i >> 1] + (i & 1);

// A frame that is silent in either file says nothing either way, so it counts
// as a coin flip rather than as agreement.
const NEUTRAL_ERRORS = 16;

function bitErrors(a, b, i, j) {
    if (!a.valid[i] || !b.valid[j]) return NEUTRAL_ERRORS;
    const x = a.hashes[i] ^ b.hashes[j];
    return POPCOUNT[x & 0xffff] + POPCOUNT[x >>> 16];
}

// Earliest (direction 1) or latest (direction -1) frame near `from` where the
// short-window error rate is under the edge threshold.
function refineEdge(errors, length, from, direction, edgeFrames, limit, reach) {
    let best = from;
    const lo = Math.max(0, from - reach);
    const hi = Math.min(length - edgeFrames, from + reach);
    if (direction === 1) {
        for (let k = lo; k <= hi; k++) {
            let sum = 0;
            for (let w = 0; w < edgeFrames; w++) sum += errors[k + w];
            if (sum <= limit) { best = k; break; }
        }
    } else {
        for (let k = hi; k >= lo; k--) {
            let sum = 0;
            for (let w = 0; w < edgeFrames; w++) sum += errors[k + w];
            if (sum <= limit) { best = k + edgeFrames; break; }
        }
    }
    return best;
}

/**
 * @param {{hashes: Int32Array, valid: Uint8Array}} a
 * @param {{hashes: Int32Array, valid: Uint8Array}} b
 * @param {Partial<typeof DEFAULTS>} [options]
 * @returns {Array<{startA: number, endA: number, startB: number, endB: number, bitErrorRate: number, seconds: number}>}
 *   Shared segments in seconds, best first. Empty when nothing is shared.
 */
function findSharedSegments(a, b, options) {
    const o = { ...DEFAULTS, ...options };
    const na = a.hashes.length;
    const nb = b.hashes.length;
    const windowFrames = Math.max(2, Math.round(o.windowSeconds * FRAMES_PER_SECOND));
    const edgeFrames = Math.max(2, Math.round(o.edgeWindowSeconds * FRAMES_PER_SECOND));
    const gapFrames = Math.round(o.maxGapSeconds * FRAMES_PER_SECOND);
    const minFrames = Math.round(o.minSeconds * FRAMES_PER_SECOND);
    const maxFrames = Math.round(o.maxSeconds * FRAMES_PER_SECOND);
    const coarseLimit = o.maxBitErrorRate * 32 * windowFrames;
    const edgeLimit = o.edgeBitErrorRate * 32 * edgeFrames;
    const errors = new Uint8Array(Math.min(na, nb));
    const found = [];

    for (let offset = -(na - 1); offset < nb; offset++) {
        const i0 = Math.max(0, -offset);
        const length = Math.min(na, nb - offset) - i0;
        if (length < minFrames) continue;
        for (let k = 0; k < length; k++) errors[k] = bitErrors(a, b, i0 + k, i0 + k + offset);

        let sum = 0;
        for (let k = 0; k < windowFrames; k++) sum += errors[k];
        let runStart = -1;
        let lastGood = -1;
        const close = () => {
            if (runStart < 0) return;
            // Window positions runStart..lastGood are good, so the audio agrees
            // from runStart to lastGood + windowFrames.
            const start = refineEdge(errors, length, runStart, 1, edgeFrames, edgeLimit, windowFrames);
            const end = refineEdge(errors, length, lastGood + windowFrames - edgeFrames, -1, edgeFrames, edgeLimit, windowFrames);
            const frames = end - start;
            if (frames >= minFrames && frames <= maxFrames) {
                let total = 0;
                for (let k = start; k < end; k++) total += errors[k];
                found.push({
                    startA: (i0 + start) / FRAMES_PER_SECOND,
                    endA: (i0 + end) / FRAMES_PER_SECOND,
                    startB: (i0 + start + offset) / FRAMES_PER_SECOND,
                    endB: (i0 + end + offset) / FRAMES_PER_SECOND,
                    bitErrorRate: total / (frames * 32),
                    seconds: frames / FRAMES_PER_SECOND,
                });
            }
            runStart = -1;
        };
        for (let k = 0; k + windowFrames <= length; k++) {
            if (k > 0) sum += errors[k + windowFrames - 1] - errors[k - 1];
            if (sum <= coarseLimit) {
                if (runStart < 0) runStart = k;
                lastGood = k;
            } else if (runStart >= 0 && k - lastGood > gapFrames) {
                close();
            }
        }
        close();
    }

    // Neighbouring offsets report the same segment again; keep the strongest
    // of any group that overlaps in the first file.
    const score = (s) => s.seconds * (0.5 - s.bitErrorRate);
    found.sort((x, y) => score(y) - score(x));
    const kept = [];
    for (const segment of found) {
        const overlaps = kept.some((k) => Math.min(k.endA, segment.endA) - Math.max(k.startA, segment.startA) > 0);
        if (!overlaps) kept.push(segment);
        if (kept.length >= o.maxResults) break;
    }
    return kept;
}

module.exports = {
    DEFAULTS,
    findSharedSegments,
};
