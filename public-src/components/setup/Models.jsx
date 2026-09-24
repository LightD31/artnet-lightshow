import { useEffect, useRef, useState } from 'preact/hooks';
import { post } from '../../setup-state.js';

/**
 * The pretrained models the analysis runs: what is on this machine, and
 * fetching the rest before the show — gigabytes on venue wifi while a track
 * waits is the worst time to find out the connection is slow.
 */

const megabytes = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

export function Models() {
  const [info, setInfo] = useState(null);   // { ok, root, models, job } from /api/models
  const poll = useRef(null);
  const wasRunning = useRef(false);

  const load = async (refresh = false) => {
    let data;
    try {
      data = await (await fetch(`/api/models${refresh ? '?refresh=1' : ''}`)).json();
    } catch (err) {
      data = { ok: false, error: err.message };
    }
    setInfo(data);
    const running = !!(data && data.job && data.job.ok === null);
    clearTimeout(poll.current);
    if (running) poll.current = setTimeout(() => load(), 1000);
    // What just finished changed what is here.
    else if (wasRunning.current) load(true);
    wasRunning.current = running;
  };
  useEffect(() => { load(); return () => clearTimeout(poll.current); }, []);

  const download = async (ids) => {
    const res = await post('/api/models/download', { ids });
    if (res.ok) load();
  };

  let body;
  if (!info) body = <p class="setting-help">Asking the analyser what it has…</p>;
  else if (!info.ok) body = <p class="setting-help setting-note warn">{info.error || 'Could not list the models.'}</p>;
  else {
    const job = info.job;
    const running = !!(job && job.ok === null);
    const models = info.models || [];
    const missing = models.filter((m) => !m.present && m.tier !== 'optional');
    body = (
      <>
        <div class="setting-actions">
          <button type="button" class="btn sm active" disabled={running || !missing.length} onClick={() => download(missing.map((m) => m.id))}>
            {missing.length ? `Download what the show needs (${megabytes(missing.reduce((n, m) => n + m.size, 0))})` : 'Everything the show needs is here'}
          </button>
          <button type="button" class="btn sm" disabled={running} onClick={() => load(true)}>Check again</button>
        </div>
        <ul class="models-list">
          {models.map((model) => {
            const progress = job && job.models ? job.models[model.id] : null;
            let status;
            if (progress && progress.state === 'downloading') {
              const share = progress.total ? Math.min(1, progress.bytes / progress.total) : 0;
              status = <>
                <div class="warm-bar" role="progressbar" aria-label={`Downloading ${model.name}`} aria-valuemin={0} aria-valuemax={100}
                  aria-valuenow={Math.round(share * 100)}><div class="warm-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} /></div>
                <span class="setting-help">{progress.total ? `${megabytes(progress.bytes)} of ${megabytes(progress.total)}` : `${megabytes(progress.bytes)} so far`}</span>
              </>;
            } else if (progress && progress.state === 'queued' && running) {
              status = <span class="setting-help">Waiting its turn</span>;
            } else if (progress && progress.state === 'error') {
              status = <span class="setting-help setting-note warn">Failed: {progress.message}</span>;
            } else if (model.present) {
              status = <span class="setting-help models-here">Downloaded</span>;
            } else {
              status = <button type="button" class="btn sm" disabled={running} onClick={() => download([model.id])}>Download</button>;
            }
            return (
              <li key={model.id} class={`models-row ${model.present ? 'present' : ''}`}>
                <div class="models-head">
                  <strong>{model.name}</strong>
                  <span class={`setting-badge models-tier ${model.tier}`}>{model.tier}</span>
                  <span class="models-size">{megabytes(model.size)}</span>
                </div>
                <p class="setting-help">{model.purpose}{model.note ? ` ${model.note}` : ''}</p>
                <p class="setting-help">Licence: {model.license}</p>
                <div class="models-status">{status}</div>
              </li>
            );
          })}
        </ul>
        {job && job.ok === false && job.error && <p class="setting-help setting-note warn">The last download failed: {job.error}</p>}
        {info.root && <p class="setting-help">Kept in {info.root}.</p>}
      </>
    );
  }
  return (
    <section class="panel" aria-labelledby="models-title">
      <header class="panel-head"><h2 class="panel-title" id="models-title">Analysis models</h2></header>
      <p class="section-desc">Fetched here, before the show, never by the analysis itself. The analyser restarts to pick up
        what was downloaded.</p>
      {body}
    </section>
  );
}
