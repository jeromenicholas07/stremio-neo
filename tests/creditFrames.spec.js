// Recognising an end-credits roll in small grey frames (synthetic frames
// shaped like the real ones measured: 160x90, 2 per second).
const { frameFeatures, isCreditsFrame, findCreditRoll, findClosingRoll } = require('../src/services/skipSegments/creditFrames');

const W = 160;
const H = 90;
const BLACK = 16;

function frame(draw) {
    const pixels = new Uint8Array(W * H).fill(BLACK);
    draw((x, y, value) => { if (x >= 0 && x < W && y >= 0 && y < H) pixels[y * W + x] = value; });
    return pixels;
}
// A line of small text: 3 rows of 2-pixel strokes with gaps, across `width`.
const textLine = (put, top, left, width) => {
    for (let y = top; y < top + 3; y++) for (let x = left; x < left + width; x += 4) { put(x, y, 220); put(x + 1, y, 220); }
};
const credits = () => frame((put) => [20, 32, 44, 56].forEach((top) => textLine(put, top, 50, 60)));
const scene = (seed) => frame((put) => { let s = seed; for (let i = 0; i < W * H; i++) { s = (s * 1103515245 + 12345) >>> 0; put(i % W, Math.floor(i / W), 60 + (s % 120)); } });
const logoCard = () => frame((put) => { for (let y = 35; y < 55; y++) for (let x = 55; x < 105; x++) put(x, y, 230); });
const features = (pixels) => frameFeatures(pixels, W, H);

describe('credit roll: single frames', () => {
    it('takes several lines of text on black for credits', () => {
        expect(isCreditsFrame(features(credits()), H)).toBe(true);
    });

    it('does not take a starfield, a subtitle line, a lit sign or an ordinary shot for credits', () => {
        const stars = frame((put) => { for (let i = 0; i < 120; i++) put((i * 37) % W, (i * 53) % H, 230); });
        const subtitle = frame((put) => { textLine(put, 78, 40, 80); textLine(put, 83, 50, 60); });
        const sign = frame((put) => {
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x + y) % 3 === 0) put(x, y, 70); // a dim room
            for (let y = 30; y < 60; y++) for (let x = 50; x < 110; x++) put(x, y, 235); // the sign
            [36, 46].forEach((top) => { for (let y = top; y < top + 3; y++) for (let x = 55; x < 105; x += 4) put(x, y, 30); });
        });
        [stars, subtitle, sign, scene(7)].forEach((pixels) => expect(isCreditsFrame(features(pixels), H)).toBe(false));
    });
});

describe('credit roll: runs of frames', () => {
    const run = (parts) => {
        const frames = parts.flatMap(([make, seconds]) => Array.from({ length: seconds * 2 }, (_, i) => make(i)));
        const data = new Uint8Array(frames.length * W * H);
        frames.forEach((pixels, i) => data.set(pixels, i * W * H));
        return data;
    };
    const options = { start: 1000, fps: 2, width: W, height: H };

    it('finds where the roll starts, a studio card after it included', () => {
        const data = run([[scene, 10], [credits, 30], [logoCard, 6]]);
        expect(findCreditRoll(data, options)).toMatchObject({ start: 1010 });
    });

    it('does not start on one dark shot that looks like text just before the credits', () => {
        const data = run([[scene, 8], [credits, 1], [scene, 3], [credits, 30]]);
        expect(findCreditRoll(data, options).start).toBe(1012);
    });

    it('ignores a text card that returns to the story', () => {
        expect(findCreditRoll(run([[scene, 10], [credits, 6], [scene, 30]]), options)).toBeNull();
    });

    it('needs the credits to reach the end of what was read', () => {
        expect(findCreditRoll(run([[scene, 10], [credits, 25], [scene, 40]]), options)).toBeNull();
    });
});

describe('credit roll from the picture alone', () => {
    const run = (parts) => {
        const frames = parts.flatMap(([make, seconds]) => Array.from({ length: seconds * 2 }, (_, i) => make(i)));
        const data = new Uint8Array(frames.length * W * H);
        frames.forEach((pixels, i) => data.set(pixels, i * W * H));
        return data;
    };
    const options = { start: 2000, fps: 2, width: W, height: H };
    // One line of text on black: a single-name card, or the story's last words.
    const card = () => frame((put) => textLine(put, 44, 60, 40));

    it('starts on the first list of names, not on the single cards before it', () => {
        expect(findClosingRoll(run([[scene, 10], [card, 6], [credits, 30], [logoCard, 8]]), options)).toMatchObject({ start: 2016 });
    });

    it('wants a long roll running to the end of the file', () => {
        expect(findClosingRoll(run([[scene, 30], [credits, 12], [logoCard, 8]]), options)).toBeNull();
        expect(findClosingRoll(run([[scene, 10], [credits, 30], [scene, 20]]), options)).toBeNull();
    });
});
