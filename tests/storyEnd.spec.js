const { storyEnd, snapStoryEnd, snapWindow } = require('../src/services/skipSegments/storyEnd');
const { speechSegments } = require('../src/services/skipSegments/speech');
const { fuse } = require('../src/services/skipSegments/fusion');

// Coarse frames at 0.5 fps from `from`, built from a pattern per frame:
// 'D' dark, 'T' text, and a motion value.
const FPS = 0.5;
function frames(spec) {
    return spec.map(([kind, motion]) => ({ dark: kind.includes('D'), text: kind.includes('T'), motion }));
}
const run = (start, list, speech, duration, from) => storyEnd({ start, frames: frames(list), framesFrom: from, fps: FPS, speech, duration });

describe('story end', () => {
    it('ends at the credits when they roll on black, the theme sung over them (Two and a Half Men)', () => {
        const list = [['', 10], ['', 5], ['', 5], ['DT', 38], ...Array(11).fill(['DT', 2]), ['T', 234], ['', 124], ['', 0], ['D', 117]];
        const speech = [{ start: 1291.1, end: 1293.8 }, { start: 1303.1, end: 1304.2 }];
        const story = run(1297.5, list, speech, 1329, 1291);
        expect(story).toMatchObject({ end: 1297.5, by: 'start' });
        expect(story.roll).toBeCloseTo(1299, 0);
    });

    it('waits for the comic to stop talking under the names in a dark club (Seinfeld)', () => {
        // Names from 1312; the stage is dark half the time; talking to 1361.6.
        const list = [['T', 9], ['', 3], ['T', 5], ['D', 76], ['D', 1], ['D', 12], ['T', 5], ['D', 16], ['DT', 16], ['T', 19], ['DT', 13],
            ['D', 17], ['T', 9], ['T', 20], ['DT', 19], ['DT', 6], ['D', 7], ['T', 20], ['T', 20], ['T', 25], ['T', 9], ['T', 16], ['T', 17], ['D', 15], ['', 19], ['', 46], ['T', 31], ['D', 46]];
        const speech = [];
        for (let t = 1320; t < 1361; t += 3) speech.push({ start: t, end: t + 2.5 });
        speech.push({ start: 1359.65, end: 1361.6 });
        const story = run(1312.4, list, speech, 1368.4, 1312.4);
        expect(story.roll).toBeNull();
        expect(story.words).toBeCloseTo(1361.6, 1);
        // A black card after the last words, then the studio's logo.
        const scene = { cuts: [1362.0, 1363.5, 1366.6], blacks: [[1362.0, 1363.4]] };
        expect(snapStoryEnd(story, 1312.4, 1 / FPS, scene)).toBe(1362.0);
    });

    it('lets a short card on black pass and plays out the tag scene with no words (Friends)', () => {
        // Card on black, tag scene moving under the credits, then the logos.
        const list = [['T', 19], ['T', 24], ['D', 33], ['T', 30], ['', 23], ['', 23], ['T', 17], ['T', 11], ['', 9], ['T', 20], ['', 19], ['T', 13], ['', 11],
            ['T', 6], ['T', 10], ['T', 14], ['T', 18], ['T', 185], ['', 123], ['D', 117], ['D', 0]];
        const story = run(1291.9, list, [], 1333.4, 1291.4);
        expect(story.by).toBe('live');
        expect(story.logos).toBeCloseTo(1325.4, 1);
        const scene = { cuts: [1324.0, 1324.5], blacks: [] };
        expect(snapStoryEnd(story, 1291.9, 1 / FPS, scene)).toBe(1324.5);
    });

    it('does not count credits over still art as the story (The Mandalorian)', () => {
        const list = [['DT', 5], ['DT', 0], ...Array(30).fill(['T', 5]).map((frame, i) => (i % 4 === 0 ? ['T', 20] : frame)), ['DT', 43], ...Array(20).fill(['DT', 3])];
        expect(run(1954.8, list, [], 2237, 1954.8)).toMatchObject({ end: 1954.8, by: 'start' });
    });

    it('ignores a voice over the closing logos after the roll (The Simpsons)', () => {
        // Song over the still last shot to 1313, roll from 1318, logo gag at 1360.
        const list = [['T', 13], ['T', 6], ['T', 2], ...Array(20).fill(['DT', 4]), ['', 65], ['T', 50], ['T', 100], ['T', 57], ['D', 94]];
        const speech = [{ start: 1311.8, end: 1313.3 }, { start: 1359.5, end: 1360.9 }];
        const story = run(1311.8, list, speech, 1367.8, 1311.8);
        expect(story.scene).toBe(false);
        // The shot holds under the song until the cut to the roll.
        expect(story).toMatchObject({ by: 'roll' });
        expect(story.end).toBeCloseTo(1317.8, 1);
        expect(snapStoryEnd(story, 1311.8, 1 / FPS, { cuts: [], blacks: [[1316.9, 1320]] })).toBe(1316.9);
    });

    it('waits for a scene after the roll, to its last moving frame (Rick and Morty)', () => {
        const list = [['DT', 126], ...Array(15).fill(['DT', 5]), ['', 45], ['', 40], ['', 48], ['', 50], ['', 48], ['', 74], ['', 1], ['', 70], ['', 44], ['', 2], ['', 44], ['', 19], ['', 68], ['', 73],
            ['T', 101], ['', 117], ['', 150], ['D', 174]];
        const speech = [{ start: 1371, end: 1374 }, { start: 1379, end: 1383 }, { start: 1384, end: 1389.9 }];
        const story = run(1333.9, list, speech, 1402.5, 1335);
        expect(story.scene).toBe(true);
        expect(story.end).toBeGreaterThan(1389.9);
        expect(story.logos).toBeCloseTo(1395, 0);
    });

    it('reads scene cuts from the last words when they came shortly before', () => {
        expect(snapWindow({ end: 1364.4, words: 1361.6 }, 2)).toEqual({ from: 1361.1, to: 1366.9 });
        expect(snapWindow({ end: 1319.3, words: 1299.3 }, 2)).toEqual({ from: 1306.8, to: 1321.8 });
    });
});

describe('speech segments', () => {
    it('joins speech across short pauses and drops blips', () => {
        const step = 512 / 16000;
        const probs = new Float32Array(Math.round(4 / step));
        for (let i = 0; i < probs.length; i++) {
            const t = i * step;
            probs[i] = (t >= 0.5 && t < 1.2) || (t >= 1.35 && t < 2) ? 0.9 : t >= 3 && t < 3.1 ? 0.9 : 0.05;
        }
        const segments = speechSegments(probs, 100);
        expect(segments).toHaveLength(1);
        expect(segments[0].start).toBeCloseTo(100.5, 1);
        expect(segments[0].end).toBeCloseTo(102, 1);
    });
});

describe('credits offered where the story ends', () => {
    const duration = 1368.42;
    it('starts the credits segment at the story end, the confidence on the first card', () => {
        const creditsPicture = { run: { start: 1312.42, end: duration, runsOut: true, solid: false }, story: { end: 1362.0 } };
        const credits = fuse({ duration, creditsPicture }).find((segment) => segment.type === 'credits');
        expect(credits).toMatchObject({ start: 1362.0, end: duration, sources: ['picture'] });
    });

    it('drops credits that would start after they end', () => {
        const creditsRepetition = [{ start: 1591.8, end: 1620, weight: 1 }, { start: 1591.8, end: 1620, weight: 1 }];
        const segments = fuse({ duration: 1530.1, creditsRepetition });
        expect(segments.filter((segment) => segment.type === 'credits')).toHaveLength(0);
    });
});
