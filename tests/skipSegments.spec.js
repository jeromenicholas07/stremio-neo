const { fingerprintPcm, SAMPLE_RATE } = require('../src/services/skipSegments/fingerprint');
const { findSharedSegments } = require('../src/services/skipSegments/matcher');
const { fuse, landingAfter } = require('../src/services/skipSegments/fusion');
const { parseVideoId, parseTheIntroDb, parseIntroDb } = require('../src/services/skipSegments/databases');
const { parseMediaInfo, typeOfTitle } = require('../src/services/skipSegments/chapters');
const { orderNeighbours, episodesAhead, pickReferenceStreams, fileKeyOf } = require('../src/services/skipSegments/neighbours');

// Deterministic noise, so every run sees the same audio.
function noise(seconds, seed) {
    let state = seed;
    const out = new Float32Array(seconds * SAMPLE_RATE);
    for (let i = 0; i < out.length; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        out[i] = (state / 0xffffffff - 0.5) * 0.4;
    }
    return out;
}

// An "episode": its own audio with the shared theme dropped in at `at`.
function episode(seconds, seed, theme, at) {
    const pcm = noise(seconds, seed);
    if (theme) pcm.set(theme, at * SAMPLE_RATE);
    return fingerprintPcm(pcm);
}

describe('skip intro: audio matching', () => {
    const theme = noise(30, 7);

    it('finds the audio two episodes share, at its position in each', () => {
        const [match] = findSharedSegments(episode(120, 1, theme, 40), episode(120, 2, theme, 75));
        expect(match).toBeDefined();
        expect(Math.abs(match.startA - 40)).toBeLessThanOrEqual(1);
        expect(Math.abs(match.endA - 70)).toBeLessThanOrEqual(1);
        expect(Math.abs(match.startB - 75)).toBeLessThanOrEqual(1);
    });

    it('reports nothing for episodes with no audio in common', () => {
        expect(findSharedSegments(episode(120, 1), episode(120, 2))).toEqual([]);
    });

    it('does not treat silence as shared audio', () => {
        const silentLead = (seed) => {
            const pcm = noise(90, seed);
            pcm.fill(0, 0, 30 * SAMPLE_RATE);
            return fingerprintPcm(pcm);
        };
        expect(findSharedSegments(silentLead(1), silentLead(2))).toEqual([]);
    });

    it('ignores a match longer than any intro, such as the same file twice', () => {
        expect(findSharedSegments(episode(300, 1), episode(300, 1))).toEqual([]);
    });
});

