// "[RD download]": Real-Debrid fetches a release before it plays.
//
// Opened from an Incognito title's "[RD download]" stream (by auto-pick or by
// hand) when nothing can play right away. The addon's download job
// (/inc/rdjob/<token>, rdJobs.js) has Real-Debrid download the torrent from
// its swarm, even from a seeder or two; this page shows how far it is and
// opens the Player (`next`) as soon as RD has the file. Leaving the page lets
// the job lapse: the addon cancels downloads nobody is waiting for.

const React = require('react');
const { getAddonUrl } = require('./incApi');
const { getAutoPickSelection, recordAutoPickFailure } = require('stremio/common/autoPick');
const styles = require('./IncRdJob.less');

const POLL_MS = 3000;
const AUTO_NEXT_MS = 4000;
const FAILED = new Set(['dead', 'stalled', 'error', 'cancelled']);

function releaseName(token) {
    try {
        const payload = String(token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes)).n || '';
    } catch {
        return '';
    }
}

async function jobRequest(token, method) {
    const res = await fetch(`${getAddonUrl()}/inc/rdjob/${encodeURIComponent(token)}`, { method });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return (await res.json()).job || null;
}

const mb = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

function formatEta(sec) {
    if (!(sec > 0)) return '';
    if (sec < 90) return 'under 2 min left';
    const m = Math.round(sec / 60);
    return m < 90 ? `about ${m} min left` : `about ${Math.round(m / 60)} h left`;
}

function headline(job) {
    if (!job) return 'Asking Real-Debrid…';
    switch (job.state) {
        case 'adding': return 'Asking Real-Debrid…';
        case 'finding': return 'Real-Debrid is looking for peers';
        case 'queued': return 'Waiting in Real-Debrid’s queue';
        case 'downloading': return 'Real-Debrid is downloading this release';
        case 'finishing': return 'Almost there';
        case 'ready': return 'Ready. Starting playback…';
        case 'stalled': return 'Real-Debrid couldn’t finish this release';
        case 'dead': return 'Real-Debrid can’t get this torrent';
        case 'cancelled': return 'Download stopped';
        default: return 'Real-Debrid couldn’t start the download';
    }
}

