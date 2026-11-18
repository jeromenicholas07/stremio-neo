// Credits from text in the picture on any background (creditText), where
// they start (creditsPicture), and how that is weighed (fusion).
const { boxesFromMap, linesFromBoxes, textFrame, findTextRun, firstCreditsFrame, markStill, snapToCut } = require('../src/services/skipSegments/creditText');
const { findPictureCredits, WIDTH, HEIGHT } = require('../src/services/skipSegments/creditsPicture');
const { judgeFrames } = require('../src/services/skipSegments/creditJudge');
const { fuse } = require('../src/services/skipSegments/fusion');

const W = 640;
const H = 352;

// A probability map with text lines as boxes of high probability.
function mapWith(boxes) {
    const map = new Float32Array(W * H);
    boxes.forEach(([x0, y0, x1, y1]) => {
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) map[y * W + x] = 0.9;
    });
    return map;
}
const linesOf = (boxes) => linesFromBoxes(boxesFromMap(mapWith(boxes), W, H));
const verdictOf = (boxes) => textFrame(linesOf(boxes), W, H);
// A centred column of `count` lines of 10 px text from `top`.
const column = (count, top, width = 200) => Array.from({ length: count }, (_, i) => [320 - width / 2, top + i * 22, 320 + width / 2, top + i * 22 + 10]);

describe('credits text: single frames', () => {
    it('finds the boxes and joins words on one line', () => {
        const lines = linesOf([[100, 50, 180, 60], [200, 50, 300, 60], [100, 80, 200, 90]]);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ x0: 100, x1: 300, y0: 50, y1: 60 });
    });

    it('takes a list of names, a role and a name, and a side card for credits', () => {
        expect(verdictOf(column(6, 40))).toMatchObject({ text: true, list: true });
        expect(verdictOf(column(2, 150))).toMatchObject({ text: true, list: false });
        // Left-aligned in the corner, over footage.
        expect(verdictOf([[40, 260, 200, 270], [40, 282, 160, 292]]).text).toBe(true);
    });

    it('does not take subtitles, a single line, a big title or unrelated text for credits', () => {
        // Two subtitle lines at the bottom.
        expect(verdictOf([[180, 290, 460, 302], [220, 316, 420, 328]]).text).toBe(false);
        expect(verdictOf([[200, 150, 440, 162]]).text).toBe(false);
        // A big title card: lines taller than credits text.
        expect(verdictOf([[100, 100, 540, 150], [150, 170, 490, 220]]).text).toBe(false);
        // A sign on the left and a poster on the right.
        expect(verdictOf([[20, 100, 120, 112], [500, 125, 620, 137]]).text).toBe(false);
    });
});

// Frames for findTextRun: `text` where credits show, `dark` between cards.
const frames = (count, isText, isDark = () => false) => Array.from({ length: count }, (_, i) => {
    const text = isText(i);
    return { text, fits: text || isDark(i) };
});