describe('skip intro: fusing evidence', () => {
    const audio = (start, end, extra) => ({ start, end, bitErrorRate: 0.15, weight: 1, ...extra });
    const db = (start, end, extra) => ({ type: 'intro', start, end, votes: 5, source: 'theintrodb', sameCut: true, ...extra });
    const intro = (evidence) => fuse(evidence).find((segment) => segment.type === 'intro');

    it('is only a button when a single audio match stands alone', () => {
        expect(intro({ repetition: [audio(100, 130)] })).toMatchObject({ start: 100, end: 130, confidence: 'medium' });
    });

    it('is confirmed when two neighbours agree', () => {
        expect(intro({ repetition: [audio(100, 130), audio(101, 131)] }).confidence).toBe('high');
    });

    it('is confirmed when audio and a database agree', () => {
        expect(intro({ repetition: [audio(100, 130)], database: { segments: [db(99, 131)] } }).confidence).toBe('high');
    });

    // South Park S01E02: both databases put the intro at the start of the file,
    // while this cut has a two-minute cold open first.
    it('lets what was measured on the file overrule the databases', () => {
        const result = intro({
            repetition: [audio(111, 144)],
            database: { segments: [db(0, 35), db(0, 30, { source: 'introdb', sameCut: null })] },
        });
        expect(result).toMatchObject({ start: 111, end: 144, confidence: 'medium' });
    });

    it('never auto-skips on databases alone unless one matches this cut', () => {
        const agreeing = [db(50, 80, { sameCut: null }), db(51, 81, { source: 'introdb', sameCut: null })];
        expect(intro({ database: { segments: agreeing } }).confidence).toBe('medium');
        expect(intro({ database: { segments: [db(50, 80), agreeing[1]] } }).confidence).toBe('high');
    });

    it('holds a database-only answer back once local analysis found nothing', () => {
        const segments = [db(50, 80), db(51, 81, { source: 'introdb', sameCut: null })];
        expect(intro({ database: { segments }, localDone: true }).confidence).toBe('medium');
    });

    it('treats a single thin database vote as low confidence', () => {
        expect(intro({ database: { segments: [db(50, 80, { votes: 1 })] } }).confidence).toBe('low');
    });

    it('trusts a named chapter outright', () => {
        const chapters = { named: [{ type: 'intro', start: 90, end: 180 }], marks: [90, 180] };
        expect(intro({ chapters, repetition: [audio(20, 50)] })).toMatchObject({ start: 90, end: 180, confidence: 'high' });
    });

    it('snaps to an unnamed chapter boundary and counts it as confirmation', () => {
        const chapters = { named: [], marks: [110.86, 144.23] };
        expect(intro({ chapters, repetition: [audio(111.5, 143.4)] })).toMatchObject({ start: 110.86, end: 144.23, confidence: 'high' });
    });

    // Friends S5E22: two neighbours share only the first 28 s of the theme, a
    // third shares all of it, and the file has a chapter mark where it ends.
    it('takes the longer end when a chapter mark confirms it', () => {
        const chapters = { named: [], marks: [133.3, 838] };
        const result = intro({ chapters, repetition: [audio(87.4, 115.3), audio(87.5, 133.5, { bitErrorRate: 0.21 }), audio(87.4, 115.3)] });
        expect(result).toMatchObject({ start: 87.4, end: 133.3, confidence: 'high' });
    });

    it('stops at the end most matches share, unconfirmed, when the ends disagree', () => {
        const result = intro({ repetition: [audio(87.4, 115.3), audio(87.5, 133.5, { bitErrorRate: 0.21 }), audio(87.4, 115.3)] });
        expect(result).toMatchObject({ end: 115.3, confidence: 'medium' });
    });

    it('never auto-skips a segment longer than a real intro', () => {
        const result = intro({ repetition: [audio(60, 230), audio(61, 230)] });
        expect(result).toMatchObject({ start: 60, end: 230, confidence: 'medium' });
    });

    // Stranger Things S3E8: each neighbour shares a different length of the
    // intro; checked against the video, the longest was the real end.
    it('takes the later end when the matches disagree, without skipping on it', () => {
        const result = intro({ repetition: [audio(198, 252, { bitErrorRate: 0.03 }), audio(198, 259), audio(198, 224)] });
        expect(result).toMatchObject({ start: 198, end: 259, confidence: 'medium' });
    });

    // Game of Thrones S1E9: the audio only matched the first minute; the
    // database entry for this cut gives the full length.
    it('extends a partial audio match to a same-cut database end', () => {
        const result = intro({ repetition: [audio(7, 67)], database: { segments: [db(5, 107, { votes: 8 })] } });
        expect(result).toMatchObject({ start: 7, end: 107, confidence: 'high' });
    });

    // Sacred Games S2E8: neighbours share the 17 s Netflix logo; the database
    // places the real intro minutes later.
    it('prefers a same-cut database intro over a logo-length match elsewhere', () => {
        const result = intro({ repetition: [audio(3, 20, { bitErrorRate: 0.03 })], database: { segments: [db(268, 303, { votes: 4 })] } });
        expect(result).toMatchObject({ start: 268, end: 303, confidence: 'medium' });
    });

    it('offers nothing for a weak audio match on its own', () => {
        expect(intro({ repetition: [audio(117, 132, { bitErrorRate: 0.35 })] })).toBeUndefined();
    });

    it('drops segments that cannot be an intro', () => {
        expect(intro({ duration: 1300, repetition: [audio(900, 940)] })).toBeUndefined();
        expect(intro({ repetition: [audio(10, 12)] })).toBeUndefined();
    });

    describe('credits from audio shared near the end', () => {
        const credits = (repetition, extra) => fuse({ duration: 1300, creditsRepetition: repetition, ...extra }).find((segment) => segment.type === 'credits');

        it('chains the credits music and a studio card after it, and may advance when a chapter boundary confirms it', () => {
            const chapters = { named: [], marks: [1240.4] };
            const result = credits([audio(1240, 1290), audio(1241, 1290), audio(1294, 1300)], { chapters });
            expect(result).toMatchObject({ start: 1240.4, end: 1300, confidence: 'high' });
        });

        // Peep Show S3E5: two neighbours share the closing music, which starts
        // over the last seconds of the final scene; the roll starts at 1471.5.
        it('does not advance on shared music alone, which can play over the final scene', () => {
            expect(credits([audio(1471.3, 1495.3, { bitErrorRate: 0.08 }), audio(1469.7, 1495.3)], { duration: 1507 }).confidence).toBe('medium');
        });

        it('advances when the picture shows the roll starting within the music, from its first frame', () => {
            const creditsPicture = { roll: { start: 1471.5, end: 1507 } };
            expect(credits([audio(1471.3, 1495.3), audio(1469.7, 1495.3)], { duration: 1507, creditsPicture }))
                .toMatchObject({ start: 1471.5, confidence: 'high', sources: expect.arrayContaining(['picture']) });
        });

        it('ignores a roll far from the shared music, and stays a popup without it', () => {
            const early = { roll: { start: 1400, end: 1507 } };
            expect(credits([audio(1469.7, 1495.3)], { duration: 1507, creditsPicture: early }).confidence).toBe('medium');
            expect(credits([audio(1469.7, 1495.3)], { duration: 1507, creditsPicture: { roll: null } }).confidence).toBe('medium');
        });

        // A new song every episode: no shared music, only the picture.
        it('offers credits from the picture alone only when it is sure, and then at high', () => {
            expect(credits([], { creditsPicture: { closing: { start: 1240, end: 1300 } } })).toMatchObject({ start: 1240, end: 1300, confidence: 'high', sources: ['picture'] });
            expect(credits([], { creditsPicture: { closing: null } })).toBeUndefined();
            expect(credits([], { creditsPicture: { closing: { start: 500, end: 1300 } } })).toBeUndefined();
        });

        it('advances on the season\'s confirmed credits theme', () => {
            expect(credits([audio(1240, 1300, { weight: 2 })]).confidence).toBe('high');
        });

        it('only offers the popup when something unshared follows (a preview, or a scene after the credits)', () => {
            expect(credits([audio(1150, 1200), audio(1151, 1200)])).toMatchObject({ start: 1150, confidence: 'medium' });
        });

        it('never takes a score cue in the final act for the credits', () => {
            expect(credits([audio(900, 930), audio(901, 930)])).toBeUndefined();
            expect(credits([audio(1100, 1130), audio(1100, 1130), audio(1250, 1300)])).toMatchObject({ start: 1250, confidence: 'medium' });
        });

        it('does not advance on a database entry made for a different cut', () => {
            const database = { segments: [db(1238, 1300, { type: 'credits', sameCut: false, votes: 1 })] };
            expect(credits([audio(1240, 1300)], { database }).confidence).toBe('medium');
        });

        it('advances when a database agrees on the start', () => {
            expect(credits([audio(1240, 1300)]).confidence).toBe('medium');
            const database = { segments: [db(1238, 1300, { type: 'credits' })] };
            expect(credits([audio(1240, 1300)], { database }).confidence).toBe('high');
        });
    });

    it('reports credits from the databases', () => {
        const credits = fuse({ duration: 1300, database: { segments: [db(1250, 1300, { type: 'credits' })] } });
        expect(credits).toEqual([expect.objectContaining({ type: 'credits', start: 1250, confidence: 'medium' })]);
    });
});

