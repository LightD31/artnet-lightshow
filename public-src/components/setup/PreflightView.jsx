import { signal } from '@preact/signals';
import { post } from '../../setup-state.js';

/**
 * The pre-show check: the same checks `npm run preflight` runs, against the
 * live subsystems, so MIDI and the playback sources report what is connected
 * rather than what is merely configured. Everything in this stack degrades
 * quietly on purpose, so the first sign of a broken rig is usually the rig
 * not working — run this before doors open instead.
 *
 * The last report is kept for the page's life, so looking at another view
 * and coming back does not lose it.
 */

export const preflightSig = signal({ running: false, report: null, error: null, at: null });

const GLYPH = { ok: '✓', warn: '!', fail: '✕', info: '·' };
const WORD = { ok: 'Passed', warn: 'Warning', fail: 'Problem', info: 'Note' };

export async function runPreflight() {
  preflightSig.value = { ...preflightSig.value, running: true, error: null };
  const res = await post('/api/preflight', {});
  preflightSig.value = res.ok
    ? { running: false, report: res.report, error: null, at: new Date() }
    : { running: false, report: null, error: res.error || 'The check failed', at: null };
  return res;
}

export function PreflightReport({ report }) {
  const summary = report.ok
    ? report.counts.warn
      ? `Ready, with warnings — ${report.counts.ok} passed, ${report.counts.warn} to look at.`
      : `Ready. ${report.counts.ok} checks passed.`
    : `Not ready — ${report.counts.fail} problem${report.counts.fail === 1 ? '' : 's'} to fix.`;
  return (
    <div class="preflight-results">
      <div class={`preflight-summary ${report.ok ? (report.counts.warn ? 'warn' : 'ok') : 'fail'}`} role="status">{summary}</div>
      <ul class="preflight-list">
        {report.checks.map((check, i) => (
          <li key={i} class={`preflight-row ${check.status}`}>
            <span class="preflight-mark" aria-hidden="true">{GLYPH[check.status] || '?'}</span>
            <span class="sr-only">{WORD[check.status] || check.status}: </span>
            <div class="preflight-body">
              <div class="preflight-label">{check.label}</div>
              <div class="preflight-detail">{check.detail}</div>
              {check.fix && check.status !== 'ok' && check.status !== 'info' && <div class="preflight-fix">{check.fix}</div>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PreflightView() {
  const { running, report, error, at } = preflightSig.value;
  return (
    <div class="setup-view preflight-view">
      <section class="panel" aria-labelledby="preflight-title">
        <header class="panel-head">
          <h2 class="panel-title" id="preflight-title">Pre-show check</h2>
          {at && <span class="panel-tag">Run at {at.toLocaleTimeString()}</span>}
        </header>
        <p class="section-desc">Everything in this stack degrades quietly on purpose, so the first sign of a broken rig is
          usually the rig not working. Run this before doors open instead. Also available as <code>npm run preflight</code>.</p>
        <div class="setting-actions">
          <button type="button" class="btn active" disabled={running} onClick={runPreflight}>{running ? 'Checking…' : report ? 'Check again' : 'Run the check'}</button>
          {running && <span class="import-status" role="status">Polling the network and the tools takes a few seconds…</span>}
        </div>
        {error && <p class="import-status error" role="alert">{error}</p>}
        {report && <PreflightReport report={report} />}
      </section>
    </div>
  );
}
