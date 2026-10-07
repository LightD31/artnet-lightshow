import { connectionSig } from '../state.js';

/**
 * Bars the surface whenever the socket is not live.
 *
 * A dropped socket left every control looking live while doing nothing, so the
 * page covers itself and says the rig is holding its last look. What it says
 * depends on why, because "Reconnecting…" was a lie in two of the three cases:
 * the first load has nothing to reconnect *to* yet, and a handshake the server
 * rejected is never retried at all. That last one is handled by public/auth.js,
 * which asks for the access token — so this renders nothing over it.
 */
export function ConnectionVeil() {
  const { status } = connectionSig.value;
  if (status === 'online' || status === 'unauthorized') return null;

  const connecting = status === 'connecting';

  return (
    <div class="offline-veil" role="alert">
      <div class={`offline-card ${connecting ? 'waiting' : ''}`}>
        <div class="offline-title">{connecting ? 'Connecting' : 'Disconnected'}</div>
        <p class="offline-body">
          {connecting
            ? 'Waiting for the server. Nothing you press here reaches the rig until this clears.'
            : 'Lost the connection to the server. The rig holds its last look; '
              + 'nothing you press here reaches it until this clears.'}
        </p>
        <p class="offline-body dim">{connecting ? 'Trying…' : 'Reconnecting…'}</p>
      </div>
    </div>
  );
}
