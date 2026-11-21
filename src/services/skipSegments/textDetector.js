// Promise wrapper around creditTextWorker: which frames of a read show
// credits, judged off the player's thread. Null when no worker runs here; the
// caller then judges the frames itself, with the dark-frame test alone.

let worker = null;
let failed = false;
let nextId = 1;
const pending = new Map();

// Where the build put onnxruntime's glue script and WebAssembly (see
// webpack.config.js), as an absolute URL: a worker started from a blob
// cannot resolve the bundle's own relative one.
function wasmUrl() {
    // eslint-disable-next-line no-undef
    const publicPath = __webpack_public_path__ || '/';
    return `${window.location.origin}${publicPath}${process.env.COMMIT_HASH}/binaries/`;
}

function start() {
    if (worker || failed) return worker;
    try {
        // eslint-disable-next-line no-undef
        const publicPath = __webpack_public_path__ || '/';
        const scriptUrl = `${window.location.origin}${publicPath}${process.env.COMMIT_HASH}/scripts/creditTextWorker.js`;
        const blob = new Blob([`importScripts("${scriptUrl}");`], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
        worker.onmessage = (event) => {
            const { id, error, ...result } = event.data;
            const entry = pending.get(id);
            if (!entry) return;
            pending.delete(id);
            if (error) entry.reject(new Error(error));
            else entry.resolve(result);
        };
        worker.onerror = () => {
            failed = true;
            worker = null;
            pending.forEach((entry) => entry.reject(new Error('text detector worker failed')));
            pending.clear();
        };
    } catch {
        failed = true;
        worker = null;
    }
    return worker;
}

/**
 * Judge a read's frames in the worker (creditJudge with the text detector).
 * Null when no worker can run; the caller then judges them itself.
 *
 * @param {{ data: Uint8Array, width: number, height: number }} frames - grey
 *   frames back to back; the height a multiple of 32
 * @returns {Promise<{ verdicts: Array<{ text: boolean, fits: boolean, darkText: boolean }>, small: Uint8Array, device: string | null } | null>}
 */
async function judgeInWorker(frames) {
    if (!start()) return null;
    try {
        return await new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            // Copied, not transferred: if the worker fails, the caller judges
            // the same frames itself.
            worker.postMessage({ id, op: 'judge', data: frames.data, width: frames.width, height: frames.height, wasmUrl: wasmUrl() });
        });
    } catch (error) {
        console.warn('[SkipIntro] frames worker failed:', error && error.message ? error.message : error);
        return null;
    }
}

/**
 * Where people talk in 16 kHz mono audio (Silero VAD in the worker). Null
 * when no worker or no model: the story end is then judged from the
 * picture alone.
 *
 * @param {Float32Array} pcm
 * @param {number} from - seconds of the first sample in the file
 * @returns {Promise<Array<{ start: number, end: number }> | null>}
 */
async function speechInWorker(pcm, from) {
    if (!start()) return null;
    try {
        const result = await new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            worker.postMessage({ id, op: 'speech', pcm, from, wasmUrl: wasmUrl() });
        });
        return result.segments;
    } catch (error) {
        console.warn('[SkipIntro] speech detector unavailable:', error && error.message ? error.message : error);
        return null;
    }
}

module.exports = { judgeInWorker, speechInWorker };
