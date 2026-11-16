// Promise wrapper around skipWorker. Falls back to running on the calling
// thread when a worker cannot be started.

const { fingerprintPcm } = require('./fingerprint');
const { findSharedSegments } = require('./matcher');

let worker = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map();

function startWorker() {
    if (worker || workerFailed) return worker;
    try {
        // Same loading scheme as the Whisper worker: a same-origin blob that
        // imports the built script, so it also works from GitHub Pages.
        const origin = window.location.origin;
        // eslint-disable-next-line no-undef
        const publicPath = __webpack_public_path__ || '/';
        const scriptUrl = `${origin}${publicPath}${process.env.COMMIT_HASH}/scripts/skipWorker.js`;
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
            workerFailed = true;
            worker = null;
            pending.forEach((entry) => entry.reject(new Error('skip worker failed')));
            pending.clear();
        };
    } catch {
        workerFailed = true;
        worker = null;
    }
    return worker;
}

function call(message, transfer) {
    return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, ...message }, transfer || []);
    });
}

async function fingerprint(pcm, maxFrames) {
    if (startWorker()) {
        try {
            return await call({ op: 'fingerprint', pcm, maxFrames }, [pcm.buffer]);
        } catch {
            if (pcm.length === 0) return { hashes: new Int32Array(0), valid: new Uint8Array(0) };
        }
    }
    const { hashes, valid } = fingerprintPcm(pcm, { maxFrames });
    return { hashes, valid };
}

async function match(a, b, options) {
    const left = { hashes: a.hashes, valid: a.valid };
    const right = { hashes: b.hashes, valid: b.valid };
    if (startWorker()) {
        try {
            return (await call({ op: 'match', a: left, b: right, options })).segments;
        } catch { /* fall through to the calling thread */ }
    }
    return findSharedSegments(left, right, options);
}

module.exports = {
    fingerprint,
    match,
};
