import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, autoPositionSig, connectedSig, emitTap, followMusic, librarySig, pick, send } from '../state.js';
import { colorToCss, clockSource, fmtTime, formatBpm } from '../utils.js';
import { timelinePosition } from '../timeline-state.js';
import { useDraft } from '../draft.js';
import { NowPlaying, PlayingVoices } from './NowPlaying.jsx';
import { Pads } from './Pads.jsx';
import { StrobePad } from './StrobePad.jsx';
import { activeQueue } from './Queue.jsx';
import { isRandom, paletteName } from './PaletteEditor.jsx';
import { Transport } from './Transport.jsx';
import { Matrix } from './Matrix.jsx';
import { SubTabs, SubPanel, useSubTab } from './setup/SubTabs.jsx';
import { AudioMeters } from './AudioMeters.jsx';
import { StrobesOff } from './Photosensitivity.jsx';

/**
 * The view for running a show from a tablet: what a hand needs mid-set, as
 * big as the screen allows, and nothing that needs reading twice.
 *
 *   outputs      armed or not: whether anything leaves the machine at all
 *   strobes      off until the photosensitivity acknowledgement, one tap from it
 *   now / next   the track playing, how far in, and what comes after it
 *   sync         what the lights are keeping time by, and whether it is well
 *   pads         two banks of eight, each played as its launch mode says,
 *                the strobe held, blackout, tap tempo and stop all voices
 *   palettes     one tap writes the whole look's colours
 *   faders       the master and how hard the generated show pushes
 *
 * Everything here is also on the other views; this is the same controls laid
 * out for a thumb rather than a mouse.
 */

const SOURCE_LABELS = {
  prolink: 'PRO DJ LINK', hybrid: 'Spotify + OS clock', spotify: 'Spotify', deezer: 'Deezer',
  nowplaying: 'OS media', live: 'Live input', timer: 'Timer',
};

const SHOW_TEXT = {
  idle: 'Idle', downloading: 'Downloading', analyzing: 'Analysing', ready: 'Ready', playing: 'Running',
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

/**
 * The outputs' switch. Disarmed, the show renders for the preview and the
 * stage view but nothing leaves the machine: the WLEDs and the Hue lamps are
 * the house's again. The server starts disarmed; a party arms it here.
 */
function ArmSwitch() {
  const s = pick(['armed']);
  const armed = !!s.armed;
  return (
    <section class="perform-arm" aria-label="Outputs">
      <button type="button" class={`perform-arm-switch${armed ? ' armed' : ''}`} role="switch" aria-checked={armed}
        onClick={() => api(armed ? '/api/outputs/disarm' : '/api/outputs/arm', { method: 'POST' })}>
        <span class="perform-arm-state">{armed ? 'Armed' : 'Disarmed'}</span>
        <span class="perform-arm-hint">{armed ? 'frames go out to the rig — tap to disarm' : 'nothing goes out to the rig — tap to arm'}</span>
      </button>
    </section>
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
        <div class="perform-playing"><NowPlaying /></div>
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
  const byHand = !!(s.clock && s.clock.byHand);
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
        <Fragment key={c.id}>
          <span class={`perform-chip chip-${c.state}`} title={c.title}>
            <span class="perform-chip-dot" aria-hidden="true" />
            <span class="perform-chip-label">{c.label}</span>
            <span class="perform-chip-value">{c.value}</span>
            {c.state === 'off' && <span class="sr-only">(not working)</span>}
            {c.state === 'warn' && <span class="sr-only">(needs attention)</span>}
          </span>
          {c.id === 'clock' && byHand && (
            <button type="button" class="perform-follow" onClick={followMusic}
              title="The tempo is held by hand: follow the deck, the song or the live beat again">Follow the music</button>
          )}
        </Fragment>
      ))}
    </section>
  );
}

/** Every voice off, hidden and waiting ones too (DELETE /api/voices); the look and the patterns play on. */
export const stopAllVoices = () => api('/api/voices', { method: 'DELETE' });

