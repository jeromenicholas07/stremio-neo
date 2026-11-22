// Ctrl + mouse wheel resizes the cards in Incognito's search and "see all"
// grids (bigger cards, fewer per row, or the reverse) instead of zooming the
// whole page. The size is remembered on this device.
//
// The listener is native and non-passive: React's onWheel is passive, so it
// couldn't stop the browser/Shell from zooming the page.

const React = require('react');

const KEY = 'incognito_grid_card_rem';
const MIN_REM = 9;
const MAX_REM = 34;
const STEP_REM = 1.5;
const DEFAULT_REM = 16;

function readStored() {
    try {
        const v = parseFloat(localStorage.getItem(KEY));
        return Number.isFinite(v) ? Math.min(MAX_REM, Math.max(MIN_REM, v)) : DEFAULT_REM;
    } catch {
        return DEFAULT_REM;
    }
}

/** → [ref for the scrolling container, style for each grid] */
function useGridZoom() {
    const ref = React.useRef(null);
    const [rem, setRem] = React.useState(readStored);

    React.useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const onWheel = (event) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            setRem((cur) => {
                const next = Math.min(MAX_REM, Math.max(MIN_REM, cur + (event.deltaY < 0 ? STEP_REM : -STEP_REM)));
                try { localStorage.setItem(KEY, String(next)); } catch { /* storage blocked */ }
                return next;
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, []);

    const gridStyle = React.useMemo(() => ({ gridTemplateColumns: `repeat(auto-fill, minmax(min(${rem}rem, 100%), 1fr))` }), [rem]);
    return [ref, gridStyle];
}

module.exports = useGridZoom;
