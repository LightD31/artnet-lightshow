import { state, getClientState, getFixture, countUniverses, universeOf, placeAddresslessFixtures, voices, legacyEnergy, onVoicesChange } from './state.ts';
import { applyPatch, applyOverride, processTap } from './patch.ts';
import { overrideMessageSchema, fixtureMessageSchema, validate } from './validation.ts';
import { listProfiles, getProfile, universeOverflow, unitCapOverflow, HUE_PROFILE_IDS, HUE_BY_HAND } from './profiles.ts';
import { INTERNAL_UNIVERSE, hasNoAddress } from '../shared/placement.ts';
import { showStore } from './show-store.ts';
import { MAX_UNIVERSES } from './universes.ts';
import { connectMidi } from './midi-connect.ts';
import { midiMap } from './midi-map.ts';
import { ENERGY_EFFECTS } from './presets.ts';
import { launchOf, targetsOf } from './voices.ts';
import { padIndex, STROBE_ID } from './pads.ts';
import { presetLookup } from './routes/voices.ts';
import { ddpConflict } from './ddp-routes.ts';
import { HttpError, messageOf } from '../errors.ts';
import { PROTOCOL, ROOM, TOPICS } from './protocol.ts';
import type { Server, Socket } from 'socket.io';
import type { MidiPorts } from './midi-connect.ts';
import type { Publisher, Snapshot } from './protocol.ts';
import type { Pads } from './pads.ts';

/** A browser holding an energy effect down. */
interface EnergyHoldMessage {
  action?: unknown;
  token?: unknown;
  effect?: unknown;
}

/** A browser holding a voice down: an effect, a preset (`effect: { preset }`) or a pad, on the rig or some fixtures. */
interface VoiceHoldMessage extends EnergyHoldMessage {
  pad?: unknown;
  targets?: unknown;
}

/** A hold's token: a short string of the page's own, as the energy hold has always taken. */
const validToken = (token: unknown): token is string => typeof token === 'string' && token.length > 0 && token.length <= 64;

/** The pad a voice-hold message names, `{ bank, slot }`; a 400 for one that is none. */
function padOf(raw: unknown): { bank: number; slot: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'voice-hold: pad is { bank, slot }');
  const { bank, slot } = raw as { bank?: unknown; slot?: unknown };
  padIndex(bank, slot);
  return { bank: bank as number, slot: slot as number };
}

/**
 * What a voice-hold press launches: its effect, given or by preset, for as
 * long as the page renews it. The voice tier, as every effect a client
 * launches: nothing it holds outranks the strobe. A pad plays as its launch
 * says (pads.ts), and the strobe goes through the pads' strobe hook, as the
 * strobe pad does.
 */
function pressVoice(owner: string, token: string, payload: VoiceHoldMessage, lookup: ReturnType<typeof presetLookup>, pads?: Pads): void {
  if (payload.pad !== undefined) {
    if (!pads) throw new HttpError(409, 'No pads on this server');
    const { bank, slot } = padOf(payload.pad);
    pads.press(bank, slot, owner, token);
    return;
  }
  const effect = payload.effect;
  const byPreset = !!effect && typeof effect === 'object' && !Array.isArray(effect) && Object.hasOwn(effect, 'preset');
  if (byPreset && Object.keys(effect as object).length !== 1) throw new HttpError(400, 'voice-hold: effect is a spec or { preset }');
  if (byPreset && pads && (effect as { preset: unknown }).preset === STROBE_ID) {
    pads.holdStrobe(owner, token, payload.targets);
    return;
  }
  const launch = launchOf(byPreset ? { preset: (effect as { preset: unknown }).preset } : { effect }, lookup);
  const targets = targetsOf(payload.targets, state.fixtures.map((f) => f.id));
  voices.start({ spec: launch.spec, targets, mode: 'hold', tier: 'voice', source: 'api', label: launch.label, owner, token });
}

/** A voice-hold release: the hold its token names, through the pad it names, if any. */
function releaseVoice(owner: string, token: string, payload: VoiceHoldMessage, pads?: Pads): void {
  if (!pads) return voices.release(owner, token);
  if (payload.pad === undefined) pads.releaseHold(owner, token);
  else {
    const { bank, slot } = padOf(payload.pad);
    pads.release(bank, slot, owner, token);
  }
  // A hold a stop ended: its token is fresh again (voices.ts).
  voices.release(owner, token);
}

/** What a page asked for when it connected: protocol 2, or the original. */
function protocolOf(socket: Socket): number {
  const auth = socket.handshake.auth as { protocol?: unknown } | undefined;
  return auth && auth.protocol === PROTOCOL ? PROTOCOL : 1;
}

