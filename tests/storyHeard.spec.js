// Credits offered at the story's end say how that end was settled: only
// one checked by listening (no one still talking) may play the next episode
// on its own; one judged from the picture alone only opens the popup.
const { fuse } = require('../src/services/skipSegments/fusion');

const run = { start: 1312.42, end: 1368.42, runsOut: true, solid: false };
const creditsOf = (story) => fuse({ duration: 1368.42, creditsPicture: { run, story } }).find((segment) => segment.type === 'credits');

describe('story end: heard or only seen', () => {
    it('says heard when the speech after the credits was listened to', () => {
        expect(creditsOf({ end: 1362.9, heard: true })).toMatchObject({ start: 1362.9, story: 'heard' });
    });

    it('says seen when only the picture judged it', () => {
        expect(creditsOf({ end: 1362.9, heard: false })).toMatchObject({ start: 1362.9, story: 'seen' });
    });

    it('says nothing without a story end', () => {
        expect(creditsOf(undefined).story).toBeUndefined();
    });
});