function Utility() {
  const s = pick(['masterBlackout']);
  return (
    <section class="perform-utility" aria-label="Blackout, tap and stop all voices">
      <button type="button" class={`perform-pad pad-blackout ${s.masterBlackout ? 'active' : ''}`}
        aria-pressed={!!s.masterBlackout}
        onClick={() => send({ masterBlackout: !s.masterBlackout })}>
        <span class="perform-pad-name">Blackout</span>
        <span class="perform-pad-hint">{s.masterBlackout ? 'on — tap to restore' : 'tap'}</span>
      </button>
      <button type="button" class="perform-pad pad-tap" onPointerDown={(e) => { if (e.button === 0) emitTap(); }}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); emitTap(); } }}>
        <span class="perform-pad-name">Tap</span>
        <span class="perform-pad-hint">tempo</span>
      </button>
      <button type="button" class="perform-pad pad-stop-voices" onClick={stopAllVoices}>
        <span class="perform-pad-name">Stop all voices</span>
      </button>
    </section>
  );
}

export function PalettePads() {
  const s = pick(['palettes', 'palette', 'colorPresets', 'pattern', 'paletteOverride']);
  const lib = librarySig.value;
  const base = [...(lib.builtin || []), ...(lib.user || [])].find((p) => p.id === s.pattern);
  const reason = s.paletteOverride?.length ? 'Palette override controls the effect colours.'
    : base?.spec?.palette?.length ? 'The base effect uses its own palette. Use Palette override to recolour it.' : null;
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
    <section class="perform-palettes" aria-label="Look palettes">
      {reason && <p class="muted" role="status" style={{ gridColumn: '1 / -1' }}>{reason}</p>}
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

/** What PUT /api/palette-override takes for a palette: its id, rolled on the server. */
export const overrideBody = (palette) => ({ paletteId: palette.id });

// Named random palettes cannot be identified from their rolled colours.
export function activeOverride(override, palettes, id = null) {
  if (!override || !override.length) return 'off';
  if (id && palettes.some((p) => p.id === id)) return id;
  const want = override.map((c) => String(c).toUpperCase()).join();
  const hit = palettes.find((p) => !(p.colours || []).some(isRandom)
    && (p.colours || []).map((c) => String(c).toUpperCase()).join() === want);
  return hit ? hit.id : null;
}

/** Light DJ's palette override: one tap puts a palette over every effect, "Off" takes it away. */
export function PaletteOverride() {
  const s = pick(['paletteOverride', 'paletteOverrideId', 'userPalettes']);
  const lib = librarySig.value;
  const builtin = (lib.palettes && lib.palettes.builtin) || [];
  const user = s.userPalettes || (lib.palettes && lib.palettes.user) || [];
  const all = [...builtin, ...user];
  const active = activeOverride(s.paletteOverride, all, s.paletteOverrideId);
  const button = (id, name, colours, onClick) => (
    <button key={id} type="button" class={`override-pad${active === id ? ' active' : ''}`} aria-pressed={active === id}
      data-override={id} onClick={onClick}>
      <span class="override-swatches" aria-hidden="true">
        {colours.map((c, i) => <span key={i} class={isRandom(c) ? 'random' : ''} style={isRandom(c) ? {} : { background: c }} />)}
      </span>
      <span class="override-name">{name}</span>
    </button>
  );
  return (
    <section class="perform-override" aria-label="Palette override">
      {button('off', 'Off', [], () => api('/api/palette-override', { method: 'DELETE' }))}
      {all.map((p) => button(p.id, paletteName(p), active === p.id ? s.paletteOverride : p.colours || [],
        () => api('/api/palette-override', { method: 'PUT', body: JSON.stringify(overrideBody(p)) })))}
      {all.some((p) => p.id === active && p.colours?.some(isRandom))
        && <span class="override-custom">Random colours held — tap again to reroll</span>}
      {active === null && <span class="override-custom">Custom colours on</span>}
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

const INSTRUMENTS = [{ id: 'pads', label: 'Pads' }, { id: 'matrix', label: 'Matrix' }];

export function Perform() {
  const [tab, setTab] = useSubTab('perform', INSTRUMENTS);
  return (
    <div class="perform-view">
      <ArmSwitch />
      <StrobesOff perform />
      <Transport />
      <div class="perform-body">
        <div class="perform-controls">
          <SubTabs view="perform" tabs={INSTRUMENTS} tab={tab} setTab={setTab} label="Instruments" />
          <SubPanel view="perform" tab={tab}>{tab === 'matrix' ? <Matrix /> : <Pads />}</SubPanel>
          <PlayingVoices />
          <div class="perform-live-row">
            <StrobePad />
            <Utility />
          </div>
          <PaletteOverride />
          <PalettePads />
        </div>
        <div class="perform-side">
          <Faders />
          <AudioMeters />
        </div>
      </div>
      <section class="perform-music" aria-label="Music and sync">
        <NowNext />
        <SyncHealth />
      </section>
    </div>
  );
}