describe('credits text: runs', () => {
    it('finds a run over footage with gaps between cards, from its first card', () => {
        // 1 fps, 300 s read ending at the file end; credits from 200 s, a card
        // every 5 s with 2 s of scene between.
        const run = findTextRun(frames(300, (i) => i >= 200 && (i - 200) % 5 < 3), { start: 1000, fps: 1, atEnd: true });
        expect(run).toMatchObject({ start: 1200, runsOut: true });
    });

    it('ignores text in a scene that does not last, and a run too short', () => {
        expect(findTextRun(frames(300, (i) => i >= 100 && i < 110), { start: 0, fps: 1, atEnd: true })).toBeNull();
    });

    it('does not run out when a scene follows the credits (a stinger)', () => {
        const run = findTextRun(frames(300, (i) => i >= 150 && i < 240), { start: 0, fps: 1, atEnd: true });
        expect(run).toMatchObject({ start: 150, runsOut: false });
    });

    it('lets the studio logo close the file without breaking the run', () => {
        const run = findTextRun(frames(300, (i) => i >= 200 && i < 292), { start: 0, fps: 1, atEnd: true });
        expect(run).toMatchObject({ start: 200, runsOut: true });
    });

    it('says nothing about running out when the read stops short of the end', () => {
        expect(findTextRun(frames(120, (i) => i >= 30), { start: 0, fps: 1 }).runsOut).toBeNull();
    });

    it('finds the first frame in a dense read, not reaching a poster before the black', () => {
        // 4 fps from 100 s: a poster in the shot until 102.75 s, black, credits from 103.25 s.
        const dense = frames(28, (i) => i <= 11 || i >= 13);
        expect(firstCreditsFrame(dense, { start: 100, fps: 4, near: 104 })).toBe(103.25);
        // Credits from 102.5 s: reached back from the coarse frame at 104 s.
        expect(firstCreditsFrame(frames(28, (i) => i >= 10), { start: 100, fps: 4, near: 104 })).toBe(102.5);
    });

    it('snaps onto a cut or a fade to black within a second, not further', () => {
        expect(snapToCut(103.25, { cuts: [102.9], blacks: [] })).toBe(102.9);
        expect(snapToCut(103.25, { cuts: [102.6], blacks: [] })).toBe(103.25);
        expect(snapToCut(103.25, { cuts: [101.9], blacks: [] })).toBe(103.25);
        expect(snapToCut(103.25, { cuts: [], blacks: [[101.5, 103.2]] })).toBe(101.5);
        expect(snapToCut(103.25, null)).toBe(103.25);
    });
});

describe('credits text: fusion', () => {
    const audio = (start, end, extra) => ({ start, end, bitErrorRate: 0.1, weight: 1, ...extra });
    const credits = (evidence) => fuse({ duration: 2600, ...evidence }).find((segment) => segment.type === 'credits');
    const run = (start, extra) => ({ run: { start, end: 2600, runsOut: true, solid: false, ...extra } });

    it('starts the credits at the picture, and advances when the shared music agrees', () => {
        expect(credits({ creditsPicture: run(2480.25), creditsRepetition: [audio(2478, 2600)] }))
            .toMatchObject({ start: 2480.25, end: 2600, confidence: 'high', sources: ['picture', 'audio'] });
    });

    it('only offers the popup for credits over footage that nothing else confirms', () => {
        expect(credits({ creditsPicture: run(2480.25) }).confidence).toBe('medium');
    });

    it('advances on a roll on black that the strict test is sure of', () => {
        expect(credits({ creditsPicture: run(2480.25, { solid: true }) }).confidence).toBe('high');
    });

    it('advances when two other episodes had credits this long, not one', () => {
        const creditsLengths = [{ seconds: 120.5, duration: 2590 }, { seconds: 119, duration: 2610 }];
        expect(credits({ creditsPicture: run(2480.25), creditsLengths })).toMatchObject({ confidence: 'high', sources: ['picture', 'season-length'] });
        expect(credits({ creditsPicture: run(2480.25), creditsLengths: creditsLengths.slice(0, 1) }).confidence).toBe('medium');
    });

    it('does not take music that started over the closing scene as agreeing', () => {
        expect(credits({ creditsPicture: run(2480.25), creditsRepetition: [audio(2460, 2600)] }).confidence).toBe('medium');
    });

    it('never advances past a scene after the credits', () => {
        expect(credits({ creditsPicture: run(2480.25, { runsOut: false, end: 2570 }), creditsRepetition: [audio(2475, 2600)] }))
            .toMatchObject({ end: 2570, confidence: 'medium' });
    });

    it('falls back to the season length for the popup when nothing was seen or heard', () => {
        expect(credits({ creditsLength: { seconds: 120, duration: 2601 } })).toMatchObject({ start: 2480, confidence: 'medium', sources: ['season-length'] });
        expect(credits({ creditsLength: { seconds: 120, duration: 2400 } })).toBeUndefined();
    });

    it('lets a named chapter win over the picture', () => {
        const chapters = { named: [{ type: 'credits', start: 2470, end: 2600 }], marks: [] };
        expect(credits({ chapters, creditsPicture: run(2480.25) })).toMatchObject({ start: 2470, sources: ['chapter'] });
    });
});

