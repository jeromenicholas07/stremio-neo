// Chapter markers embedded in the file being played. mpv's chapter list is not
// reachable through the shell, so the launcher's ffmpeg sidecar reads them
// (GET /media-info). A launcher without that endpoint answers 404, which is
// treated the same as a file with no chapters.

const MEDIA_INFO_URL = 'http://127.0.0.1:12471/media-info';
const TIMEOUT_MS = 20000;
const SCENE_CUTS_URL = 'http://127.0.0.1:12471/scene-cuts';
const SCENE_TIMEOUT_MS = 40000;
const FRAMES_URL = 'http://127.0.0.1:12471/frames';
// What /frames returns: 160x90 grey frames, 2 per second.
const FRAME_WIDTH = 160;
const FRAME_HEIGHT = 90;
const FRAME_RATE = 2;

const TITLE_TYPES = [
    ['recap', /^(recap|previously)\b/i],
    ['intro', /^(op|opening|intro|introduction|title sequence|opening credits|main titles?)\b/i],
    ['credits', /^(ed|ending|outro|credits|end credits|closing credits|closing)\b/i],
    ['preview', /^(preview|next( episode| time)?|pv)\b/i],
];

function typeOfTitle(title) {
    const text = typeof title === 'string' ? title.trim() : '';
    const found = TITLE_TYPES.find(([, pattern]) => pattern.test(text));
    return found ? found[0] : null;
}

// Named chapters become segments. Every chapter boundary is also kept as a
// "mark": an unnamed chapter cannot say what it is, but a detected edge that
// lands on one is almost certainly exact.
function parseMediaInfo(info) {
    const chapters = info && Array.isArray(info.chapters) ? info.chapters : [];
    const named = [];
    const marks = [];
    for (const chapter of chapters) {
        const start = Number(chapter.start);
        const end = Number(chapter.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        if (start > 0) marks.push(start);
        const type = typeOfTitle(chapter.title);
        if (type) named.push({ type, start, end });
    }
    return { duration: info && Number.isFinite(info.duration) ? info.duration : null, named, marks };
}

// Hard cuts and black stretches in a few seconds of the file, from the
// launcher. Null when it cannot say (an older launcher answers 404).
async function fetchSceneCuts(mediaUrl, start, seconds, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SCENE_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    try {
        const query = `mediaURL=${encodeURIComponent(mediaUrl)}&start=${start.toFixed(3)}&duration=${seconds}`;
        const response = await fetch(`${SCENE_CUTS_URL}?${query}`, { signal: controller.signal });
        if (!response.ok) return null;
        const body = await response.json();
        return body && Array.isArray(body.cuts) && Array.isArray(body.blacks) ? body : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

// Grey frames of a stretch of the file, from the launcher: 160x90 at 2 per
// second unless asked otherwise (up to 640x360 and 4 per second, for the text
// detector). Null when it cannot say: a read that failed, or an older
// launcher, which answers 404 or ignores the size and rate (caught by the
// frame count).
async function fetchFrames(mediaUrl, start, seconds, signal, options) {
    const width = (options && options.width) || FRAME_WIDTH;
    const height = (options && options.height) || FRAME_HEIGHT;
    const fps = (options && options.fps) || FRAME_RATE;
    const controller = new AbortController();
    // The launcher allows 30 s plus a third of the length; a little more here.
    const timer = setTimeout(() => controller.abort(), 40000 + seconds * 400);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    try {
        let query = `mediaURL=${encodeURIComponent(mediaUrl)}&start=${start.toFixed(3)}&duration=${seconds.toFixed(1)}`;
        if (options) query += `&width=${width}&height=${height}&fps=${fps}`;
        const response = await fetch(`${FRAMES_URL}?${query}`, { signal: controller.signal });
        if (!response.ok) return null;
        const data = new Uint8Array(await response.arrayBuffer());
        const size = width * height;
        const count = data.length / size;
        if (!Number.isInteger(count) || count < 1 || count > seconds * fps + 2) return null;
        return { data, start, fps, width, height };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

async function fetchChapters(mediaUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${MEDIA_INFO_URL}?mediaURL=${encodeURIComponent(mediaUrl)}`, { signal: controller.signal });
        if (!response.ok) return null;
        return parseMediaInfo(await response.json());
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    typeOfTitle,
    parseMediaInfo,
    fetchChapters,
    fetchSceneCuts,
    fetchFrames,
};
