const React = require('react');
const analyzer = require('stremio/services/skipSegments/analyzer');
const {
    CHANGE_EVENT,
    getSkipSettings,
    getSkipOverride,
    setSkipOverride,
} = require('stremio/services/skipSegments/settings');
const { FF_SEEK_SETTLE_MS, planSkip, stepFastForward } = require('stremio/services/skipSegments/fastForward');
const { getPlayableAutoPickSettings } = require('stremio/common/autoPick');

// Segments that are jumped over. Credits are handled differently: they bring
// the next-episode popup forward instead of seeking.
const SKIPPABLE = ['intro', 'recap'];
// Stop offering the skip this close to the end of the segment.
const END_MARGIN_SECONDS = 1;
const NOTICE_MS = 8000;
// Seconds of smooth playback before the analysis may read (see below).
const SETTLE_AFTER_LOAD_SECONDS = 45;
const SETTLE_AFTER_SEEK_SECONDS = 30;
const SETTLE_AFTER_STALL_SECONDS = 15;

/**
 * Skip Intro for the episode being played.
 *
 * Times in and out are in milliseconds, like the rest of the player; the
 * analyzer works in seconds.
 */
const useSkipSegments = ({ player, stream, time, duration, buffering, paused, playbackSpeed, streamingServerUrl, onSeek, onSpeed }) => {
    const metaItem = player.metaItem !== null && player.metaItem.type === 'Ready' ? player.metaItem.content : null;
    const request = player.selected !== null ? player.selected.streamRequest : null;
    const path = request !== null && request !== undefined && request.path ? request.path : null;
    const videoId = path !== null ? path.id : null;
    const type = path !== null ? path.type : null;
    const metaId = metaItem !== null ? metaItem.id : null;
    const durationSeconds = typeof duration === 'number' && duration > 0 ? Math.round(duration / 1000) : null;

    const [settingsVersion, setSettingsVersion] = React.useState(0);
    React.useEffect(() => {
        const onChange = () => setSettingsVersion((version) => version + 1);
        window.addEventListener(CHANGE_EVENT, onChange);
        return () => window.removeEventListener(CHANGE_EVENT, onChange);
    }, []);
    const override = React.useMemo(() => getSkipOverride(metaId), [metaId, settingsVersion]);
    const globalMode = React.useMemo(() => getSkipSettings().mode, [settingsVersion]);
    const autoNext = React.useMemo(() => getSkipSettings().autoNext, [settingsVersion]);
    const mode = override || globalMode;

    const jobRef = React.useRef(null);
    jobRef.current = { metaItem, request, stream, streamingServerUrl };
    const streamId = stream ? (stream.url || `${stream.infoHash}:${stream.fileIdx}`) : null;
    // Never for the Incognito section: no analysis, no database lookups, nothing
    // kept. Its plays carry no show or episode anyway; its streams are marked by
    // their binge group (useIncognitoPlay).
    const bingeGroup = stream && stream.behaviorHints ? stream.behaviorHints.bingeGroup : null;
    const incognito = typeof bingeGroup === 'string' && bingeGroup.startsWith('incognito');
    const enabled = mode !== 'off' && !incognito && type === 'series' && videoId !== null && metaId !== null && streamId !== null && durationSeconds !== null
        // Shorter is a debrid placeholder clip, not an episode.
        && durationSeconds >= 120;

    const [key, setKey] = React.useState(null);
    const [result, setResult] = React.useState(null);
    React.useEffect(() => {
        if (!enabled) {
            setKey(null);
            setResult(null);
            return;
        }
        const job = jobRef.current;
        const video = job.metaItem.videos.find(({ id }) => id === videoId);
        const jobKey = analyzer.watch({
            type,
            metaId,
            videoId,
            season: video && typeof video.season === 'number' ? video.season : null,
            videos: job.metaItem.videos,
            stream: job.stream,
            transportUrl: job.request.base,
            streamingServerUrl: job.streamingServerUrl,
            duration: durationSeconds,
        });
        setKey(jobKey);
        setResult(analyzer.getResult(jobKey));
        return analyzer.subscribe((next) => {
            if (next.key === jobKey) setResult(next);
        });
    }, [enabled, type, metaId, videoId, streamId, durationSeconds]);

    React.useEffect(() => () => analyzer.release(), []);

    // The analysis reads share the connection with the player. Hold them
    // until it has played smoothly for a while after loading or a seek, and
    // stop them whenever it runs short of data. Counted in media time, so a
    // paused player that has not got going yet does not count as smooth.
    const smooth = React.useRef({ played: 0, need: SETTLE_AFTER_LOAD_SECONDS, last: null });
    React.useEffect(() => {
        smooth.current = { played: 0, need: SETTLE_AFTER_LOAD_SECONDS, last: null };
        analyzer.setReady(false);
    }, [streamId]);
    React.useEffect(() => {
        const state = smooth.current;
        const previous = state.last;
        state.last = time;
        if (buffering) {
            // Once going, a stall only needs a short recovery.
            if (state.played >= state.need) state.need = SETTLE_AFTER_STALL_SECONDS;
            state.played = 0;
            analyzer.setReady(false);
            return;
        }
        if (typeof previous === 'number' && typeof time === 'number') {
            const step = time - previous;
            if (step < 0 || step > 3000) {
                state.played = 0;
                state.need = SETTLE_AFTER_SEEK_SECONDS;
            } else {
                state.played += step / 1000;
            }
        }
        analyzer.setReady(state.played >= state.need);
    }, [time, buffering]);

    const seconds = typeof time === 'number' ? time / 1000 : null;
    const segments = result !== null ? result.segments : [];
    const active = React.useMemo(() => {
        if (seconds === null) return null;
        return segments.find((segment) =>
            SKIPPABLE.includes(segment.type) && seconds >= segment.start && seconds < segment.end - END_MARGIN_SECONDS
        ) || null;
    }, [segments, seconds]);

    // Each segment is skipped automatically at most once per play, so seeking
    // back into it (or pressing Undo) leaves the viewer in control.
    const handled = React.useRef(new Set());
    const [notice, setNotice] = React.useState(null);
    React.useEffect(() => {
        handled.current = new Set();
        setNotice(null);
    }, [key]);
    React.useEffect(() => {
        if (notice === null) return;
        const timer = setTimeout(() => setNotice(null), NOTICE_MS);
        return () => clearTimeout(timer);
    }, [notice]);

    const previousTime = React.useRef(null);
    React.useEffect(() => {
        const previous = previousTime.current;
        previousTime.current = time;
        if (mode !== 'auto' || active === null || active.confidence !== 'high' || handled.current.has(active.type)) return;
        // Only while the video is simply playing forward. A jump (the resume
        // seek at start, or the viewer scrubbing) must not be answered with
        // another jump.
        if (typeof previous !== 'number' || time <= previous || time - previous > 3000) return;
        handled.current.add(active.type);
        setNotice({ type: active.type, from: time });
        onSeek(Math.round(active.end * 1000));
    }, [time, mode, active]);

    // Skip plays the rest of the segment fast instead of cutting, where the
    // player can change speed; it stops a moment early and seeks to the exact
    // end, since at speed each time update moves a few seconds. It falls back
    // to a plain jump if the stream runs short of data on the way.
    // (see services/skipSegments/fastForward). The player's callbacks are held
    // in refs: they change identity with the player's state, and a stop
    // function that changed with them would end a fast-forward midway.
    const fastForward = React.useRef(null);
    const latest = React.useRef(null);
    latest.current = { onSeek, onSpeed, playbackSpeed };
    const stopFastForward = React.useCallback((landAt) => {
        const ff = fastForward.current;
        if (ff === null) return;
        fastForward.current = null;
        clearTimeout(ff.watchdog);
        // Only undo a speed this set: the viewer may have picked one since.
        if (latest.current.playbackSpeed === ff.speed) latest.current.onSpeed(ff.previousSpeed);
        if (typeof landAt === 'number') latest.current.onSeek(Math.round(landAt * 1000));
    }, []);

    const skip = React.useCallback(() => {
        if (active === null || fastForward.current !== null) return;
        handled.current.add(active.type);
        const end = active.end;
        const from = typeof time === 'number' ? time / 1000 : null;
        const plan = planSkip({ now: from, end, speed: playbackSpeed, paused: Boolean(paused) });
        if (typeof plan.jumpTo === 'number') onSeek(Math.round(plan.jumpTo * 1000));
        if (!plan.speed) return;
        fastForward.current = {
            end,
            speed: plan.speed,
            previousSpeed: playbackSpeed,
            last: from,
            settleUntil: Date.now() + FF_SEEK_SETTLE_MS,
            watchdog: setTimeout(() => stopFastForward(end), plan.watchdogMs),
        };
        onSpeed(plan.speed);
    }, [active, time, paused, playbackSpeed, onSeek, onSpeed, stopFastForward]);

    React.useEffect(() => {
        const ff = fastForward.current;
        if (ff === null || typeof time !== 'number') return;
        const now = time / 1000;
        const step = stepFastForward(ff, { now, buffering: Boolean(buffering), wallNow: Date.now() });
        if (step === 'land') stopFastForward(ff.end);
        else if (step === 'cancel') stopFastForward();
        else ff.last = Math.max(ff.last, now);
    }, [time, buffering, stopFastForward]);
    React.useEffect(() => {
        // Paused, or a speed picked from the menu: hand control back.
        const ff = fastForward.current;
        if (ff !== null && (paused || (typeof playbackSpeed === 'number' && playbackSpeed !== ff.speed && playbackSpeed !== ff.previousSpeed))) {
            stopFastForward();
        }
    }, [paused, playbackSpeed, stopFastForward]);
    // Never leave the player fast after a change of episode or closing it.
    React.useEffect(() => () => stopFastForward(), [key, stopFastForward]);

    const undo = React.useCallback(() => {
        if (notice === null) return;
        onSeek(notice.from);
        setNotice(null);
    }, [notice, onSeek]);

    const setOverride = React.useCallback((next) => {
        setSkipOverride(metaId, next);
    }, [metaId]);

    // Where credits of at least this confidence start, in the second half of
    // the file, in milliseconds.
    const creditsFrom = (accept) => {
        const credits = segments.find((segment) => segment.type === 'credits' && accept(segment.confidence, segment));
        return credits && durationSeconds !== null && credits.start > durationSeconds / 2 ? Math.round(credits.start * 1000) : null;
    };
    const creditsStart = React.useMemo(() => creditsFrom((confidence) => confidence !== 'low'), [segments, durationSeconds]);
    // Where to start counting down to the next episode: where the popup
    // opens (the story's end, see storyEnd), when the viewer turned that on
    // and the end can be trusted: credits found with high confidence, or an
    // end of story checked by listening (no one still talking). A guess (the
    // season's usual length) or an end judged without hearing the audio only
    // opens the popup. Only with Auto-Pick on for the show: without it the
    // next episode stops at its streams list.
    const autoNextAt = React.useMemo(() => {
        if (!autoNext || !getPlayableAutoPickSettings(type, metaId)) return null;
        return creditsFrom((confidence, segment) => confidence === 'high' || (confidence !== 'low' && segment.story === 'heard'));
    }, [segments, durationSeconds, autoNext, type, metaId, settingsVersion]);

    return {
        active: notice === null ? active : null,
        notice,
        skip,
        undo,
        mode,
        override,
        setOverride,
        creditsStart,
        autoNextAt,
    };
};

module.exports = useSkipSegments;
