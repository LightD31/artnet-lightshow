import { useEffect, useState } from 'preact/hooks';
import { autoPositionSig, connectedSig, emitTap, pick, send } from '../state.js';
import { colorToCss, clockSource, fmtTime, formatBpm } from '../utils.js';
import { timelinePosition } from '../timeline-state.js';
import { useDraft } from '../draft.js';
import { useEnergyPads } from '../energy-pad.js';
import { activeQueue } from './Queue.jsx';

/**
 * The view for running a show from a tablet: what a hand needs mid-set, as
 * big as the screen allows, and nothing that needs reading twice.
 *
 *   now / next   the track playing, how far in, and what comes after it
 *   sync         what the lights are keeping time by, and whether it is well
 *   pads         blackout, the energy effects held under a finger (or
 *                latched), and tap tempo
 *   palettes     one tap writes the whole look's colours
 *   faders       the master and how hard the generated show pushes
 *
 * Everything here is also on the other views; this is the same controls laid
 * out for a thumb rather than a mouse.
 */

// Short names for the pads: what fits in large type on a phone.
const PAD_LABELS = {
  kill: 'Kill',
  blinder: 'Blinder',
  'white-strobe': 'Strobe',
  'color-strobe': 'Colour strobe',
  'uv-wash': 'UV',
  glow: 'Glow',
};
const PAD_ORDER = ['kill', 'blinder', 'white-strobe', 'color-strobe', 'uv-wash', 'glow'];

const SOURCE_LABELS = {
  prolink: 'PRO DJ LINK', hybrid: 'Spotify + OS clock', spotify: 'Spotify', deezer: 'Deezer',
  nowplaying: 'OS media', live: 'Live input', timer: 'Timer',
};

const SHOW_TEXT = {
  idle: 'Idle', downloading: 'Downloading', analyzing: 'Analysing', ready: 'Ready', playing: 'Running',
};

const readLatch = () => {
  try { return localStorage.getItem('lightshow.perform.latch') === '1'; } catch { return false; }
};

/** How the source the show follows is doing: 'ok', 'warn', 'off' or 'none'. */
export function sourceHealth(s) {
  const id = s.activeSource;
  const pl = s.prolink || {};
  switch (id) {
    case 'prolink': return pl.connected ? (pl.stale ? 'warn' : 'ok') : 'off';
    case 'spotify': return s.spotify && s.spotify.authenticated ? 'ok' : 'off';
    case 'hybrid': return s.hybrid && s.hybrid.driver === 'nowplaying' ? 'ok' : 'warn';
    case 'deezer': return s.deezer && s.deezer.authenticated ? 'ok' : 'off';
    case 'nowplaying': return s.nowPlaying && s.nowPlaying.authenticated ? 'ok' : 'off';
    case 'live': return s.live && s.live.listening ? 'ok' : 'off';
    default: return 'none';
  }
}

function Progress({ duration }) {
  const pos = autoPositionSig.value;
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!pos.running) return undefined;
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, [pos.running]);
  const at = timelinePosition(pos, now, duration);
  const pct = duration > 0 ? Math.min(100, (at / duration) * 100) : 0;
  return (
    <div class="perform-progress" role="progressbar" aria-label="Track position"
      aria-valuemin={0} aria-valuemax={Math.round(duration / 1000)} aria-valuenow={Math.round(at / 1000)}
      aria-valuetext={`${fmtTime(at)} of ${fmtTime(duration)}`}>
      <div class="perform-progress-fill" style={{ width: `${pct}%` }} />
      <span class="perform-progress-time">{fmtTime(at)} / {fmtTime(duration)}</span>
    </div>
  );
}

