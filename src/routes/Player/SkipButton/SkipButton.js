const React = require('react');
const PropTypes = require('prop-types');
const classnames = require('classnames');
const { Button } = require('stremio/components');
const styles = require('./styles');

const NAMES = { intro: 'intro', recap: 'recap' };

const CONFIDENCE = {
    high: 'High confidence: can skip automatically',
    medium: 'Medium confidence: button only',
    low: 'Low confidence: button only',
};

const SOURCES = {
    audio: 'matched other episodes',
    chapter: 'chapter in the file',
    'chapter-mark': 'chapter mark',
    theintrodb: 'TheIntroDB',
    introdb: 'IntroDB',
};

const clock = (seconds) => {
    const total = Math.max(0, Math.round(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// How the times were worked out, e.g. "Intro 1:27 to 2:13, from matched other episodes + chapter mark".
const describe = (segment) => {
    const name = NAMES[segment.type] || segment.type;
    const sources = (segment.sources || []).map((source) => SOURCES[source] || source).join(' + ');
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${clock(segment.start)} to ${clock(segment.end)}${sources ? `, from ${sources}` : ''}`;
};

// What this show should do from now on. `null` follows the global setting.
const SHOW_CHOICES = [
    { mode: 'auto', label: 'Always skip for this show' },
    { mode: 'button', label: 'Ask each time for this show' },
    { mode: 'off', label: 'Never for this show' },
    { mode: null, label: 'Use my default' },
];

const SkipButton = ({ className, segment, notice, override, onSkip, onUndo, onOverrideChange }) => {
    const [menuOpen, setMenuOpen] = React.useState(false);
    const toggleMenu = React.useCallback(() => setMenuOpen((open) => !open), []);
    const choose = React.useCallback((event) => {
        const mode = event.currentTarget.dataset.mode;
        onOverrideChange(mode === '' ? null : mode);
        setMenuOpen(false);
    }, [onOverrideChange]);
    React.useEffect(() => {
        if (segment === null) setMenuOpen(false);
    }, [segment]);

    if (notice !== null) {
        return (
            <div className={classnames(className, styles['skip-button-container'])}>
                <div className={styles['notice']}>Skipped {NAMES[notice.type]}</div>
                <Button className={styles['skip-button']} title={'Undo'} onClick={onUndo}>
                    <div className={styles['label']}>Undo</div>
                </Button>
            </div>
        );
    }
    if (segment === null) return null;

    return (
        <div className={classnames(className, styles['skip-button-container'])}>
            {
                menuOpen ?
                    <div className={styles['menu']}>
                        <div className={styles['details']}>
                            <div className={styles['details-line']}>{describe(segment)}</div>
                            <div className={classnames(styles['details-line'], styles[segment.confidence])}>
                                {CONFIDENCE[segment.confidence] || segment.confidence}
                            </div>
                        </div>
                        {SHOW_CHOICES.map(({ mode, label }) => (
                            <Button
                                key={label}
                                className={classnames(styles['menu-item'], { [styles['selected']]: override === mode })}
                                data-mode={mode === null ? '' : mode}
                                onClick={choose}
                            >
                                <div className={styles['label']}>{label}</div>
                            </Button>
                        ))}
                    </div>
                    :
                    null
            }
            <Button className={classnames(styles['skip-button'], styles['primary'])} title={`Skip ${NAMES[segment.type]}`} onClick={onSkip}>
                <div className={styles['label']}>Skip {NAMES[segment.type]}</div>
            </Button>
            <Button className={styles['skip-button']} title={'Skip options for this show'} onClick={toggleMenu}>
                <div className={styles['label']}>&#8943;</div>
            </Button>
        </div>
    );
};

SkipButton.propTypes = {
    className: PropTypes.string,
    segment: PropTypes.shape({
        type: PropTypes.string.isRequired,
        start: PropTypes.number,
        end: PropTypes.number,
        confidence: PropTypes.string,
        sources: PropTypes.arrayOf(PropTypes.string),
    }),
    notice: PropTypes.shape({
        type: PropTypes.string.isRequired,
    }),
    override: PropTypes.string,
    onSkip: PropTypes.func.isRequired,
    onUndo: PropTypes.func.isRequired,
    onOverrideChange: PropTypes.func.isRequired,
};

module.exports = SkipButton;
