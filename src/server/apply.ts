import { state, setDefaultUniverse, voices as liveVoices } from './state.ts';
import { settings } from './settings.ts';
import * as output from './output.ts';
import { generateCid } from './sacn.ts';
import * as pythonEnv from '../python-env.ts';
import { messageOf } from '../errors.ts';

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
  deezer: { init(arl: string): Promise<unknown>; canDecrypt?(): boolean };
  autoShow?: { restartWorker?(reason: string): void } | null;
  applyPatch(patch: unknown): unknown;
  broadcast(): void;
  voices?: { stopAll(): number };
}

function createApplier({ midi, spotify, smtc, live = null, midiClock = null, deezer, autoShow, applyPatch, broadcast, voices = liveVoices }: ApplierDeps) {
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

  function refreshCallbackUrl() {
    const configured = settings.get('server.publicUrl');
    const host = bootValues.server.host;
    const shown = (host === '0.0.0.0' || host === '::') ? 'localhost' : host;
    const base = configured
      ? configured.replace(/\/+$/, '')
      : `http://${shown}:${bootValues.server.port}`;
    spotify.localCallbackUrl = `${base}/auth/spotify/callback`;
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
    setDefaultUniverse(universe);
  }

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

  function applyHue() {
    const config = settings.group('hue');
    output.configureHue(config);
    output.onHueApplicationId((bridgeId, applicationId) => {
      const bridges = settings.group('hue').bridges;
      const bridge = bridges.find((b) => b.id === bridgeId);
      if (!bridge || bridge.applicationId === applicationId) return;
      try {
        settings.update({ hue: { bridges: bridges.map((b) => (b.id === bridgeId ? { ...b, applicationId } : b)) } });
      } catch (err) {
        console.warn(`[hue] could not store the application id of ${bridge.label || bridgeId}: ${messageOf(err)}`);
      }
    });
    for (const bridge of config.bridges) {
      if (!bridge.enabled) continue;
      const name = bridge.label || bridge.id;
      if (!bridge.host || !bridge.username || !bridge.clientKey || !bridge.entertainmentId) {
        console.warn(`[hue] ${name}: output is on but the bridge is not fully set up yet — `
          + 'pair with it and pick an entertainment area in Rig → Outputs → Philips Hue.');
        continue;
      }
      console.log(`[hue] ${name}: output enabled → ${bridge.host}, area ${bridge.entertainmentId}`);
    }
  }

  function applyControlFeedback() {
    midi.setControlFeedback(settings.get('midi.controlFeedback'));
  }

  function applyMidi() {
    midi.close();
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

  function applyClock() {
    const tempoMode = settings.get('clock.tempoMode');
    if (tempoMode !== state.tempoMode) applyPatch({ tempoMode });
  }

  function applyProlink() {
    applyPatch({ prolinkEnabled: settings.get('sources.prolink') });
  }

  // Invalidate the interpreter probe and recycle its worker so both adopt a changed Python setting.
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

  function applyGpuMemory() {
    console.log(`[analysis] GPU memory is now ${settings.get('analysis.gpuMemory')}`);
    if (autoShow && autoShow.restartWorker) autoShow.restartWorker('GPU memory changed');
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

  // Start disarmed and clear voices on disarm so restarts or later arming cannot revive a strobe.
  function applyOutputs({ boot = false } = {}) {
    let wanted = !!settings.get('outputs.armed');
    if (boot) {
      if (wanted) {
        try { settings.update({ outputs: { armed: false } }); }
        catch (err) { console.warn(`[outputs] could not store the disarmed state: ${messageOf(err)}`); }
        wanted = false;
      }
      console.log('[outputs] disarmed at start: nothing goes out to the rig until the outputs are armed '
        + '(Perform, Settings → Show, or POST /api/outputs/arm)');
    }
    if (!output.setArmed(wanted)) return;
    if (wanted) {
      console.log('[outputs] armed: frames go out to the rig');
      return;
    }
    console.log('[outputs] disarmed: the streams are being ended and the patterns stopped');
    voices.stopAll();
    state.heldEnergy = null;
    applyPatch({ running: false, energyOverride: null });
  }

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
    { match: (k) => k === 'analysis.gpuMemory', run: applyGpuMemory },
    { match: (k) => k === 'safety.flashLimit', run: applySafety },
    { match: (k) => k === 'clock.tempoMode', run: applyClock },
    { match: (k) => k === 'outputs.armed', run: applyOutputs },
  ];

  return {
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
      applyClock();
      applyOutputs({ boot: true });
      if (settings.get('sources.prolink')) applyProlink();
    },

    applyChanged(changed: string[]) {
      for (const { match, run } of HANDLERS) {
        if (changed.some(match)) {
          try { run(); } catch (err) { console.warn(`[settings] apply failed: ${messageOf(err)}`); }
        }
      }
      broadcast();
    },

    pendingRestart() {
      const pending = settings.pendingRestart(bootValues);
      if (settings.get('deezer.arl') && deezer.canDecrypt && !deezer.canDecrypt()) pending.push('deezer.arl');
      return pending;
    },

    disarmed(): number {
      return voices.stopAll();
    },

    bootValues,
    refreshCallbackUrl,
  };
}

export {
  createApplier,
};
