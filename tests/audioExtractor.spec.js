const { extractEach, TARGET_SAMPLE_RATE } = require('../src/services/subtitleSync/audioExtractor');

// A sidecar stand-in: each request answers with one second of audio after
// `ms`, and records how many were open at once.
function fakeSidecar(ms) {
    const state = { open: 0, most: 0, calls: 0 };
    global.fetch = (url, { signal }) => new Promise((resolve, reject) => {
        state.calls++;
        state.open++;
        state.most = Math.max(state.most, state.open);
        const timer = setTimeout(() => {
            state.open--;
            const body = new Float32Array(TARGET_SAMPLE_RATE).buffer;
            resolve({ ok: true, arrayBuffer: () => Promise.resolve(body) });
        }, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            state.open--;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
        });
    });
    return state;
}

describe('WhisperSync: reading chunks', () => {
    const chunks = [0, 60, 120, 180, 240, 300].map((start) => ({ start, duration: 5 }));

    it('reads every chunk, at most `lanes` at a time, in the order asked', async () => {
        const sidecar = fakeSidecar(20);
        const results = await Promise.all(extractEach('https://host/a.mkv', chunks, null, { lanes: 4 }));
        expect(results.map((r) => r.startTime)).toEqual([0, 60, 120, 180, 240, 300]);
        expect(sidecar.most).toBe(4);
    });

    it('cancels reads in flight and never starts the queued ones', async () => {
        const sidecar = fakeSidecar(1000);
        const reads = new AbortController();
        const pending = extractEach('https://host/a.mkv', chunks, null, { lanes: 2, signal: reads.signal });
        reads.abort();
        const settled = await Promise.allSettled(pending);
        expect(settled.every((r) => r.status === 'rejected' && r.reason.name === 'AbortError')).toBe(true);
        expect(sidecar.calls).toBeLessThanOrEqual(2);
    });
});
