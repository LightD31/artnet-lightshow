'use strict';

const { state } = require('./state');
const { settings } = require('./settings');

/**
 * Push stored settings into the running subsystems.
 *
 * Most settings take effect the moment they are saved; the handful that are
 * read before anything is listening (bind host, port, access token) are
 * reported as pending-restart instead. Keys not listed here — the analysis
 * timeouts, the local-file root, the Spotify unverified-state flag — are read
 * from the store at call time by the code that uses them, so they need no
 * action at all.
 */
function createApplier({ midi, spotify, smtc, deezer, applyPatch, broadcast }) {
  // What this process actually booted with, for pending-restart detection.
  const bootValues = {
    server: {
      host: settings.get('server.host'),
      port: settings.get('server.port'),
      token: settings.get('server.token'),
    },
  };

  /** The URL the OAuth proxy sends the operator's browser back to. */
  function refreshCallbackUrl() {
    const configured = settings.get('server.publicUrl');
    const host = bootValues.server.host;
    const shown = (host === '0.0.0.0' || host === '::') ? 'localhost' : host;
    const base = configured
      ? configured.replace(/\/+$/, '')
      : `http://${shown}:${bootValues.server.port}`;
    spotify.localCallbackUrl = `${base}/auth/spotify/callback`;
    return base;
  }

  function applySpotify() {
    spotify.configure({
      clientId: settings.get('spotify.clientId'),
      clientSecret: settings.get('spotify.clientSecret'),
      proxyBase: settings.get('spotify.proxyBase'),
    });
    refreshCallbackUrl();
  }

  function applyArtnet() {
    Object.assign(state.artnet, settings.group('artnet'));
  }

  function applyMidi() {
    midi.close();
    midi.connect(settings.get('midi.input') || null, settings.get('midi.output') || null);
  }

  function applySmtc() {
    if (settings.get('sources.smtc')) smtc.start();
    else smtc.stop();
  }

  function applyProlink() {
    // Routed through applyPatch so the enable/disable hooks and the broadcast
    // fire exactly as they do when the toggle is used on the main page.
    applyPatch({ prolinkEnabled: settings.get('sources.prolink') });
  }

  function applyDeezer() {
    const arl = settings.get('deezer.arl');
    if (!arl) return;
    deezer.init(arl).catch((err) => {
      console.warn(`[deezer] Init failed: ${err.message} — will fall back to yt-dlp`);
    });
  }

  // changed key prefix → what to re-apply. Grouped so one save touching three
  // Spotify fields reconfigures the client once.
  const HANDLERS = [
    { match: (k) => k.startsWith('artnet.'), run: applyArtnet },
    { match: (k) => k.startsWith('midi.'), run: applyMidi },
    { match: (k) => k === 'sources.smtc', run: applySmtc },
    { match: (k) => k === 'sources.prolink', run: applyProlink },
    { match: (k) => k.startsWith('spotify.') && k !== 'spotify.allowUnverifiedState', run: applySpotify },
    { match: (k) => k === 'server.publicUrl', run: refreshCallbackUrl },
    { match: (k) => k === 'deezer.arl', run: applyDeezer },
  ];

  return {
    /** Everything, at boot. */
    applyAll() {
      applyArtnet();
      applySpotify();
      applyMidi();
      applySmtc();
      applyDeezer();
      if (settings.get('sources.prolink')) applyProlink();
    },

    /** Just what a save touched. */
    applyChanged(changed) {
      for (const { match, run } of HANDLERS) {
        if (changed.some(match)) {
          try { run(); } catch (err) { console.warn(`[settings] apply failed: ${err.message}`); }
        }
      }
      broadcast();
    },

    /** Restart-only keys whose stored value differs from the running one. */
    pendingRestart() { return settings.pendingRestart(bootValues); },

    bootValues,
    refreshCallbackUrl,
  };
}

module.exports = { createApplier };
