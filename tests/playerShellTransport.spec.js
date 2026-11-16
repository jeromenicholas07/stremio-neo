// The per-player wrapper around the Shell transport.
const EventEmitter = require('eventemitter3');
const createPlayerShellTransport = require('../src/services/Shell/playerShellTransport');

// A Shell that, like stremio-shell-ng, adds an mpv observer for every observe
// request and reports each change once per observer.
function fakeShell() {
    const events = new EventEmitter();
    const observers = {};
    const sent = [];
    return {
        sent,
        on: (name, listener) => events.on(name, listener),
        off: (name, listener) => events.off(name, listener),
        send: (event, args) => {
            sent.push([event, args]);
            if (event === 'mpv-observe-prop') observers[args] = (observers[args] || 0) + 1;
        },
        change: (name, data) => { for (let i = 0; i < (observers[name] || 0); i++) events.emit('mpv-prop-change', { name, data }); },
        ended: () => events.emit('mpv-event-ended', {}),
    };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// What ShellVideo does: stop, observe, listen.
function player(shell) {
    const transport = createPlayerShellTransport(shell);
    const seen = [];
    let ended = 0;
    transport.send('mpv-command', ['stop']);
    ['mpv-version', 'time-pos', 'duration', 'speed'].forEach((name) => transport.send('mpv-observe-prop', name));
    transport.on('mpv-prop-change', (args) => seen.push(`${args.name}=${args.data}`));
    transport.on('mpv-event-ended', () => { ended++; });
    return { transport, seen, endedCount: () => ended };
}

describe('player Shell transport', () => {
    it('observes each property once however many players open, and earlier players hear nothing', async () => {
        const shell = fakeShell();
        const first = player(shell);
        shell.change('mpv-version', '0.39');
        shell.change('speed', 1);
        const second = player(shell);
        const third = player(shell);
        await tick();
        expect(shell.sent.filter(([event]) => event === 'mpv-observe-prop').length).toBe(4);

        shell.change('time-pos', 12.5);
        shell.ended();
        expect(first.seen).toEqual(['mpv-version=0.39', 'speed=1']);
        expect(third.seen.filter((entry) => entry.startsWith('time-pos'))).toEqual(['time-pos=12.5']);
        expect(first.endedCount()).toBe(0);
        expect(third.endedCount()).toBe(1);
        expect(second.seen).not.toContain('time-pos=12.5');
    });

    it('hands a later player the values that outlive a file, but not the last file\'s duration', async () => {
        const shell = fakeShell();
        const first = player(shell);
        shell.change('mpv-version', '0.39');
        shell.change('speed', 1.5);
        shell.change('duration', 1300);
        const next = player(shell);
        await tick();
        expect(next.seen).toEqual(expect.arrayContaining(['mpv-version=0.39', 'speed=1.5']));
        expect(next.seen.some((entry) => entry.startsWith('duration'))).toBe(false);
    });

    // React StrictMode renders twice: a wrapper made but never used must not
    // cut off the live player.
    it('leaves the live player alone when a wrapper is made but not used', () => {
        const shell = fakeShell();
        const live = player(shell);
        createPlayerShellTransport(shell);
        shell.change('time-pos', 3);
        expect(live.seen).toContain('time-pos=3');
    });

    it('drops repeated copies of a value, and starts afresh for each file', () => {
        const shell = fakeShell();
        const only = player(shell);
        // Two observers left by an earlier page load in the same Shell.
        shell.send('mpv-observe-prop', 'duration');
        shell.send('mpv-observe-prop', 'duration');
        shell.change('duration', 1300);
        expect(only.seen.filter((entry) => entry.startsWith('duration'))).toEqual(['duration=1300']);
        only.transport.send('mpv-command', ['loadfile', 'next.mkv']);
        shell.change('duration', 1300);
        expect(only.seen.filter((entry) => entry.startsWith('duration'))).toEqual(['duration=1300', 'duration=1300']);
    });
});
