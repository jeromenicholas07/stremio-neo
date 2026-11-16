// Runs the Skip Intro signal processing off the main thread. Fingerprinting a
// minute of audio and laying two episodes against each other both take long
// enough to drop frames in the player UI.

const { fingerprintPcm } = require('../services/skipSegments/fingerprint');
const { findSharedSegments } = require('../services/skipSegments/matcher');

self.onmessage = (event) => {
    const { id, op } = event.data;
    try {
        if (op === 'fingerprint') {
            const { hashes, valid } = fingerprintPcm(event.data.pcm, { maxFrames: event.data.maxFrames });
            self.postMessage({ id, hashes, valid }, [hashes.buffer, valid.buffer]);
        } else if (op === 'match') {
            self.postMessage({ id, segments: findSharedSegments(event.data.a, event.data.b, event.data.options) });
        } else {
            self.postMessage({ id, error: `unknown op ${op}` });
        }
    } catch (error) {
        self.postMessage({ id, error: error && error.message ? error.message : String(error) });
    }
};
