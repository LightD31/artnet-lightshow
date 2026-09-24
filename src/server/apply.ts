import { state, setDefaultUniverse } from './state.ts';
import { settings } from './settings.ts';
import * as output from './output.ts';
import { generateCid } from './sacn.ts';
import * as pythonEnv from '../python-env.ts';
import { messageOf } from '../errors.ts';

/** The subsystems settings are pushed into. */
export interface ApplierDeps {
  midi: {
    close(): void;
    connect(input: string | null, output: string | null): boolean;
    setControlFeedback(on: boolean): void;
  };
  spotify: {
    localCallbackUrl: string;
    setLoopbackPort(port: number): void;
    configure(config: { clientId: string; clientSecret: string; proxyBase: string }): void;
  };
  smtc: { start(): void; stop(): void };
  live?: { start(options: { source: 'loopback' | 'input'; device?: string; latencyMs?: number }): void; stop(): void } | null;
  midiClock?: { setPort(port: string): void } | null;
  deezer: { init(arl: string): Promise<unknown> };
  autoShow?: { restartWorker?(reason: string): void } | null;
  applyPatch(patch: unknown): unknown;
  broadcast(): void;
}

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
function createApplier({ midi, spotify, smtc, live = null, midiClock = null, deezer, autoShow, applyPatch, broadcast }: ApplierDeps) {
  // What this process actually booted with, for pending-restart detection.
  const bootValues = {
    server: {
      host: settings.get('server.host'),
      port: settings.get('server.port'),
      token: settings.get('server.token'),
    },
    engine: {
      thread: settings.get('engine.thread'),
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
      console.warn(`[sacn] could not store a component id: ${messageOf(err)} — using a temporary one`);
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

  /**
   * Push the Hue configuration at the output layer, which owns the session.
   *
   * No connecting happens here: the module brings the session up from the first
   * rendered frame and retries on its own schedule. Saving settings with a
   * bridge that is switched off should not block the settings page.
   */
  function applyHue() {
    const config = settings.group('hue');
    output.configureHue(config);
    // A pairing made before the application id was fetched at pair time has to
    // resolve it on the first connect. Store it when that happens so the next
    // start does not ask the bridge again.
    output.onHueApplicationId((applicationId) => {
      if (settings.get('hue.applicationId') === applicationId) return;
      try {
        settings.update({ hue: { applicationId } });
      } catch (err) {
        console.warn(`[hue] could not store the application id: ${messageOf(err)}`);
      }
    });
    if (!config.enabled) return;
    if (!config.host || !config.username || !config.clientKey || !config.entertainmentId) {
      console.warn('[hue] output is on but the bridge is not fully set up yet — '
        + 'pair with it and pick an entertainment area in Settings → Philips Hue.');
      return;
    }
    console.log(`[hue] output enabled → ${config.host}, area ${config.entertainmentId}, `
      + `${config.channels.length} channel${config.channels.length === 1 ? '' : 's'} bound`);
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

  function applyLive() {
    if (!live) return;
    const config = settings.group('live');
    if (config.enabled) live.start({ source: config.source, device: config.device, latencyMs: config.latencyMs });
    else live.stop();
    broadcast();
  }

  function applyMidiClock() {
    if (midiClock) midiClock.setPort(settings.get('midi.clockOutput'));
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

  function applySeparator() {
    console.log(`[analysis] separator is now ${settings.get('analysis.separator')}`);
    if (autoShow && autoShow.restartWorker) autoShow.restartWorker('separator changed');
  }

  function applyStructureModel() {
    console.log(`[analysis] structure model is now ${settings.get('analysis.structureModel')}`);
    if (autoShow && autoShow.restartWorker) autoShow.restartWorker('structure model changed');
  }

  function applyDeezer() {
    const arl = settings.get('deezer.arl');
    if (!arl) return;
    deezer.init(arl).catch((err) => {
      console.warn(`[deezer] Init failed: ${messageOf(err)} — will fall back to yt-dlp`);
    });
  }

  function applySafety() {
    state.flashLimit = !!settings.get('safety.flashLimit');
  }

  // changed key prefix → what to re-apply. Grouped so one save touching three
  // Spotify fields reconfigures the client once.
  const HANDLERS: { match: (key: string) => boolean; run: () => unknown }[] = [
    { match: (k) => k.startsWith('artnet.'), run: applyArtnet },
    { match: (k) => k.startsWith('sacn.'), run: applySacn },
    { match: (k) => k.startsWith('hue.'), run: applyHue },
    // Ports only: toggling feedback must not drop and reopen the port.
    { match: (k) => k === 'midi.input' || k === 'midi.output', run: applyMidi },
    { match: (k) => k === 'midi.controlFeedback', run: applyControlFeedback },
    { match: (k) => k === 'midi.clockOutput', run: applyMidiClock },
    { match: (k) => k === 'sources.smtc', run: applySmtc },
    { match: (k) => k === 'sources.prolink', run: applyProlink },
    { match: (k) => k.startsWith('live.'), run: applyLive },
    { match: (k) => k.startsWith('spotify.') && k !== 'spotify.allowUnverifiedState', run: applySpotify },
    { match: (k) => k === 'server.publicUrl', run: refreshCallbackUrl },
    { match: (k) => k === 'deezer.arl', run: applyDeezer },
    { match: (k) => k === 'analysis.pythonPath', run: applyPython },
    { match: (k) => k === 'analysis.separator', run: applySeparator },
    { match: (k) => k === 'analysis.structureModel', run: applyStructureModel },
    { match: (k) => k === 'safety.flashLimit', run: applySafety },
  ];

  return {
    /** Everything, at boot. */
    applyAll() {
      applyArtnet();
      ensureSacnCid();
      applySacn();
      applyHue();
      applySpotify();
      applyMidi();
      applyMidiClock();
      applySmtc();
      applyLive();
      applyDeezer();
      applySafety();
      if (settings.get('sources.prolink')) applyProlink();
    },

    /** Just what a save touched. */
    applyChanged(changed: string[]) {
      for (const { match, run } of HANDLERS) {
        if (changed.some(match)) {
          try { run(); } catch (err) { console.warn(`[settings] apply failed: ${messageOf(err)}`); }
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

export {
  createApplier,
};