// Cuts and black stretches ffmpeg found around real intro ends, with the
// episode's first frame checked by eye.
describe('skip intro: landing on the first frame', () => {
    it('lands after a black gap that starts where the music ends', () => {
        expect(landingAfter(153.19, { cuts: [153.17, 155.18, 166.4], blacks: [[153.17, 155.18]] })).toBe(155.18); // House
        expect(landingAfter(66.94, { cuts: [67.65, 76.2], blacks: [[67.15, 67.65]] })).toBe(67.65); // Modern Family, after a credit
        expect(landingAfter(404.81, { cuts: [434.77], blacks: [[404.28, 407.32]] })).toBe(407.32); // SVU
    });

    it('lands after black the theme plays on over, or that ended just before', () => {
        expect(landingAfter(319.19, { cuts: [325.54], blacks: [[318.19, 321.49]] })).toBe(321.49); // Star Trek: TNG
        expect(landingAfter(227.19, { cuts: [226.52, 231.57], blacks: [[226.19, 226.52]] })).toBe(226.52); // Yellowstone, ended late
    });

    // Brightness per frame (10 fps samples of the real files; 10-bit black
    // is 64, 8-bit 16).
    const ramp = (from, values) => values.map((value, i) => [Math.round((from + i / 10) * 10) / 10, value]);
    it('lands where a fade in from black starts, not where ffmpeg stops calling it black', () => {
        const tng = ramp(319.5, [64, 64, 64, 64, 64, 64, 64, 65, 67, 68, 69, 70, 69, 70, 70, 70, 70, 70, 70, 71, 73]);
        expect(landingAfter(319.19, { cuts: [], blacks: [[318.19, 321.49]], luma: tng })).toBe(320.3); // Star Trek: TNG
        const xFiles = ramp(236.9, [64, 64, 64, 64, 64, 64, 64, 65, 71, 77, 83, 93]);
        expect(landingAfter(236.9, { cuts: [], blacks: [[235.4, 237.99]], luma: xFiles })).toBe(237.7);
        // Noise early in the black does not end it.
        const cheers = ramp(141.4, [17, 17, 17, 17, 17, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 25]);
        expect(landingAfter(141.38, { cuts: [], blacks: [[140.38, 143.39]], luma: cheers })).toBe(143.4);
    });

    // Measured brightness after the music: a card that holds still, then the episode.
    it('lands past a still title or creator card after the music', () => {
        const bluey = { cuts: [27.095, 28.721], blacks: [], luma: [[26.01, 738], [26.26, 738], [26.51, 738], [26.76, 738], [27.01, 738], [27.14, 579], [27.39, 575]] };
        expect(landingAfter(26, bluey)).toBe(27.095);
        const bigBang = {
            cuts: [156.615],
            blacks: [[155.364, 156.615]],
            luma: [[153.82, 20], [154.2, 20], [154.57, 20], [154.95, 20], [155.32, 20], [155.45, 16], [155.82, 16], [156.2, 16], [156.57, 16], [156.62, 48], [156.7, 49]],
        };
        expect(landingAfter(153.8125, bigBang)).toBe(156.62);
    });

    it('never skips the start of an episode that moves', () => {
        const moving = { cuts: [27.1], blacks: [], luma: [[26.01, 300], [26.26, 340], [26.51, 390], [26.76, 420], [27.01, 455]] };
        expect(landingAfter(26, moving)).toBe(26);
    });

    it('otherwise takes the closest hard cut, earlier or later', () => {
        expect(landingAfter(30.75, { cuts: [27.63, 29.8, 29.84, 30.72, 33.72], blacks: [] })).toBe(30.72); // Family Guy
        expect(landingAfter(18.69, { cuts: [17.55, 18.35, 19.31, 23.19], blacks: [] })).toBe(18.35); // Peep Show, ended late
    });

    it('ignores flicker and anything too far to be the same moment', () => {
        const itCrowd = { cuts: [26.76, 27.12], blacks: [[25.88, 25.96], [26.6, 26.76], [27.12, 27.48]] };
        expect(landingAfter(24.56, itCrowd)).toBe(24.56);
        expect(landingAfter(47.19, { cuts: [54.45], blacks: [] })).toBe(47.19); // Avatar
    });
});

