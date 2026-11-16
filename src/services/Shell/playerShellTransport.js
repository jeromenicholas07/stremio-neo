// What each player gets instead of the raw Shell transport.
//
// stremio-shell-ng only understands three calls from the page: set an mpv
// property, run an mpv command, and observe a property. There is no way to
// stop observing, so every observe adds another mpv observer for the life of
// the Shell process, and mpv then reports each change once per observer.
// ShellVideo (stremio-video) asks to observe ~20 properties every time a
// player opens, and never takes its own listeners off the transport when it
// is destroyed. After a few episodes in one session every mpv change arrived
// several times, to every player ever opened: position updates went from
// ~8 to ~82 a second.
//
// So, per page, each property is observed only once; a later player is
// handed the property's latest value instead (as mpv does on a fresh
// observe). ShellVideo asks to observe only when it is created, so the
// first observe from a new player means the previous one is gone: its
// listeners come off then (not on React unmount, which StrictMode replays
// while the player is still in use). And a value a player has already been
// given is not given again, which drops the extra copies from observers left
// by earlier page loads in the same Shell.

// Properties observed in the Shell by this page, and their latest values.
const observed = new Set();
const latest = new Map();
let watchedTransport = null;
// The wrapper of the live player: the last one to ask to observe.
let current = null;
// Values that outlive a file, handed to a later player as a fresh observe
// would. The rest (path, duration, track list, position...) belong to the
// file and mpv reports them anew for each one it loads; the previous file's
// would mislead the player until then. ShellVideo waits for mpv-version
// before it loads anything.
const REPLAYED = new Set(['mpv-version', 'ffmpeg-version', 'volume', 'mute', 'pause', 'speed', 'sub-scale', 'sub-pos', 'sub-delay']);

const same = (a, b) => a === b || (typeof a === 'object' && a !== null && JSON.stringify(a) === JSON.stringify(b));

function trackLatest(transport) {
    if (watchedTransport === transport) return;
    watchedTransport = transport;
    observed.clear();
    latest.clear();
    transport.on('mpv-prop-change', (args) => {
        if (args && typeof args.name === 'string') latest.set(args.name, args.data);
    });
}

/**
 * @param {{ send: Function, on: Function, off: Function }} transport - the Shell transport
 * @returns {{ send: Function, on: Function, off: Function, dispose: Function }}
 */
function createPlayerShellTransport(transport) {
    trackLatest(transport);
    const listeners = [];
    // The last value of each property given to this player.
    let given = new Map();
    let disposed = false;

    const deliver = (listener, args) => {
        if (disposed || !args) return;
        if (given.has(args.name) && same(given.get(args.name), args.data)) return;
        given.set(args.name, args.data);
        listener(args);
    };

    const self = {
        send(event, args) {
            if (event === 'mpv-observe-prop' && typeof args === 'string') {
                // A new player: the previous one is gone, and stops listening.
                if (current !== self) {
                    if (current !== null) current.dispose();
                    current = self;
                }
                if (observed.has(args)) {
                    // Already observed: give this player the current value, once
                    // it has finished setting up its listeners.
                    if (REPLAYED.has(args)) setTimeout(() => {
                        if (!latest.has(args)) return;
                        listeners.filter((entry) => entry.event === 'mpv-prop-change')
                            .forEach((entry) => deliver(entry.listener, { name: args, data: latest.get(args) }));
                    }, 0);
                    return;
                }
                observed.add(args);
            }
            // A new file (or none): its first values are news even if they
            // equal the last file's.
            if (event === 'mpv-command' && Array.isArray(args) && (args[0] === 'loadfile' || args[0] === 'stop')) given = new Map();
            transport.send(event, args);
        },
        on(event, listener) {
            const wrapped = event === 'mpv-prop-change'
                ? (args) => deliver(listener, args)
                : (...args) => { if (!disposed) listener(...args); };
            listeners.push({ event, listener, wrapped });
            transport.on(event, wrapped);
        },
        off(event, listener) {
            const index = listeners.findIndex((entry) => entry.event === event && entry.listener === listener);
            if (index < 0) return;
            transport.off(event, listeners[index].wrapped);
            listeners.splice(index, 1);
        },
        // The player is gone: none of its listeners run again.
        dispose() {
            disposed = true;
            listeners.splice(0).forEach((entry) => transport.off(entry.event, entry.wrapped));
            if (current === self) current = null;
        },
    };
    return self;
}

module.exports = createPlayerShellTransport;
