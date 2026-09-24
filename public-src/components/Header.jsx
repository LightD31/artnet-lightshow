import { connectedSig, pick } from '../state.js';
import { formatBpm, clockSource } from '../utils.js';
import { useState } from 'preact/hooks';
import { awakeSig, fullscreenSig, setAwake, toggleFullscreen, canFullscreen } from '../device.js';

// The themes, and what each is for. `system` follows the device's setting.
const THEMES = [
  { id: 'system', label: 'System theme' },
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
  { id: 'red', label: 'Red night' },
];

function readTheme() {
  try {
    const t = localStorage.getItem('lightshow.theme');
    return THEMES.some((x) => x.id === t) ? t : 'system';
  } catch {
    return 'system';
  }
}

/** Theme, keeping the screen awake and filling it: this device's, not the show's. */
function DeviceTools() {
  const [theme, setTheme] = useState(readTheme);
  const awake = awakeSig.value;
  const full = fullscreenSig.value;
  const pickTheme = (t) => {
    setTheme(t);
    try { localStorage.setItem('lightshow.theme', t); } catch { /* private mode */ }
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  };
  return (
    <div class="header-tools" role="group" aria-label="This device">
      <select class="header-theme" aria-label="Theme" value={theme} onChange={(e) => pickTheme(e.target.value)}>
        {THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </select>
      <button type="button" class={`header-tool ${awake ? 'active' : ''}`} aria-pressed={awake}
        title={awake ? 'The screen stays on — tap to let it sleep' : 'Keep the screen on while the show runs'}
        onClick={() => setAwake(!awake)}>
        <span aria-hidden="true">{awake ? '☀' : '☾'}</span>
        <span class="header-tool-label">{awake ? 'Awake' : 'Keep awake'}</span>
      </button>
      {canFullscreen() && (
        <button type="button" class={`header-tool ${full ? 'active' : ''}`} aria-pressed={full}
          title={full ? 'Leave full screen' : 'Full screen'} onClick={toggleFullscreen}>
          <span aria-hidden="true">⛶</span>
          <span class="header-tool-label">{full ? 'Exit full screen' : 'Full screen'}</span>
        </button>
      )}
    </div>
  );
}

function MasterPill({ master, blackout }) {
  if (blackout) return null;
  const pct = Math.round(((master ?? 255) / 255) * 100);
  return (
    <div class="stat-pill" title="Master dimmer">
      <span class="label">Master</span>
      <span>{pct}%</span>
    </div>
  );
}

function BpmPill({ bpm, running, source }) {
  const clock = clockSource(source);
  return (
    <div class={`stat-pill ${running ? 'live' : ''}`} title={`BPM · ${clock.label}: ${clock.title}`}>
      <span class="label">BPM</span>
      <span>{formatBpm(bpm)}</span>
    </div>
  );
}

export function Header() {
  const connected = connectedSig.value;
  const s = pick(['bpm', 'clock', 'running', 'masterDimmer', 'masterBlackout', 'energyOverride', 'flashLimit', 'autoShow']);
  const blackout = !!s.masterBlackout;
  const energy = s.energyOverride;
  const auto = s.autoShow && s.autoShow.status;

  return (
    <header>
      <h1>ArtNet <span>Lightshow</span></h1>
      <nav class="header-nav">
        <a href="/" class="nav-link active">Live</a>
        <a href="/settings.html" class="nav-link">Settings</a>
      </nav>

      <div class="header-stats">
        {s.bpm != null && <BpmPill bpm={s.bpm} running={!!s.running} source={s.clock && s.clock.source} />}
        {!blackout && <MasterPill master={s.masterDimmer} blackout={blackout} />}
        {blackout && (
          <div class="stat-pill alert" title="Master blackout active">
            <span class="label">Blackout</span>
            <span>ON</span>
          </div>
        )}
        {energy && (
          <div class="stat-pill energy" title={`Energy override: ${energy}`}>
            <span class="label">Energy</span>
            <span>{energy.replace(/-/g, ' ')}</span>
          </div>
        )}
        {s.flashLimit && (
          <div class="stat-pill" title="Flash limit: at most three large-area flashes a second (Settings → Show)">
            <span class="label">Flash</span>
            <span>≤ 3/s</span>
          </div>
        )}
        {auto && auto !== 'idle' && (
          <div class="stat-pill" title="Auto show status">
            <span class="label">Auto</span>
            <span>{auto}</span>
          </div>
        )}
        <div class="stat-pill conn" title={connected ? 'Connected' : 'Disconnected'}>
          <div class={`status-dot ${connected ? 'connected' : ''}`} />
          <span>{connected ? 'Online' : 'Offline'}</span>
        </div>
      </div>
      <DeviceTools />
    </header>
  );
}
