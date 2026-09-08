'use strict';

const { state, setDefaultUniverse } = require('./state');
const { settings } = require('./settings');
const output = require('./output');
const { generateCid } = require('./sacn');
const pythonEnv = require('../python-env');

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
function createApplier({ midi, spotify, smtc, deezer, autoShow, applyPatch, broadcast }) {
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
    // Without a proxy the redirect has to be the loopback literal on the port
    // we are actually listening on, whatever `server.host` or `publicUrl` say —
    // that is the only http:// form Spotify accepts.
    spotify.setLoopbackPort(bootValues.server.port);
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
    const { universe, ...rest } = settings.group('artnet');
    Object.assign(state.artnet, rest);
    // Same rule as the Art-Net panel: fixtures on the old default universe
    // follow it, ones deliberately patched elsewhere stay put.
    setDefaultUniverse(universe);
  }

  /**
   * A receiver tells sACN sources apart by their CID, so ours has to survive a
   * restart: a fresh one every boot reads as a second source arriving and
   * starts the console arbitrating between two of us. Mint one on first use and
   * store it.
   */
  function ensureSacnCid() {
    if (settings.get('sacn.cid')) return;
    try {
      settings.update({ sacn: { cid: generateCid() } });
    } catch (err) {
      console.warn(`[sacn] could not store a component id: ${err.message} — using a temporary one`);
    }
  }

  function applySacn() {
    const config = settings.group('sacn');
    output.configureSacn(config);
    if (config.enabled) {
      const where = config.host || 'multicast';
      console.log(`[sacn] output enabled → ${where}, priority ${config.priority}, `
        + `universe offset ${config.universeOffset >= 0 ? '+' : ''}${config.universeOffset}`);
    }
  }

  function applyControlFeedback() {
    midi.setControlFeedback(settings.get('midi.controlFeedback'));
  }

  function applyMidi() {
    midi.close();
    // Set before connecting: connect() pushes the current show to the surface,
    // and it should already know whether it is allowed to.
    midi.setControlFeedback(settings.get('midi.controlFeedback'));
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

  /**
   * The interpreter is cached (probing three Pythons is not free) and the
   * running worker process *is* the old one, so a change needs both a
   * re-resolve and a recycle.
   */
  function applyPython() {
    pythonEnv._reset();
    const info = pythonEnv.resolve();
    console.log(`[python] interpreter is now ${pythonEnv.describe()}`);
    pythonEnv.warnIfUnusable();
    if (autoShow && autoShow.restartWorker) autoShow.restartWorker('interpreter changed');
    return info;
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
    { match: (k) => k.startsWith('sacn.'), run: applySacn },
    // Ports only: toggling feedback must not drop and reopen the port.
    { match: (k) => k === 'midi.input' || k === 'midi.output', run: applyMidi },
    { match: (k) => k === 'midi.controlFeedback', run: applyControlFeedback },
    { match: (k) => k === 'sources.smtc', run: applySmtc },
    { match: (k) => k === 'sources.prolink', run: applyProlink },
    { match: (k) => k.startsWith('spotify.') && k !== 'spotify.allowUnverifiedState', run: applySpotify },
    { match: (k) => k === 'server.publicUrl', run: refreshCallbackUrl },
    { match: (k) => k === 'deezer.arl', run: applyDeezer },
    { match: (k) => k === 'analysis.pythonPath', run: applyPython },
  ];

  return {
    /** Everything, at boot. */
    applyAll() {
      applyArtnet();
      ensureSacnCid();
      applySacn();
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