describe('credits text: reading the picture', () => {
    // A fake launcher: grey footage frames; the detector says credits from
    // 2483.6 s to the end. Scene cuts: one at 2483.4 s.
    const CREDITS_FROM = 2483.6;
    const duration = 2600;
    const reads = [];
    beforeEach(() => {
        reads.length = 0;
        global.fetch = jest.fn(async (url) => {
            const query = new URL(url).searchParams;
            const start = Number(query.get('start'));
            const seconds = Number(query.get('duration'));
            if (url.includes('/scene-cuts')) {
                return { ok: true, json: async () => ({ cuts: [2483.4], blacks: [] }) };
            }
            const fps = Number(query.get('fps'));
            reads.push({ start, seconds, fps });
            const count = Math.floor(Math.min(seconds, duration - start) * fps);
            const data = new Uint8Array(count * WIDTH * HEIGHT).fill(110);
            return { ok: true, arrayBuffer: async () => data.buffer };
        });
    });
    // The detector sees credits in frames from CREDITS_FROM on.
    const detect = async (frames) => {
        const count = Math.floor(frames.data.length / (frames.width * frames.height));
        return { device: 'test', verdicts: Array.from({ length: count }, (_, i) => ({ text: frames.start + i / frames.fps >= CREDITS_FROM, box: [200, 100, 440, 160] })) };
    };

    it('finds the first credits frame to a quarter second and snaps it to the cut', async () => {
        const found = await findPictureCredits({
            mediaUrl: 'http://example.test/ep.mkv', duration, from: duration - 480, to: duration,
            read: (fetcher) => fetcher(undefined), check: () => undefined, judgeWith: (frames) => judgeFrames(frames, detect),
        });
        expect(found.run).toMatchObject({ start: 2483.4, runsOut: true });
        expect(Math.abs(found.run.start - CREDITS_FROM)).toBeLessThanOrEqual(1);
        // Coarse: two reads side by side over the window; fine: one around the start.
        expect(reads.filter((read) => read.fps === 0.5)).toHaveLength(2);
        expect(reads.filter((read) => read.fps === 4)).toHaveLength(1);
    });

    it('says the frames could not be read when the launcher fails', async () => {
        global.fetch = jest.fn(async () => ({ ok: false }));
        const found = await findPictureCredits({
            mediaUrl: 'http://example.test/ep.mkv', duration, from: duration - 480, to: duration,
            read: (fetcher) => fetcher(undefined), check: () => undefined, judgeWith: (frames) => judgeFrames(frames, detect),
        });
        expect(found).toBeNull();
    });
});

describe('credits text: still text over the picture', () => {
    it('takes text that holds still for the first card, not a poster moving with the camera', () => {
        // 4 fps from 10 s: a poster panning by until 11.75 s, then a card that holds still.
        const dense = Array.from({ length: 16 }, (_, i) => (i < 8
            ? { text: true, fits: true, dark: false, box: [10, 180, 30 + i * 8, 230] }
            : { text: true, fits: true, dark: false, box: [160, 80, 480, 270] }));
        expect(firstCreditsFrame(markStill(dense), { start: 10, fps: 4, near: 11.5 })).toBe(12);
    });

    it('takes a roll scrolling on black although it moves', () => {
        const roll = Array.from({ length: 12 }, (_, i) => ({ text: true, fits: true, dark: true, box: [200, 300 - i * 6, 440, 340 - i * 6] }));
        expect(firstCreditsFrame(markStill(roll), { start: 0, fps: 4, near: 1 })).toBe(0);
    });
});
