import { useEffect, useRef, useState } from 'preact/hooks';
import { connectedSig } from '../state.js';

/**
 * The server's log, in the drawer: what it has been saying, newest at the
 * bottom, with how it is doing above it (GET /api/health).
 *
 * Polled while it is open — a second for the log, five for health — from
 * after the last entry it has. A server that has been restarted numbers its
 * entries from one again, and starts with the tail of the run before, read
 * back from its file: that is marked, so what led up to a crash is there to
 * read after one.
 */

const SHOW = [
  ['info', 'Info and up'],
  ['warn', 'Warnings and errors'],
  ['error', 'Errors'],
  ['trace', 'Everything'],
];
const RANK = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const KEEP = 1000;
const STATUS = { ok: 'Healthy', degraded: 'Degraded', failing: 'Failing' };

const clock = (ms) => {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

const uptime = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
  : s >= 60 ? `${Math.floor(s / 60)} min` : `${s} s`);

function Health({ health }) {
  if (!health) return null;
  const sup = health.supervisor || {};
  return (
    <div class={`log-health status-${health.status}`}>
      <strong class="log-health-status">{STATUS[health.status] || health.status}</strong>
      <span>
        up {uptime(health.uptimeS)}
        {sup.supervised ? ` · supervised${sup.restarts ? `, restarted ${sup.restarts}×` : ''}` : ' · not supervised'}
        {health.eventLoop ? ` · main thread p99 ${health.eventLoop.p99Ms} ms` : ''}
      </span>
      {health.problems.length > 0 && (
        <ul class="log-problems">
          {health.problems.map((p) => <li key={p.what} class={`lvl-${p.level}`}>{p.what}</li>)}
        </ul>
      )}
    </div>
  );
}

export function LogView() {
  const connected = connectedSig.value;
  const [entries, setEntries] = useState([]);
  const [level, setLevel] = useState('info');
  const [filter, setFilter] = useState('');
  const [paused, setPaused] = useState(false);
  const [health, setHealth] = useState(null);
  const last = useRef(0);
  const list = useRef(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!connected || paused) return undefined;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const data = await (await fetch(`/api/logs?after=${last.current}&limit=500`)).json();
        if (data.ok && !stopped) {
          if (data.last < last.current) {
            // Started again: its entries count from one, and its first ones are
            // the run before. Read it all again.
            last.current = 0;
            setEntries([]);
          } else if (data.entries.length) {
            last.current = data.last;
            setEntries((prev) => [...prev, ...data.entries].slice(-KEEP));
          }
        }
      } catch { /* offline for a moment: the veil says so */ }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [connected, paused]);

  useEffect(() => {
    if (!connected) return undefined;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        const data = await (await fetch('/api/health')).json();
        if (!stopped && data && data.status) setHealth(data);
      } catch { /* next time */ }
      if (!stopped) timer = setTimeout(poll, 5000);
    };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [connected]);

  // Kept at the newest unless the operator has scrolled up to read.
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries, level, filter]);

  const needle = filter.trim().toLowerCase();
  const shown = entries.filter((e) => RANK[e.level] >= RANK[level]
    && (!needle || `${e.component || ''} ${e.msg}`.toLowerCase().includes(needle)));

  const rows = [];
  shown.forEach((e, i) => {
    const before = shown[i - 1];
    if (e.previous && (!before || !before.previous)) rows.push(<li key="before" class="log-divider">The run before this one</li>);
    if (!e.previous && before && before.previous) rows.push(<li key="now" class="log-divider">This run</li>);
    rows.push(
      <li key={e.seq} class={`log-entry lvl-${e.level}${e.previous ? ' previous' : ''}`}>
        <span class="log-time">{clock(e.time)}</span>
        <span class="log-level">{e.level}</span>
        {e.component && <span class="log-component">{e.component}</span>}
        <span class="log-msg">{e.msg}{e.data ? ` ${JSON.stringify(e.data)}` : ''}</span>
      </li>,
    );
  });

  return (
    <div class="log-view">
      <Health health={health} />
      <div class="log-tools" role="toolbar" aria-label="Log">
        <label class="log-show">
          <span>Show</span>
          <select class="auto-select" value={level} onChange={(e) => setLevel(e.target.value)}>
            {SHOW.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <input type="search" class="auto-select log-filter" placeholder="Filter" aria-label="Filter the log" value={filter}
          onInput={(e) => setFilter(e.target.value)} />
        <button type="button" class={`btn sm ${paused ? 'active' : ''}`} aria-pressed={paused} onClick={() => setPaused(!paused)}>
          {paused ? 'Paused' : 'Pause'}
        </button>
        <span class="log-count">{shown.length} of {entries.length}</span>
      </div>
      <div class="log-list" ref={list} role="log" aria-live="off" aria-label="Server log" tabIndex={0}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        <ol class="log-lines">
          {rows.length ? rows : <li class="log-divider">Nothing logged at this level yet.</li>}
        </ol>
      </div>
    </div>
  );
}
