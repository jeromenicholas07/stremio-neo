// Finds lines of text in grey video frames for Skip Intro's credits, on the
// GPU through WebGPU where the browser has it, else on the CPU (WASM). The
// model is PaddleOCR's PP-OCRv4 mobile text detector (4.7 MB, Apache-2.0),
// downloaded once and kept in the Cache API like WhisperSync's model.

import * as ort from 'onnxruntime-web/webgpu';
import { boxesFromMap, linesFromBoxes, textFrame } from '../services/skipSegments/creditText';
import { judgeFrames } from '../services/skipSegments/creditJudge';
import { speechSegments, RATE, CHUNK, CONTEXT } from '../services/skipSegments/speech';

// Pinned to a commit so a change upstream cannot swap the model under us.
const MODEL_URL = 'https://huggingface.co/SWHL/RapidOCR/resolve/1cfba2e90fc938db55889873735088de210cc173/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx';
const MODEL_CACHE = 'skip-models-v1';
// ImageNet normalisation, as PaddleOCR trains it; grey frames use the same
// value in all three channels.
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
// Frames per model run: enough to keep the GPU busy, small enough for WASM.
const BATCH_WEBGPU = 8;
const BATCH_WASM = 2;

let sessionPromise = null;
let device = null;

async function modelBytes(url = MODEL_URL) {
    let cache = null;
    try {
        cache = await caches.open(MODEL_CACHE);
        const hit = await cache.match(url);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch { /* no Cache API: download every time */ }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`model download failed: ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (cache) {
        try { await cache.put(url, new Response(bytes.slice(0))); } catch { /* full: next time */ }
    }
    return new Uint8Array(bytes);
}

async function webgpuAvailable() {
    try {
        return Boolean(typeof navigator !== 'undefined' && navigator.gpu && await navigator.gpu.requestAdapter());
    } catch {
        return false;
    }
}

function session(wasmUrl) {
    if (!sessionPromise) {
        sessionPromise = (async () => {
            // The folder holding onnxruntime's glue script and binary.
            if (wasmUrl) ort.env.wasm.wasmPaths = wasmUrl;
            // Threads need a cross-origin isolated page, which this is not.
            ort.env.wasm.numThreads = 1;
            const bytes = await modelBytes();
            if (await webgpuAvailable()) {
                try {
                    const created = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
                    device = 'webgpu';
                    return created;
                } catch (error) {
                    console.warn('[SkipIntro] text detector: WebGPU failed, using the CPU:', error && error.message);
                }
            }
            const created = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
            device = 'wasm';
            return created;
        })();
        sessionPromise.catch(() => { sessionPromise = null; });
    }
    return sessionPromise;
}

/**
 * Per frame: whether it looks like credits, and how many lines it holds.
 * The frame height must be a multiple of 32 (the model's stride).
 */
async function detect({ data, width, height, wasmUrl }) {
    const model = await session(wasmUrl);
    const size = width * height;
    const count = Math.floor(data.length / size);
    const batch = device === 'webgpu' ? BATCH_WEBGPU : BATCH_WASM;
    const verdicts = [];
    for (let first = 0; first < count; first += batch) {
        const n = Math.min(batch, count - first);
        const input = new Float32Array(n * 3 * size);
        for (let f = 0; f < n; f++) {
            const frame = data.subarray((first + f) * size, (first + f + 1) * size);
            for (let c = 0; c < 3; c++) {
                const offset = (f * 3 + c) * size;
                const scale = 1 / (255 * STD[c]);
                const shift = MEAN[c] / STD[c];
                for (let i = 0; i < size; i++) input[offset + i] = frame[i] * scale - shift;
            }
        }
        const feeds = { [model.inputNames[0]]: new ort.Tensor('float32', input, [n, 3, height, width]) };
        const output = (await model.run(feeds))[model.outputNames[0]];
        const maps = output.data;
        for (let f = 0; f < n; f++) {
            const map = maps.subarray(f * size, (f + 1) * size);
            const lines = linesFromBoxes(boxesFromMap(map, width, height));
            const verdict = textFrame(lines, width, height);
            verdicts.push({ text: verdict.text, weak: verdict.weak, weakY: verdict.weakY, box: verdict.box, list: verdict.list, lines: verdict.lines });
        }
        if (typeof output.dispose === 'function') output.dispose();
    }
    return { verdicts, device };
}

// ── Speech (Silero VAD, MIT) ────────────────────────────────────────────────
// A small recurrent model: it runs on the CPU in milliseconds per minute of
// audio, which leaves the GPU to the frames.
const VAD_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec/onnx/model.onnx';
const VAD_SHA256 = 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808';
let vadPromise = null;

async function verified(bytes, sha256) {
    if (!crypto || !crypto.subtle) return bytes;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== sha256) throw new Error('speech model does not match its checksum');
    return bytes;
}

function vadSession(wasmUrl) {
    if (!vadPromise) {
        vadPromise = (async () => {
            if (wasmUrl) ort.env.wasm.wasmPaths = wasmUrl;
            ort.env.wasm.numThreads = 1;
            let bytes;
            try {
                bytes = await verified(await modelBytes(VAD_URL), VAD_SHA256);
            } catch (error) {
                // A damaged copy in the cache: drop it, download it next time.
                try { await (await caches.open(MODEL_CACHE)).delete(VAD_URL); } catch { /* no cache */ }
                throw error;
            }
            return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
        })();
        vadPromise.catch(() => { vadPromise = null; });
    }
    return vadPromise;
}

// Speech probability per CHUNK samples of 16 kHz mono audio.
async function speechProbabilities(pcm, wasmUrl) {
    const model = await vadSession(wasmUrl);
    let state = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(RATE)]), []);
    const count = Math.floor(pcm.length / CHUNK);
    const probabilities = new Float32Array(count);
    const input = new Float32Array(CONTEXT + CHUNK);
    for (let i = 0; i < count; i++) {
        input.copyWithin(0, CHUNK, CHUNK + CONTEXT);
        if (i === 0) input.fill(0, 0, CONTEXT);
        input.set(pcm.subarray(i * CHUNK, (i + 1) * CHUNK), CONTEXT);
        const out = await model.run({ input: new ort.Tensor('float32', input.slice(), [1, CONTEXT + CHUNK]), state, sr });
        probabilities[i] = out.output.data[0];
        state = out.stateN;
    }
    return probabilities;
}

self.onmessage = async (event) => {
    const { id, op } = event.data;
    try {
        if (op === 'speech') {
            const probabilities = await speechProbabilities(event.data.pcm, event.data.wasmUrl);
            self.postMessage({ id, segments: speechSegments(probabilities, event.data.from || 0) });
        } else if (op === 'judge') {
            // Both tests on the frames; without the model (no download, no
            // GPU or CPU backend), the dark test alone.
            const frames = event.data;
            const judged = await judgeFrames(frames, (input) => detect({ ...input, wasmUrl: frames.wasmUrl }).catch((error) => {
                console.warn('[SkipIntro] text detector unavailable:', error && error.message ? error.message : error);
                return null;
            }));
            self.postMessage({ id, ...judged }, [judged.small.buffer]);
        } else {
            self.postMessage({ id, error: `unknown op ${op}` });
        }
    } catch (error) {
        self.postMessage({ id, error: error && error.message ? error.message : String(error) });
    }
};
