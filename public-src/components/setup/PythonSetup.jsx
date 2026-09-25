import { useEffect, useRef, useState } from 'preact/hooks';
import { post } from '../../setup-state.js';

/**
 * The analysis environment: Python, torch and the models' code, set up from
 * the lockfile by uv with one press (GET/POST /api/python/setup). uv fetches
 * Python itself, so nothing has to be installed first; the torch build is
 * suggested from the graphics card the server can see.
 */

const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
const UV_INSTALL = 'https://docs.astral.sh/uv/getting-started/installation/';

function Progress({ job }) {
  const d = job.downloads;
  const share = d.total ? Math.min(1, d.done / d.total) : 0;
  return (
    <div class="python-progress">
      <p class="setting-help" role="status">{job.phase}…</p>
      {d.count > 0 && (
        <>
          <div class="warm-bar" role="progressbar" aria-label="Downloading the analysis environment" aria-valuemin={0}
            aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
            <div class="warm-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
          <p class="setting-help">{d.finished} of {d.count} large downloads, {size(d.done)} of {size(d.total)}
            {d.current ? ` — ${d.current}` : ''}</p>
        </>
      )}
    </div>
  );
}

export function PythonSetup() {
  const [info, setInfo] = useState(null);   // the status from /api/python/setup
  const [build, setBuild] = useState(null);
  const [error, setError] = useState(null);
  const poll = useRef(null);

  const load = async () => {
    let data;
    try {
      data = await (await fetch('/api/python/setup')).json();
    } catch (err) {
      data = { ok: false, error: err.message };
    }
    setInfo(data);
    clearTimeout(poll.current);
    if (data && data.job && data.job.ok === null) poll.current = setTimeout(load, 1000);
  };
  useEffect(() => { load(); return () => clearTimeout(poll.current); }, []);

  const ready = !!(info && info.ok);
  const job = ready ? info.job : null;
  const running = !!(job && job.ok === null);
  const chosen = build || (running ? job.build : ready ? info.detected.build : null);

  const start = async () => {
    setError(null);
    const res = await post('/api/python/setup', { build: chosen });
    if (!res.ok) setError(res.error || 'The setup could not start.');
    load();
  };
  const cancel = async () => { await post('/api/python/setup/cancel', {}); load(); };

  let body;
  if (!info) body = <p class="setting-help">Looking at what is here…</p>;
  else if (!info.ok) body = <p class="setting-help setting-note warn">{info.error || 'Could not ask the server.'}</p>;
  else {
    const labelOf = (id) => (info.builds.find((b) => b.id === id) || { label: id }).label;
    const marker = info.environment.marker;
    body = (
      <>
        {info.python.ready ? (
          <p class="setting-help setting-note ok">
            Ready: Python {info.python.version}, {info.python.executable}
            {marker ? ` — set up here with the ${labelOf(marker.build)} build.` : '.'}
          </p>
        ) : (
          <p class="setting-help setting-note warn">
            Not set up{info.python.missing.length ? `: ${info.python.missing.join(', ')} missing` : ''}. The analysis needs
            Python with torch and the models' code — a few gigabytes to download, more with CUDA.
          </p>
        )}
        {!info.uv ? (
          <p class="setting-help setting-note warn">
            uv, which does the setting up, is not installed. Install it (<a href={UV_INSTALL} target="_blank" rel="noopener">one
            command</a>), then look again.
          </p>
        ) : (
          <div class="setting-row">
            <div class="setting-field">
              <label for="python-build">Torch build</label>
              <div class="setting-control">
                <select id="python-build" value={chosen} disabled={running} aria-describedby="python-build-help"
                  onChange={(e) => setBuild(e.target.value)}>
                  {info.builds.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                </select>
              </div>
            </div>
            <p class="setting-help" id="python-build-help">
              Suggested: {labelOf(info.detected.build)} — {info.detected.why}. Python {info.pythonVersion} comes with it.
            </p>
          </div>
        )}
        <div class="setting-actions">
          {running
            ? <button type="button" class="btn sm" onClick={cancel}>Cancel</button>
            : <button type="button" class="btn sm active" disabled={!info.uv} onClick={start}>
              {info.environment.exists ? 'Update the environment' : 'Set up the analysis environment'}
            </button>}
          <button type="button" class="btn sm" disabled={running} onClick={load}>Look again</button>
        </div>
        {running && <Progress job={job} />}
        {job && job.ok === true && (
          <p class="setting-help" role="status">Set up with the {labelOf(job.build)} build. The analyser has started again on it —
            the models it needs are below.</p>
        )}
        {job && job.ok === false && (
          <p class="setting-help setting-note warn" role="status">{job.phase === 'Cancelled' ? 'Cancelled.' : `It failed: ${job.error}`}</p>
        )}
        {error && <p class="setting-help setting-note warn" role="alert">{error}</p>}
        {job && job.lines.length > 0 && (
          <details class="python-log-details" open={job.ok === false}>
            <summary>What uv said</summary>
            <pre class="python-log" role="log" aria-label="The setup's output" tabIndex={0}>{job.lines.slice(-40).join('\n')}</pre>
          </details>
        )}
        <p class="setting-help python-where">In {info.environment.dir}{info.uv ? `, by ${info.uv.version || 'uv'} (${info.uv.from === 'bundled' ? 'the one that came with the app' : info.uv.command})` : ''}.</p>
      </>
    );
  }
  return (
    <section class="panel" aria-labelledby="python-title">
      <header class="panel-head"><h2 class="panel-title" id="python-title">Analysis environment</h2></header>
      <p class="section-desc">Python and what the analysis runs on, installed from the app's lockfile. While it is set up the
        analyser waits, and starts again on what was made.</p>
      {body}
    </section>
  );
}
