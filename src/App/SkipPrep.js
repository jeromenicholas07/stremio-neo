// Keeps Skip Intro's background preparation fed with the Continue Watching
// list (see services/skipSegments/continueWatching). Renders nothing.

const React = require('react');
const { useModelState, useProfile, useStreamingServer, withCoreSuspender } = require('stremio/common');
const { schedule } = require('stremio/services/skipSegments/continueWatching');
const { DEFAULT_STREAMING_SERVER_URL } = require('stremio/common/CONSTANTS');

const SkipPrep = () => {
    const continueWatching = useModelState({ model: 'continue_watching_preview' });
    const profile = useProfile();
    const streamingServer = useStreamingServer();
    const items = continueWatching && Array.isArray(continueWatching.items) ? continueWatching.items : [];
    // Re-queue only when the list itself changes, not on every render.
    const signature = items.slice(0, 8).map((item) => `${item._id}|${item.deepLinks && item.deepLinks.metaDetailsStreams}|${item.progress}`).join(',');
    React.useEffect(() => {
        if (items.length === 0) return;
        schedule({
            items,
            addons: profile && Array.isArray(profile.addons) ? profile.addons : [],
            streamingServerUrl: (streamingServer && streamingServer.baseUrl) || DEFAULT_STREAMING_SERVER_URL,
        });
    }, [signature, profile && profile.addons]);
    return null;
};

// Core models are only there once the core is up (like DeepLinkHandler).
module.exports = withCoreSuspender(SkipPrep);