describe('skip intro: sources', () => {
    it('reads series video ids and nothing else', () => {
        expect(parseVideoId('tt0903747:1:2')).toEqual({ imdbId: 'tt0903747', season: 1, episode: 2 });
        expect(parseVideoId('tt0903747')).toBeNull();
        expect(parseVideoId('kitsu:1:2')).toBeNull();
    });

    it('normalises TheIntroDB answers and flags whether the cut matches', () => {
        const body = {
            group_duration_ms: 2901000,
            intro: [{ start_ms: 314551, end_ms: 331127, submission_count: 18 }],
            credits: [{ start_ms: 2848149, end_ms: null, submission_count: 10 }],
        };
        expect(parseTheIntroDb(body, 2900)).toEqual([
            { type: 'intro', start: 314.551, end: 331.127, votes: 18, source: 'theintrodb', sameCut: true },
            { type: 'credits', start: 2848.149, end: 2900, votes: 10, source: 'theintrodb', sameCut: true },
        ]);
        expect(parseTheIntroDb(body, 2500)[0].sameCut).toBe(false);
        expect(parseTheIntroDb(null, 2900)).toEqual([]);
    });

    it('normalises IntroDB answers', () => {
        const body = { intro: { start_ms: 314500, end_ms: 331000, submission_count: 5 }, recap: null, outro: null };
        expect(parseIntroDb(body)).toEqual([{ type: 'intro', start: 314.5, end: 331, votes: 5, source: 'introdb', sameCut: null }]);
    });

    it('names chapters by their title and keeps every boundary as a mark', () => {
        expect(typeOfTitle('Opening')).toBe('intro');
        expect(typeOfTitle('ED')).toBe('credits');
        expect(typeOfTitle('Chapter 02')).toBeNull();
        const info = { duration: 1438, chapters: [{ start: 0, end: 110.8, title: null }, { start: 110.8, end: 144.2, title: 'OP' }] };
        expect(parseMediaInfo(info)).toEqual({ duration: 1438, named: [{ type: 'intro', start: 110.8, end: 144.2 }], marks: [110.8] });
    });

    const videos = [1, 2, 3, 4, 5].map((episode) => ({ id: `tt1:1:${episode}`, season: 1, episode }))
        .concat([{ id: 'tt1:2:1', season: 2, episode: 1 }]);

    it('orders neighbours nearest first within the season, next before previous', () => {
        expect(orderNeighbours(videos, 'tt1:1:3').map(({ episode }) => episode)).toEqual([4, 2, 5, 1]);
        expect(episodesAhead(videos, 'tt1:1:3').map(({ episode }) => episode)).toEqual([4, 5]);
    });

    it('reads the smallest direct stream, or the likely next pick when given the current one', () => {
        const stream = (name, size, group, extra) => ({ name, url: `https://host/${name}.mkv`, behaviorHints: { videoSize: size, bingeGroup: group }, ...extra });
        const streams = [
            stream('big', 4e9, 'a'),
            stream('small', 4e8, 'b'),
            stream('sample', 1e6, 'b'),
            stream('[RD download] uncached', 3e8, 'b'),
            { name: 'torrent', infoHash: 'abc' },
        ];
        expect(pickReferenceStreams(streams).map(({ name }) => name)).toEqual(['small', 'big']);
        expect(pickReferenceStreams(streams, { like: stream('current', 3.8e9, 'a'), limit: 1 })[0].name).toBe('big');
    });

    it('identifies a file the same way from its hints or its url', () => {
        expect(fileKeyOf({ url: 'https://h/resolve/x/Show.S01E02.mkv', behaviorHints: { videoSize: 5 } })).toBe('Show.S01E02.mkv|5');
        expect(fileKeyOf({ url: 'https://h/other', behaviorHints: { filename: 'Show.S01E02.mkv', videoSize: 5 } })).toBe('Show.S01E02.mkv|5');
    });
});

