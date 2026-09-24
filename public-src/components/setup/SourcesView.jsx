import { pick, api } from '../../state.js';
import { useSettings, liveDevices } from '../../setup-state.js';
import { SettingsSection } from './Section.jsx';
import { SOURCES, LIVE, SPOTIFY, DEEZER, ANALYSIS } from './specs.js';
import { Models } from './Models.jsx';

/**
 * Where the music comes from, and how it is heard: the players the show may
 * follow, the services it reads tracks from, the live input, and the
 * analysis that turns a track into a show.
 */

function SpotifyStatus() {
  const s = pick(['spotify']);
  const sp = s.spotify || {};
  return (
    <div class="source-status">
      <span class={`status-dot ${sp.authenticated ? 'connected' : ''}`} aria-hidden="true" />
      <span>{sp.authenticated ? 'Connected' : sp.configured === false ? 'Enter the client ID and secret, apply, then connect' : 'Not connected'}</span>
      {sp.authenticated
        ? <button type="button" class="btn sm" onClick={() => api('/api/spotify/disconnect', { method: 'POST' })}>Disconnect</button>
        : <button type="button" class="btn sm active" onClick={() => window.open('/auth/spotify', '_blank', 'width=500,height=700')}>Connect Spotify</button>}
    </div>
  );
}

function LiveStatus() {
  const s = pick(['live']);
  const live = s.live;
  if (!live) return null;
  return (
    <div class="source-status">
      <span class={`status-dot ${live.listening ? 'connected' : ''}`} aria-hidden="true" />
      <span>{live.listening ? `Listening${live.device ? ` to ${live.device}` : ''}` : live.error ? `Not listening — ${live.error}` : 'Not listening'}</span>
    </div>
  );
}

export function SourcesView() {
  useSettings();
  const devices = liveDevices.use();
  return (
    <div class="setup-view">
      <div class="setup-columns">
        <div class="setup-col">
          <SettingsSection {...SOURCES} />
          <SettingsSection {...SPOTIFY}><SpotifyStatus /></SettingsSection>
          <SettingsSection {...DEEZER} />
        </div>
        <div class="setup-col">
          <SettingsSection {...LIVE} ctx={{ liveDevices: devices }}><LiveStatus /></SettingsSection>
          <SettingsSection {...ANALYSIS} />
          <Models />
        </div>
      </div>
    </div>
  );
}
