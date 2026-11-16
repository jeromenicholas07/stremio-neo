// Skip plays the rest of a segment fast instead of cutting, where the player
// can change speed (useSkipSegments drives it; these are its decisions, kept
// apart so they can be tested). It stops a moment early and seeks to the
// exact end, since at speed each time update moves a few seconds, and falls
// back to a plain jump when the stream runs short of data on the way.

// The whole rest of the segment in about this long, whatever its length: the
// speed follows from it (a 90 s intro plays at 36x). mpv takes up to 100x.
// At that pace the sound will likely drop out (mpv's pitch-corrected audio
// has an upper speed limit) and frames are dropped; only a segment longer
// than 100x this is jumped part of the way first.
const FF_SECONDS = 2.5;
const FF_MAX_SPEED = 100;
const FF_MIN_SPEED = 2;
// Shorter than this left, a jump is just as good.
const FF_MIN_SECONDS = 3;
// Stop this long (in real time, so it scales with speed) before the end.
const FF_STOP_EARLY_SECONDS = 0.35;
// Not there this long after it should have been (the player could not
// decode or fetch that fast): jump the rest, so it never takes much over 4 s.
const FF_GRACE_SECONDS = 1.5;
// The player reports its own seek as buffering for a moment.
const FF_SEEK_SETTLE_MS = 1500;

/**
 * What a click on Skip does.
 *
 * @param {{ now: number|null, end: number, speed: number|null, paused: boolean }} state - seconds
 * @returns {{ jumpTo: number } | { jumpTo: number|null, speed: number, watchdogMs: number }}
 *   a plain jump, or a fast-forward through all of what is left (after a
 *   jump only when even the top speed would take too long)
 */
function planSkip({ now, end, speed, paused }) {
    const remaining = typeof now === 'number' ? end - now : 0;
    if (typeof speed !== 'number' || speed <= 0 || paused || remaining < FF_MIN_SECONDS) return { jumpTo: end };
    const span = Math.min(remaining, FF_MAX_SPEED * FF_SECONDS);
    const rate = Math.max(FF_MIN_SPEED, Math.min(FF_MAX_SPEED, Math.round((span / FF_SECONDS) * 10) / 10));
    return {
        jumpTo: span < remaining ? end - span : null,
        speed: rate,
        watchdogMs: (span / rate + FF_GRACE_SECONDS) * 1000,
    };
}

/**
 * On each time update while fast-forwarding.
 *
 * @param {{ end: number, speed: number, last: number, settleUntil: number }} ff
 * @param {{ now: number, buffering: boolean, wallNow: number }} update - `now` in seconds, `wallNow` in ms
 * @returns {'continue'|'land'|'cancel'} land: seek to the end and restore the
 *   speed; cancel: restore the speed and stay (the viewer seeked back)
 */
function stepFastForward(ff, { now, buffering, wallNow }) {
    // Short of data at this speed: jump the rest. A stall with no time
    // updates at all is caught by the watchdog.
    if (buffering) return wallNow >= ff.settleUntil ? 'land' : 'continue';
    if (now < ff.last - 1) return 'cancel';
    if (now >= ff.end - ff.speed * FF_STOP_EARLY_SECONDS) return 'land';
    return 'continue';
}

module.exports = {
    FF_SEEK_SETTLE_MS,
    planSkip,
    stepFastForward,
};
