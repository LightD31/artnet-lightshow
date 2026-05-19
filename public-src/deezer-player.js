import { signal } from '@preact/signals';
import { socket } from './state.js';

/**
 * Browser-side bridge to Deezer's JS SDK (loaded as a global `DZ` from
 * https://e-cdn-files.dzcdn.net/js/min/dz.js in index.html).
 *
 * Initialises the SDK with the app ID provided by the server, owns the login
 * flow, and forwards playback updates to the server via socket so the
 * server-side DeezerSource can drive the auto-show timeline.
 */

export const deezerSig = signal({
  ready: false,           // SDK initialised
  loggedIn: false,        // user has a valid Deezer session
  user: null,             // { name, id } when logged in
  error: null,
  currentTrack: null,     // { id, title, artist, album, albumArt, durationMs }
});

let pollTimer = null;
let initStarted = false;
let lastSentTrackId = null;
let lastSentIsrc = null;
let isrcCache = new Map(); // trackId → isrc

/**
 * Initialise the Deezer SDK. Safe to call multiple times — no-ops after the
 * first successful init. `appId` must be a Deezer application ID registered
 * at developers.deezer.com with this host added to "Application domain".
 */
export function initDeezer(appId) {
  if (!appId || initStarted) return;
  if (typeof window === 'undefined' || !window.DZ) {
    deezerSig.value = { ...deezerSig.value, error: 'Deezer SDK script not loaded' };
    return;
  }
  initStarted = true;

  const channelUrl = `${window.location.origin}/dz-channel.html`;
  window.DZ.init({
    appId: String(appId),
    channelUrl,
    player: {
      onload: () => {
        deezerSig.value = { ...deezerSig.value, ready: true };
        attachPlayerEvents();
        refreshLoginStatus();
        startPolling();
      },
    },
  });
}

function attachPlayerEvents() {
  const DZ = window.DZ;
  // Fired when the player loads a new track.
  DZ.Event.subscribe('current_track', () => emitPlaybackSnapshot());
  // Position updates fire every 1s while playing.
  DZ.Event.subscribe('player_position', () => emitPlaybackSnapshot());
  DZ.Event.subscribe('player_play', () => emitPlaybackSnapshot());
  DZ.Event.subscribe('player_paused', () => emitPlaybackSnapshot());
}

/**
 * Fallback poller — emits a snapshot every 1s even when the SDK events go
 * quiet, so server-side `authenticated` flag stays fresh while a track plays.
 */
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(emitPlaybackSnapshot, 1000);
}

function refreshLoginStatus() {
  const DZ = window.DZ;
  if (!DZ || !DZ.getLoginStatus) return;
  DZ.getLoginStatus((response) => {
    if (response && response.authResponse && response.userID) {
      DZ.api('/user/me', (user) => {
        deezerSig.value = {
          ...deezerSig.value,
          loggedIn: true,
          user: user ? { id: user.id, name: user.name } : null,
        };
      });
    } else {
      deezerSig.value = { ...deezerSig.value, loggedIn: false, user: null };
    }
  });
}

/** Prompt the user to log in. Requires `basic_access` to read profile. */
export function loginDeezer() {
  const DZ = window.DZ;
  if (!DZ) return;
  DZ.login((response) => {
    if (response && response.authResponse) refreshLoginStatus();
    else deezerSig.value = { ...deezerSig.value, error: 'Deezer login cancelled' };
  }, { perms: 'basic_access,listening_history' });
}

export function logoutDeezer() {
  const DZ = window.DZ;
  if (!DZ) return;
  DZ.logout(() => {
    deezerSig.value = { ...deezerSig.value, loggedIn: false, user: null };
    socket.emit('deezer:disconnect');
  });
}

/** Search Deezer's public catalog. Returns a promise of track objects. */
export function searchDeezer(query) {
  const DZ = window.DZ;
  if (!DZ || !query) return Promise.resolve([]);
  return new Promise((resolve) => {
    DZ.api(`/search?q=${encodeURIComponent(query)}&limit=10`, (data) => {
      resolve((data && data.data) || []);
    });
  });
}

/** Start playback of a Deezer track id. */
export function playDeezerTrack(trackId) {
  const DZ = window.DZ;
  if (!DZ || !trackId) return;
  DZ.player.playTracks([Number(trackId)]);
}

function emitPlaybackSnapshot() {
  const DZ = window.DZ;
  if (!DZ || !DZ.player) return;

  const track = DZ.player.getCurrentTrack && DZ.player.getCurrentTrack();
  if (!track || !track.id) return;

  const positionSec = DZ.player.getCurrentPosition ? DZ.player.getCurrentPosition() : 0;
  const isPlaying = DZ.player.isPlaying ? DZ.player.isPlaying() : false;
  const durationSec = track.duration || (DZ.player.getDuration && DZ.player.getDuration()) || 0;

  const albumArt = track.album
    ? (track.album.cover_big || track.album.cover_medium || track.album.cover || null)
    : null;

  const trackId = String(track.id);

  // Update local mirror for the UI.
  deezerSig.value = {
    ...deezerSig.value,
    currentTrack: {
      id: trackId,
      title: track.title,
      artist: track.artist ? track.artist.name : '',
      album: track.album ? track.album.title : '',
      albumArt,
      durationMs: Math.round(durationSec * 1000),
    },
  };

  // Fetch ISRC on track change (Deezer's player track payload doesn't include
  // it; the /track/<id> endpoint does). Cached per-session.
  let isrc = isrcCache.get(trackId) || null;
  if (!isrc && trackId !== lastSentTrackId) {
    DZ.api(`/track/${trackId}`, (data) => {
      if (data && data.isrc) {
        isrcCache.set(trackId, data.isrc);
        lastSentIsrc = data.isrc;
        socket.emit('deezer:playback', buildPayload(trackId, track, positionSec, isPlaying, durationSec, albumArt, data.isrc));
      }
    });
  }

  lastSentTrackId = trackId;
  socket.emit('deezer:playback', buildPayload(trackId, track, positionSec, isPlaying, durationSec, albumArt, isrc));
}

function buildPayload(trackId, track, positionSec, isPlaying, durationSec, albumArt, isrc) {
  return {
    trackId,
    name: track.title || '',
    artist: track.artist ? track.artist.name : '',
    album: track.album ? track.album.title : '',
    albumArt,
    durationMs: Math.round(durationSec * 1000),
    progressMs: Math.round(positionSec * 1000),
    isPlaying: !!isPlaying,
    isrc: isrc || null,
  };
}
