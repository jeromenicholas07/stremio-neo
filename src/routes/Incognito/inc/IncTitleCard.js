// Card for a clearnet-catalog title (tube video or studio scene), rendered
// by MetaRow (props are the title's fields spread in) and by the row grid.
//
// Hovering cycles through the title's snapshots. Snapshots are only loaded
// on hover — never ahead of time — because a row of 40 videos × 15 stills
// would otherwise fetch 600 images (and Eporner's go through the addon).

const React = require('react');
const classnames = require('classnames');
const { default: Button } = require('stremio/components/Button');
const { abs, titlePath } = require('./incApi');
const { favoritesActions } = require('./useIncFavorites');
const useIncFavorites = require('./useIncFavorites');
const styles = require('./IncTitleCard.less');

const SNAPSHOT_MS = 650;

function formatDuration(s) {
    if (!s) return '';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function tint(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360}, 35%, 18%)`;
}

// Scenes and movies: "▲ seeders · best quality" once torrents are known for
// them (so playable titles stand out in full-catalogue rows); tube videos:
// the site.
function badgeFor(t) {
    if (t.kind === 'scene' || t.kind === 'movie') {
        if (!(t.releaseCount > 0)) return t.kind === 'movie' ? 'Movie' : '';
        const q = Array.isArray(t.qualities) && t.qualities.length
            ? t.qualities.slice().sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0))[0]
            : '';
        return [`▲ ${t.seeders || 0}`, q].filter(Boolean).join(' · ');
    }
    return t.siteName + (t.alsoOn && t.alsoOn.length ? ` +${t.alsoOn.length}` : '');
}

// Native loading="lazy" doesn't reliably start for cards inside MetaRow's
// transformed scroller, so each card watches its own position and only sets
// its image once it is near the screen.
function useNearScreen() {
    const ref = React.useRef(null);
    const [near, setNear] = React.useState(false);
    React.useEffect(() => {
        const el = ref.current;
        if (!el || near) return undefined;
        if (typeof IntersectionObserver !== 'function') { setNear(true); return undefined; }
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) { setNear(true); io.disconnect(); }
        }, { rootMargin: '300px 600px' });
        io.observe(el);
        return () => io.disconnect();
    }, [near]);
    return [ref, near];
}

const IncTitleCard = React.memo((props) => {
    const { id, name, thumbnail, snapshots, duration, kind, studio, date, performers, className } = props;
    const { isTitle } = useIncFavorites();
    const favorite = isTitle(id);
    const [nearRef, near] = useNearScreen();
    const [frame, setFrame] = React.useState(-1);
    const [imgFailed, setImgFailed] = React.useState(false);
    const timer = React.useRef(null);
    const shots = Array.isArray(snapshots) ? snapshots : [];

    const stop = React.useCallback(() => {
        clearInterval(timer.current);
        timer.current = null;
        setFrame(-1);
    }, []);

    const start = React.useCallback(() => {
        if (shots.length < 2 || timer.current) return;
        setFrame(0);
        timer.current = setInterval(() => setFrame((f) => (f + 1) % shots.length), SNAPSHOT_MS);
    }, [shots.length]);

    React.useEffect(() => () => clearInterval(timer.current), []);

    const onFavorite = React.useCallback((event) => {
        event.preventDefault();
        event.stopPropagation();
        favoritesActions.toggleTitle(props);
    }, [props]);

    const src = frame >= 0 && shots[frame] ? abs(shots[frame]) : abs(thumbnail);
    const sub = kind === 'scene' || kind === 'movie'
        ? [studio, date].filter(Boolean).join(' · ')
        : (Array.isArray(performers) && performers.length ? performers.slice(0, 2).join(', ') : '');
    const badge = badgeFor(props);

    return (
        <Button
            href={titlePath(id)}
            className={classnames(className, styles['inc-card'])}
            style={!thumbnail || imgFailed ? { backgroundColor: tint(id) } : null}
            onMouseEnter={start}
            onMouseLeave={stop}
            onFocus={start}
            onBlur={stop}
            title={name}
        >
            <span ref={nearRef} className={styles['sentinel']} />
            {thumbnail && !imgFailed ? (
                near ? (
                    <img
                        className={styles['thumb']}
                        src={src}
                        alt=""
                        decoding="async"
                        onError={() => { if (frame < 0) setImgFailed(true); }}
                    />
                ) : null
            ) : (
                <div className={styles['no-art']}>{studio || (kind === 'scene' ? 'Studio scene' : '')}</div>
            )}
            {frame >= 0 && shots.length > 1 ? (
                <div className={styles['progress']}>
                    <div className={styles['progress-fill']} style={{ width: `${((frame + 1) / shots.length) * 100}%` }} />
                </div>
            ) : null}
            <button
                type="button"
                className={classnames(styles['fav'], { [styles['on']]: favorite })}
                onClick={onFavorite}
                title={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
                aria-label={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
            >
                {favorite ? '♥' : '♡'}
            </button>
            {badge ? <div className={styles['badge']}>{badge}</div> : null}
            {duration ? <div className={styles['duration']}>{formatDuration(duration)}</div> : null}
            <div className={styles['caption']}>
                <div className={styles['name']}>{name}</div>
                {sub ? <div className={styles['sub']}>{sub}</div> : null}
            </div>
        </Button>
    );
});

IncTitleCard.displayName = 'IncTitleCard';

module.exports = IncTitleCard;
module.exports.formatDuration = formatDuration;
