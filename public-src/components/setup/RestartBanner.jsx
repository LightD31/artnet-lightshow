import { useState } from 'preact/hooks';
import { api } from '../../state.js';
import { settingsSig } from '../../setup-state.js';
import * as SPECS from './specs.js';

// Every setting's label, by its dotted path, to name what is waiting.
const LABELS = Object.fromEntries(Object.values(SPECS)
  .filter((spec) => spec && Array.isArray(spec.fields))
  .flatMap((spec) => spec.fields.map((f) => [f.path, `${spec.title}: ${f.label}`])));

/**
 * Settings saved that only apply when the server starts — the address, the
 * port, the token, the engine's thread, a first Deezer ARL — and a button to
 * restart it now, rather than leaving the operator to find a terminal. The
 * supervisor starts it again (and puts the look back); a server without one
 * says so.
 */
export function RestartBanner() {
  const data = settingsSig.value;
  const pending = (data && data.pendingRestart) || [];
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState(null);
  if (!pending.length) return null;

  const restart = async () => {
    setAsking(false);
    setStatus('Restarting…');
    const res = await api('/api/server/restart', { method: 'POST', body: '{}' });
    setStatus(res.ok ? 'Restarting — the page reconnects when the server is back.' : res.error);
  };

  return (
    <section class="panel restart-banner" aria-labelledby="restart-title">
      <header class="panel-head">
        <h2 class="panel-title" id="restart-title">Waiting on a restart</h2>
      </header>
      <p class="restart-what">Saved, and applied when the server next starts: {pending.map((p) => LABELS[p] || p).join(', ')}.</p>
      {asking ? (
        <div class="restart-confirm">
          <span>The rig blacks out for a few seconds while the server restarts, then the look comes back.</span>
          <button type="button" class="btn sm active" onClick={restart}>Restart the server</button>
          <button type="button" class="btn sm" onClick={() => setAsking(false)}>Cancel</button>
        </div>
      ) : (
        <button type="button" class="btn sm" onClick={() => setAsking(true)}>Restart now</button>
      )}
      {status && <p class="look-note" role="status">{status}</p>}
    </section>
  );
}