describe('skip intro: fast-forward on Skip', () => {
    const { planSkip, stepFastForward } = require('../src/services/skipSegments/fastForward');

    it('jumps when it cannot or need not play fast', () => {
        expect(planSkip({ now: 10, end: 40, speed: null, paused: false })).toEqual({ jumpTo: 40 });
        expect(planSkip({ now: 10, end: 40, speed: 1, paused: true })).toEqual({ jumpTo: 40 });
        expect(planSkip({ now: 38.5, end: 40, speed: 1, paused: false })).toEqual({ jumpTo: 40 });
    });

    it('plays all of what is left in about two and a half seconds', () => {
        expect(planSkip({ now: 10, end: 34, speed: 1, paused: false })).toMatchObject({ jumpTo: null, speed: 9.6 });
        expect(planSkip({ now: 5, end: 95, speed: 1, paused: false })).toMatchObject({ jumpTo: null, speed: 36 });
        expect(planSkip({ now: 30, end: 35, speed: 1, paused: false })).toMatchObject({ jumpTo: null, speed: 2 });
    });

    it('jumps part of the way only when even the top speed would take too long', () => {
        expect(planSkip({ now: 0, end: 400, speed: 1, paused: false })).toMatchObject({ jumpTo: 150, speed: 100 });
    });

    const ff = { end: 40, speed: 8, last: 20, settleUntil: 1000 };
    it('stops short of the end at speed, to seek there exactly', () => {
        expect(stepFastForward(ff, { now: 30, buffering: false, wallNow: 2000 })).toBe('continue');
        expect(stepFastForward(ff, { now: 37.5, buffering: false, wallNow: 2000 })).toBe('land');
    });

    it('jumps the rest when the stream runs short, but not on its own seek', () => {
        expect(stepFastForward(ff, { now: 25, buffering: true, wallNow: 500 })).toBe('continue');
        expect(stepFastForward(ff, { now: 25, buffering: true, wallNow: 2000 })).toBe('land');
    });

    it('leaves the viewer where they seeked back to', () => {
        expect(stepFastForward(ff, { now: 12, buffering: false, wallNow: 2000 })).toBe('cancel');
    });
});