function NowNext() {
  const s = pick(['autoShow', 'spotify', 'deezer', 'spotifyPrefetch', 'deezerPrefetch']);
  const as = s.autoShow || {};
  const track = as.track;
  const duration = (track && track.durationMs) || (as.analysis && as.analysis.duration * 1000) || 0;
  const queue = activeQueue(s);
  const next = queue && queue.slots.find((slot) => slot.track);
  return (
    <section class="perform-now" aria-label="Now and next">
      <div class="perform-now-main">
        <span class="perform-kicker">Now</span>
        {track ? (
          <>
            <span class="perform-track">{track.name}</span>
            {track.artist && <span class="perform-artist">{track.artist}</span>}
          </>
        ) : <span class="perform-track muted">Nothing loaded</span>}
        {track && duration > 0 && <Progress duration={duration} />}
      </div>
      <div class="perform-now-next">
        <span class="perform-kicker">Next</span>
        {next ? (
          <>
            <span class="perform-next-name">{next.track.name}</span>
            <span class={`perform-next-state state-${next.status}`}>
              {next.status === 'ready' ? 'show ready' : next.status === 'prefetching' ? 'analysing…' : next.status}
            </span>
          </>
        ) : <span class="perform-next-name muted">—</span>}
      </div>
    </section>
  );
}

function SyncHealth() {
  const s = pick(['bpm', 'clock', 'activeSource', 'autoShow', 'autoSyncOffsetMs', 'prolink', 'spotify',
    'deezer', 'nowPlaying', 'live', 'hybrid']);
  const connected = connectedSig.value;
  const clock = clockSource(s.clock && s.clock.source);
  const health = sourceHealth(s);
  const as = s.autoShow || {};
  const status = as.status || 'idle';
  const offset = s.autoSyncOffsetMs || 0;
  const measured = as.running ? as.autoSyncMs || 0 : 0;
  const chips = [
    { id: 'server', label: 'Server', value: connected ? 'online' : 'offline', state: connected ? 'ok' : 'off' },
    { id: 'clock', label: 'Clock', value: `${clock.label} · ${formatBpm(s.bpm)} BPM`, state: clock.locked ? 'ok' : 'none', title: clock.title },
    { id: 'source', label: 'Following', value: SOURCE_LABELS[s.activeSource] || '—', state: health },
    { id: 'show', label: 'Show', value: as.startPending ? 'Analysing, then starting' : SHOW_TEXT[status] || status, state: status === 'playing' ? 'ok' : as.error ? 'warn' : 'none', title: as.error ? as.error.message : undefined },
    { id: 'offset', label: 'Offset', value: `${offset > 0 ? '+' : ''}${offset} ms${measured ? ` · heard ${measured > 0 ? '+' : ''}${measured} ms` : ''}`, state: 'none' },
  ];
  return (
    <section class="perform-sync" aria-label="Sync health">
      {chips.map((c) => (
        <span key={c.id} class={`perform-chip chip-${c.state}`} title={c.title}>
          <span class="perform-chip-dot" aria-hidden="true" />
          <span class="perform-chip-label">{c.label}</span>
          <span class="perform-chip-value">{c.value}</span>
          {c.state === 'off' && <span class="sr-only">(not working)</span>}
          {c.state === 'warn' && <span class="sr-only">(needs attention)</span>}
        </span>
      ))}
    </section>
  );
}

