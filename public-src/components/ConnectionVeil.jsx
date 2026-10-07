import { connectionSig } from '../state.js';

// Let auth.js handle unauthorized connections so the veil cannot cover its token prompt.
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
