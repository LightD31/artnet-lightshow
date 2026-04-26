import { connectedSig } from '../state.js';

export function Header() {
  const connected = connectedSig.value;
  return (
    <header>
      <h1>ArtNet <span>Lightshow</span></h1>
      <nav class="header-nav">
        <a href="/" class="nav-link active">Live</a>
        <a href="/settings.html" class="nav-link">Settings</a>
      </nav>
      <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
        {connected ? 'Connected' : 'Connecting…'}
      </span>
      <div class={`status-dot ${connected ? 'connected' : ''}`} />
    </header>
  );
}
