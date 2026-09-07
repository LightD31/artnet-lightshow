import { signal } from '@preact/signals';
import { io } from 'socket.io-client';

// Single source of truth on the client. Mirrors the server's getClientState()
// snapshot; components read from it via the signal.
export const stateSig = signal({});
export const connectedSig = signal(false);

// Auto-show playback position (pushed from server at ~10 Hz). Held in its own
// signal so the timeline visualiser can re-render without churning the rest.
export const autoPositionSig = signal({ positionMs: 0, running: false, updatedAt: 0 });

// Auto-show timeline payload (loaded on demand from /api/auto/timeline).
export const autoTimelineSig = signal({ data: null, fetchedKey: null });

// Token comes from public/auth.js, which runs before this bundle.
export const socket = io({
  transports: ['websocket', 'polling'],
  auth: { token: (typeof window !== 'undefined' && window.LIGHTSHOW_TOKEN) || '' },
});

socket.on('connect',    () => { connectedSig.value = true;  });
socket.on('disconnect', () => { connectedSig.value = false; });
socket.on('state',      (s) => { stateSig.value = s; });
socket.on('auto-position', ({ positionMs, running }) => {
  autoPositionSig.value = { positionMs, running: !!running, updatedAt: performance.now() };
});

export function send(patch) { socket.emit('set', patch); }
export function emitOverride(id, override) { socket.emit('override', { id, override }); }
export function emitFixture(payload) { socket.emit('fixture', payload); }
export function emitTap() { socket.emit('tap'); }