function IncRdJob({ token, queryParams }) {
    const titleId = queryParams ? queryParams.get('title') || '' : '';
    const next = queryParams ? queryParams.get('next') || '' : '';
    const [job, setJob] = React.useState(null);
    const [problem, setProblem] = React.useState('');
    const leaving = React.useRef(false);
    const name = React.useMemo(() => releaseName(token), [token]);
    const titleLink = `#/incognito/title/${encodeURIComponent(titleId)}`;

    const go = React.useCallback((href) => {
        leaving.current = true;
        window.location.replace(href);
    }, []);

    React.useEffect(() => {
        let timer = null;
        let alive = true;
        const poll = async (first) => {
            if (!alive || leaving.current) return;
            try {
                let j = first ? await jobRequest(token, 'POST') : await jobRequest(token, 'GET');
                // The addon restarted and forgot the job: start it again.
                if (!j && !first) j = await jobRequest(token, 'POST');
                if (!alive) return;
                setJob(j);
                setProblem('');
                if (j && j.state === 'ready' && next) { go(next); return; }
                if (j && FAILED.has(j.state)) return;
            } catch (err) {
                if (!alive) return;
                // An addon without download jobs: play the old way (RD gets ~20 s).
                if (first && err.status === 404 && next) { go(next); return; }
                setProblem('Can’t reach the Incognito addon. Retrying…');
            }
            timer = setTimeout(() => poll(false), POLL_MS);
        };
        poll(true);
        return () => { alive = false; clearTimeout(timer); };
    }, [token, next, go]);

    // Back to the title, telling auto-pick this stream failed so it tries the next one.
    const tryAnother = React.useCallback(async () => {
        try { await jobRequest(token, 'DELETE'); } catch { /* lapses anyway */ }
        const selection = getAutoPickSelection('movie', titleId, titleId);
        const thisLink = `#/incognito/rdjob/${encodeURIComponent(token)}`;
        // Only a stream auto-pick chose is marked failed and re-picked; one
        // picked by hand just goes back to the list.
        if (selection && typeof selection.streamKey === 'string' && selection.streamKey.split('|')[0].split('?')[0] === thisLink) {
            recordAutoPickFailure(selection, 'unavailable');
            go(`${titleLink}?autopickRetry=${Date.now()}&autopickReason=unavailable`);
            return;
        }
        go(titleLink);
    }, [token, titleId, titleLink, go]);

    const cancel = React.useCallback(async () => {
        try { await jobRequest(token, 'DELETE'); } catch { /* lapses anyway */ }
        go(titleLink);
    }, [token, titleLink, go]);

    const failed = job && FAILED.has(job.state);

    // Auto-pick chose this download and it can't finish: move on to the next
    // stream by itself after a moment (a hand-picked one waits for the user).
    const autoPicked = React.useMemo(() => {
        const selection = getAutoPickSelection('movie', titleId, titleId);
        return Boolean(selection && typeof selection.streamKey === 'string'
            && selection.streamKey.split('|')[0].split('?')[0] === `#/incognito/rdjob/${encodeURIComponent(token)}`);
    }, [titleId, token]);
    React.useEffect(() => {
        if (!failed || !autoPicked || (job && job.state === 'cancelled')) return undefined;
        const timer = setTimeout(tryAnother, AUTO_NEXT_MS);
        return () => clearTimeout(timer);
    }, [failed, autoPicked, job, tryAnother]);
    const progress = job ? Math.max(0, Math.min(100, job.progress || 0)) : 0;
    const facts = [];
    if (job && job.state === 'downloading') {
        if (job.bytes) facts.push(`${mb(job.bytes * progress / 100)} of ${mb(job.bytes)}`);
        if (job.speed) facts.push(`${(job.speed / 1024 ** 2).toFixed(1)} MB/s`);
        facts.push(`${job.seeders || 0} ${job.seeders === 1 ? 'peer' : 'peers'}`);
        const eta = formatEta(job.etaSec);
        if (eta) facts.push(eta);
    }

    return (
        <div className={styles['page']}>
            <div className={styles['card']}>
                <div className={styles['headline']}>{headline(job)}</div>
                {name ? <div className={styles['release']} title={name}>{name}</div> : null}
                {!failed ? (
                    <React.Fragment>
                        <div className={styles['bar']}>
                            <div
                                className={job && job.state === 'downloading' ? styles['fill'] : styles['fill-busy']}
                                style={job && job.state === 'downloading' ? { width: `${progress}%` } : undefined}
                            />
                        </div>
                        <div className={styles['facts']}>
                            {job && job.state === 'downloading' ? `${progress.toFixed(1)}% · ${facts.join(' · ')}` : 'Few seeders: Real-Debrid fetches the whole file first, then it plays from Real-Debrid.'}
                        </div>
                    </React.Fragment>
                ) : (
                    <div className={styles['facts']}>
                        {job.message ? `${job.message[0].toUpperCase()}${job.message.slice(1)}.` : ''}
                        {autoPicked && job.state !== 'cancelled' ? ' Trying the next stream…' : ''}
                    </div>
                )}
                {problem ? <div className={styles['problem']}>{problem}</div> : null}
                <div className={styles['buttons']}>
                    <button className={styles['primary']} onClick={tryAnother} type="button">Try another stream</button>
                    <button className={styles['secondary']} onClick={cancel} type="button">{failed ? 'Back to title' : 'Cancel'}</button>
                </div>
                {!failed ? <div className={styles['hint']}>You can leave this page open; playback starts by itself.</div> : null}
            </div>
        </div>
    );
}

module.exports = IncRdJob;
