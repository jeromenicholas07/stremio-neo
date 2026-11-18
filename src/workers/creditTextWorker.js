// Finds lines of text in grey video frames for Skip Intro's credits, on the
// GPU through WebGPU where the browser has it, else on the CPU (WASM). The
// model is PaddleOCR's PP-OCRv4 mobile text detector (4.7 MB, Apache-2.0),
// downloaded once and kept in the Cache API like WhisperSync's model.

import * as ort from 'onnxruntime-web/webgpu';
import { boxesFromMap, linesFromBoxes, textFrame } from '../services/skipSegments/creditText';
import { judgeFrames } from '../services/skipSegments/creditJudge';

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

async function modelBytes() {
    let cache = null;
    try {
        cache = await caches.open(MODEL_CACHE);
        const hit = await cache.match(MODEL_URL);
        if (hit) return new Uint8Array(await hit.arrayBuffer());
    } catch { /* no Cache API: download every time */ }
    const response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`model download failed: ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (cache) {
        try { await cache.put(MODEL_URL, new Response(bytes.slice(0))); } catch { /* full: next time */ }
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

self.onmessage = async (event) => {
    const { id, op } = event.data;
    try {
        if (op === 'judge') {
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
