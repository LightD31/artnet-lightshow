import { connectedSig, stateSig } from '../state.js';

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

function BpmPill({ bpm, running }) {
  return (
    <div class={`stat-pill ${running ? 'live' : ''}`} title="BPM">
      <span class="label">BPM</span>
      <span>{bpm ?? '—'}</span>
    </div>
  );
}

export function Header() {
  const connected = connectedSig.value;
  const s = stateSig.value;
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
        {s.bpm != null && <BpmPill bpm={s.bpm} running={!!s.running} />}
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
        {auto && auto !== 'idle' && (
          <div class="stat-pill" title="Auto show status">
            <span class="label">Auto</span>
            <span>{auto}</span>
          </div>
        )}
        <div class="stat-pill" title={connected ? 'Connected' : 'Disconnected'}>
          <div class={`status-dot ${connected ? 'connected' : ''}`} />
          <span>{connected ? 'Online' : 'Offline'}</span>
        </div>
      </div>
    </header>
  );
}