function Pads() {
  const s = pick(['masterBlackout', 'energyEffects', 'energyOverride']);
  const [latch, setLatch] = useState(readLatch);
  useEffect(() => { try { localStorage.setItem('lightshow.perform.latch', latch ? '1' : '0'); } catch { /* private mode */ } }, [latch]);
  const [held, padProps] = useEnergyPads({ latch });
  const effects = (s.energyEffects || []).slice().sort((a, b) => PAD_ORDER.indexOf(a.id) - PAD_ORDER.indexOf(b.id));
  return (
    <section class="perform-pads" aria-label="Effects">
      <button type="button" class={`perform-pad pad-blackout ${s.masterBlackout ? 'active' : ''}`}
        aria-pressed={!!s.masterBlackout}
        onClick={() => send({ masterBlackout: !s.masterBlackout })}>
        <span class="perform-pad-name">Blackout</span>
        <span class="perform-pad-hint">{s.masterBlackout ? 'on — tap to restore' : 'tap'}</span>
      </button>
      {effects.map((eff) => (
        <button key={eff.id} type="button"
          class={`perform-pad pad-${eff.id} ${held === eff.id || s.energyOverride === eff.id ? 'active' : ''}`}
          title={eff.desc}
          {...padProps(eff.id)}>
          <span class="perform-pad-name">{PAD_LABELS[eff.id] || eff.name}</span>
          <span class="perform-pad-hint">{latch ? (held === eff.id ? 'latched — tap to stop' : 'tap to latch') : 'hold'}</span>
        </button>
      ))}
      <button type="button" class="perform-pad pad-tap" onPointerDown={(e) => { if (e.button === 0) emitTap(); }}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); emitTap(); } }}>
        <span class="perform-pad-name">Tap</span>
        <span class="perform-pad-hint">tempo</span>
      </button>
      <label class="perform-latch">
        <input type="checkbox" checked={latch} onChange={(e) => setLatch(e.target.checked)} />
        <span>Latch effects</span>
      </label>
    </section>
  );
}

function PalettePads() {
  const s = pick(['palettes', 'palette', 'colorPresets']);
  const palettes = s.palettes || [];
  const presets = s.colorPresets || [];
  let size = 4;
  try {
    const saved = parseInt(localStorage.getItem('lightshow.paletteSize'), 10);
    if (saved === 2 || saved === 3) size = saved;
  } catch { /* private mode */ }
  if (!palettes.length) return null;
  const swatch = (i) => {
    const c = presets[i];
    return !c ? '#333' : c.name === 'Blackout' ? '#111' : colorToCss(c);
  };
  return (
    <section class="perform-palettes" aria-label="Palettes">
      {palettes.map((p) => (
        <button key={p.id} type="button" class={`perform-palette ${s.palette === p.id ? 'active' : ''}`}
          aria-pressed={s.palette === p.id}
          onClick={() => send({ palette: p.id, paletteSize: size })}>
          <span class="perform-palette-swatches" aria-hidden="true">
            {((p.colors && p.colors[size]) || []).map((idx, i) => <span key={i} style={{ background: swatch(idx) }} />)}
          </span>
          <span class="perform-palette-name">{p.name}</span>
        </button>
      ))}
    </section>
  );
}

function Faders() {
  const s = pick(['masterDimmer', 'autoShow']);
  const [dim, onDim, commitDim] = useDraft(s.masterDimmer ?? 255, (v) => send({ masterDimmer: v }));
  const [intensity, onIntensity, commitIntensity] = useDraft(s.autoShow ? s.autoShow.intensity ?? 50 : 50, (v) => send({ autoIntensity: v }));
  const dimPct = Math.round((dim / 255) * 100);
  return (
    <section class="perform-faders" aria-label="Faders">
      <label class="perform-fader">
        <span class="perform-fader-label">Master</span>
        <input type="range" min="0" max="255" value={dim} aria-valuetext={`${dimPct} percent`}
          onInput={(e) => onDim(parseInt(e.target.value, 10))} onChange={(e) => commitDim(parseInt(e.target.value, 10))} />
        <span class="perform-fader-value">{dimPct}%</span>
      </label>
      <label class="perform-fader">
        <span class="perform-fader-label">Intensity</span>
        <input type="range" min="0" max="100" value={intensity} aria-valuetext={`${intensity} percent`}
          onInput={(e) => onIntensity(parseInt(e.target.value, 10))} onChange={(e) => commitIntensity(parseInt(e.target.value, 10))} />
        <span class="perform-fader-value">{intensity}</span>
      </label>
    </section>
  );
}

export function Perform() {
  return (
    <div class="perform-view">
      <NowNext />
      <SyncHealth />
      <div class="perform-body">
        <div class="perform-controls">
          <Pads />
          <PalettePads />
        </div>
        <Faders />
      </div>
    </div>
  );
}
