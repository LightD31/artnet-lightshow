import { useEffect, useState } from 'preact/hooks';
import { stateSig } from '../state.js';
import {
  deezerSig,
  initDeezer,
  loginDeezer,
  logoutDeezer,
  searchDeezer,
  playDeezerTrack,
} from '../deezer-player.js';

export function DeezerPlayer() {
  const s = stateSig.value;
  const dzServer = s.deezer || {};
  const dz = deezerSig.value;

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // Kick off SDK init as soon as the server tells us the appId.
  useEffect(() => {
    if (dzServer.appId) initDeezer(dzServer.appId);
  }, [dzServer.appId]);

  if (!dzServer.appId) {
    return (
      <div class="auto-status-row">
        <div class="status-dot" />
        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
          Deezer not configured (set DEEZER_APP_ID in .env)
        </span>
      </div>
    );
  }

  const dotClass = dz.loggedIn ? 'connected' : '';
  const statusText = !dz.ready
    ? 'Deezer SDK loading…'
    : dz.loggedIn
      ? `Deezer connected${dz.user ? ` as ${dz.user.name}` : ''}`
      : 'Deezer not connected';

  const onSearch = (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    searchDeezer(query.trim())
      .then((tracks) => setResults(tracks))
      .finally(() => setSearching(false));
  };

  return (
    <div class="deezer-panel">
      <div class="auto-status-row">
        <div class={`status-dot ${dotClass}`} />
        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>{statusText}</span>
        {dz.ready && !dz.loggedIn && (
          <button class="btn sm" style={{ marginLeft: 'auto' }} onClick={loginDeezer}>
            Connect
          </button>
        )}
        {dz.loggedIn && (
          <button class="btn sm danger" style={{ marginLeft: 'auto' }} onClick={logoutDeezer}>
            Disconnect
          </button>
        )}
      </div>

      {dz.ready && (
        <form class="deezer-search" onSubmit={onSearch} style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
          <input
            type="text"
            value={query}
            onInput={(e) => setQuery(e.target.value)}
            placeholder="Search Deezer for a track…"
            style={{ flex: 1 }}
          />
          <button class="btn sm" type="submit" disabled={searching || !query.trim()}>
            {searching ? '…' : 'Search'}
          </button>
        </form>
      )}

      {results.length > 0 && (
        <ul class="deezer-results" style={{ listStyle: 'none', padding: 0, margin: '6px 0 0', maxHeight: '180px', overflowY: 'auto' }}>
          {results.map((t) => (
            <li
              key={t.id}
              onClick={() => { playDeezerTrack(t.id); setResults([]); setQuery(''); }}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px', cursor: 'pointer', borderBottom: '1px solid var(--border, #222)' }}
            >
              {t.album && t.album.cover_small && (
                <img src={t.album.cover_small} alt="" width="32" height="32" style={{ borderRadius: '2px' }} />
              )}
              <div style={{ flex: 1, minWidth: 0, fontSize: '11px' }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</div>
                <div style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.artist && t.artist.name}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