/** The feeds named in a subscribe message that exist, as their rooms. */
function topicRooms(payload: unknown): string[] {
  const names = Array.isArray(payload) ? payload : [payload];
  return names.filter((t): t is keyof typeof TOPICS => typeof t === 'string' && Object.hasOwn(TOPICS, t))
    .map((t) => TOPICS[t]);
}

function attachSockets(io: Server, { midi, integrations }: {
  midi: MidiPorts & { onLearn(fn: (event: unknown) => void): void };
  integrations: { broadcast(): void; publisher: Publisher; library?: Parameters<typeof presetLookup>[0]; pads?: Pads };
}): void {
  const { publisher } = integrations;
  // Every page hears a voice start and end: a press, a release, a lease run
  // out, a stop from REST. Once the change is done, so a launch inside a
  // patch or a frame is not broadcast halfway through it.
  let queued = false;
  onVoicesChange(() => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      integrations.broadcast();
    });
  });
  // Learn is a whole-server mode, not a per-socket one: whoever armed it needs
  // to see the capture, and every other open page needs to stop
  // showing a stale map. Both go to everyone.
  midi.onLearn((event) => io.emit('midi-learn', event));
  midiMap.onChange(() => io.emit('midi-map', midiMap.snapshot()));

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    if (protocolOf(socket) === PROTOCOL) {
      socket.join(ROOM.v2);
      socket.emit('snapshot', publisher.snapshot(getClientState()));
      // A page that finds a gap in a domain's versions asks for the whole
      // state again rather than drifting.
      socket.on('sync', (ack?: (snapshot: Snapshot) => void) => {
        const snapshot = publisher.snapshot(getClientState());
        if (typeof ack === 'function') ack(snapshot);
        else socket.emit('snapshot', snapshot);
      });
      socket.on('subscribe', (payload) => {
        for (const room of topicRooms(payload)) {
          socket.join(room);
          // What the others already have: the feeds only send a change.
          const frame = room === ROOM.dmx ? publisher.lastDmxFrame() : null;
          if (frame) socket.emit('dmx-frame', frame);
          const audio = room === ROOM.audio ? publisher.lastAudio() : undefined;
          if (audio !== undefined) socket.emit('audio', audio);
        }
      });
      socket.on('unsubscribe', (payload) => {
        for (const room of topicRooms(payload)) socket.leave(room);
      });
    } else {
      socket.join(ROOM.v1);
      socket.emit('state', getClientState());
    }

    socket.on('set', (payload) => {
      try { applyPatch(payload); }
      catch (err) { socket.emit('error-msg', { source: 'set', message: messageOf(err) }); }
    });

    socket.on('override', (payload) => {
      try {
        const { id, override } = validate(overrideMessageSchema, payload, 'override-msg');
        applyOverride(id, override);
      } catch (err) {
        socket.emit('error-msg', { source: 'override', message: messageOf(err) });
      }
    });

    socket.on('fixture', (payload) => {
      try {
        const { id, address, universe, label, profileId, maxBrightness, position, group, geometry, output, productId, hardware, admission } = validate(fixtureMessageSchema, payload, 'fixture-msg');
        const fixture = getFixture(id);
        if (!fixture) return;

        const profiles = listProfiles();
        const nextProfileId = (profileId !== undefined && profiles[profileId])
          ? profileId : fixture.profileId;
        const nextProfile = getProfile({ profileId: nextProfileId });
        // A Hue lamp is the bridge's: patched from its entertainment area on
        // the profile for what the lamp can show, and it stays a Hue lamp. No
        // other fixture becomes one, and its output (the channel) is not
        // changed by hand. The schema already refuses a Hue output here.
        const addressless = hasNoAddress(fixture);
        if ((addressless && output !== undefined) || addressless !== HUE_PROFILE_IDS.has(nextProfileId)) {
          socket.emit('error-msg', { source: 'fixture', message: HUE_BY_HAND });
          return;
        }
        const nextOutput = output !== undefined ? output : fixture.output ?? null;
        const nextAddress = address !== undefined ? address : fixture.address;
        const nextUniverse = universe !== undefined ? universe : universeOf(fixture);

        // A fixture has to fit inside its universe. Past channel 512 the writes
        // land outside the DMX buffer and Node drops them silently, leaving the
        // fixture half-controllable with no error. A strip longer than a
        // universe runs on into the next, from channel 1. One with no DMX
        // address is placed by the server, which only needs it to be patchable.
        const overflow = addressless
          ? universeOverflow(label ?? fixture.label, 1, nextProfile, INTERNAL_UNIVERSE)
          : universeOverflow(label ?? fixture.label, nextAddress, nextProfile, nextUniverse);
        if (overflow) {
          socket.emit('error-msg', { source: 'fixture', message: overflow });
          return;
        }

        // Each universe is another stream going out at the render rate, so the
        // patch may not spread across more of them than the engine transmits.
        // Copies throughout: placing the Hue lamps must not touch the live patch
        // until the change is known to be good.
        const proposed = state.fixtures.map((f) => (f.id === id
          ? { ...f, address: nextAddress, universe: nextUniverse, profileId: nextProfileId, output: nextOutput } : { ...f }));
        placeAddresslessFixtures(proposed);
        // A universe that goes to a WLED over DDP goes nowhere else, so nothing
        // else may be patched on it.
        const wled = ddpConflict(proposed, getProfile, universeOf);
        if (wled) {
          socket.emit('error-msg', { source: 'fixture', message: wled });
          return;
        }
        // And a bar's cells are each rendered every frame, so a profile change
        // may not take the patch past the cells the engine renders.
        const tooMany = nextProfileId !== fixture.profileId ? unitCapOverflow(proposed) : null;
        if (tooMany) {
          socket.emit('error-msg', { source: 'fixture', message: tooMany });
          return;
        }
        if (countUniverses(proposed) > MAX_UNIVERSES) {
          socket.emit('error-msg', {
            source: 'fixture',
            message: `Moving "${fixture.label}" to universe ${nextUniverse} would put the `
              + `patch on more than the ${MAX_UNIVERSES} universes this server transmits`,
          });
          return;
        }

        fixture.address = nextAddress;
        fixture.universe = nextUniverse;
        fixture.profileId = nextProfileId;
        fixture.output = nextOutput;
        placeAddresslessFixtures();
        if (label !== undefined) fixture.label = label;
        if (productId !== undefined) fixture.productId = productId;
        if (hardware !== undefined) fixture.hardware = hardware;
        if (admission !== undefined) fixture.admission = admission;
        // A trim, not part of the patch: it needs none of the universe or
        // address checks above, but it rides the same message so dragging the
        // slider does not need a second channel.
        if (maxBrightness !== undefined) fixture.maxBrightness = maxBrightness;
        if (position !== undefined) {
          // Plot moves only send x/y; retain the fixture's height until it is
          // changed explicitly or the operator resets the whole position.
          fixture.position = position && position.height === undefined && fixture.position?.height !== undefined
            ? { ...position, height: fixture.position.height } : position;
        }
        if (group !== undefined) fixture.group = group;
        if (geometry !== undefined) fixture.geometry = geometry;
        showStore.scheduleSave();
        integrations.broadcast();
      } catch (err) {
        socket.emit('error-msg', { source: 'fixture', message: messageOf(err) });
      }
    });

    socket.on('tap', processTap);

    // The energy effects' hold, as Companion and the pages before voices send
    // it: a voice under its energy's id, over the latched one (state.ts). Its
    // lease is the voices': one token names one hold, whichever event pressed it.
    // A press refused (a strobe before the acknowledgement) is told as a voice-hold's is.
    socket.on('energy-hold', (payload: EnergyHoldMessage | null) => {
      if (!payload || !validToken(payload.token)) return;
      const { action, token, effect } = payload;
      try {
        if (action === 'press' && ENERGY_EFFECTS.some((e) => e.id === effect)) {
          legacyEnergy.press(socket.id, token, effect as string);
        } else if (action === 'renew') legacyEnergy.renew(socket.id, token);
        else if (action === 'release') legacyEnergy.release(socket.id, token);
      } catch (err) {
        socket.emit('error-msg', { source: 'energy-hold', token, message: messageOf(err) });
      }
    });

    // Any effect or pad held down: renewed by this page, gone with it. The
    // owner is this socket, never anything the message says. A release goes
    // the way its press went (pads.ts): a pad's to its pad, the strobe's to
    // the strobe.
    socket.on('voice-hold', (payload: VoiceHoldMessage | null) => {
      if (!payload || !validToken(payload.token)) return;
      const { action, token } = payload;
      const { pads } = integrations;
      try {
        if (action === 'press') pressVoice(socket.id, token, payload, presetLookup(integrations.library), pads);
        else if (action === 'renew') voices.renew(socket.id, token);
        else if (action === 'release') releaseVoice(socket.id, token, payload, pads);
      } catch (err) {
        // The token says which press was refused: a page may have a newer one down already.
        socket.emit('error-msg', { source: 'voice-hold', token, message: messageOf(err) });
      }
    });

    socket.on('midi-connect', (payload) => {
      try {
        socket.emit('midi-status', connectMidi(midi, payload));
      } catch (err) {
        socket.emit('error-msg', { source: 'midi-connect', message: messageOf(err) });
      }
    });

    socket.on('disconnect', () => {
      voices.disconnect(socket.id);
      console.log('Client disconnected:', socket.id);
    });
  });
}

export {
  attachSockets,
};
