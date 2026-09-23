import { state, getClientState, getFixture, countUniverses, universeOf } from './state.ts';
import { applyPatch, applyOverride, processTap } from './patch.ts';
import { overrideMessageSchema, fixtureMessageSchema, validate } from './validation.ts';
import { listProfiles, getProfile, universeOverflow, unitCapOverflow } from './profiles.ts';
import { showStore } from './show-store.ts';
import { MAX_UNIVERSES } from './universes.ts';
import { connectMidi } from './midi-connect.ts';
import { midiMap } from './midi-map.ts';
import { EnergyHold } from './energy-hold.ts';
import { ENERGY_EFFECTS } from './presets.ts';
import { messageOf } from '../errors.ts';
import type { Server } from 'socket.io';
import type { MidiPorts } from './midi-connect.ts';

/** A browser holding an energy effect down. */
interface EnergyHoldMessage {
  action?: unknown;
  token?: unknown;
  effect?: unknown;
}

function attachSockets(io: Server, { midi, integrations }: {
  midi: MidiPorts & { onLearn(fn: (event: unknown) => void): void };
  integrations: { broadcast(): void };
}): void {
  const holds = new EnergyHold((effect) => {
    state.heldEnergy = effect;
    integrations.broadcast();
  });
  // Learn is a whole-server mode, not a per-socket one: whoever armed it needs
  // to see the capture, and every other open settings page needs to stop
  // showing a stale map. Both go to everyone.
  midi.onLearn((event) => io.emit('midi-learn', event));
  midiMap.onChange(() => io.emit('midi-map', midiMap.snapshot()));

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.emit('state', getClientState());

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
        const { id, address, universe, label, profileId, maxBrightness, position, group, geometry } = validate(fixtureMessageSchema, payload, 'fixture-msg');
        const fixture = getFixture(id);
        if (!fixture) return;

        const profiles = listProfiles();
        const nextProfileId = (profileId !== undefined && profiles[profileId])
          ? profileId : fixture.profileId;
        const nextAddress = address !== undefined ? address : fixture.address;
        const nextUniverse = universe !== undefined ? universe : universeOf(fixture);

        // A fixture has to fit inside its universe. Past channel 512 the writes
        // land outside the DMX buffer and Node drops them silently, leaving the
        // fixture half-controllable with no error. A strip longer than a
        // universe runs on into the next, from channel 1.
        const overflow = universeOverflow(label ?? fixture.label, nextAddress, getProfile({ profileId: nextProfileId }), nextUniverse);
        if (overflow) {
          socket.emit('error-msg', { source: 'fixture', message: overflow });
          return;
        }

        // Each universe is another stream going out at the render rate, so the
        // patch may not spread across more of them than the engine transmits.
        const proposed = state.fixtures.map((f) => (f.id === id ? { ...f, universe: nextUniverse, profileId: nextProfileId } : f));
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
        if (label !== undefined) fixture.label = label;
        // A trim, not part of the patch: it needs none of the universe or
        // address checks above, but it rides the same message so dragging the
        // slider does not need a second channel.
        if (maxBrightness !== undefined) fixture.maxBrightness = maxBrightness;
        if (position !== undefined) fixture.position = position;
        if (group !== undefined) fixture.group = group;
        if (geometry !== undefined) fixture.geometry = geometry;
        showStore.scheduleSave();
        integrations.broadcast();
      } catch (err) {
        socket.emit('error-msg', { source: 'fixture', message: messageOf(err) });
      }
    });

    socket.on('tap', processTap);

    socket.on('energy-hold', (payload: EnergyHoldMessage | null) => {
      if (!payload || typeof payload.token !== 'string' || !payload.token.length || payload.token.length > 64) return;
      const { action, token, effect } = payload;
      if (action === 'press' && ENERGY_EFFECTS.some((e) => e.id === effect)) {
        holds.press(socket.id, token, effect as string);
      } else if (action === 'renew') holds.renew(socket.id, token);
      else if (action === 'release') holds.release(socket.id, token);
    });

    socket.on('midi-connect', (payload) => {
      try {
        socket.emit('midi-status', connectMidi(midi, payload));
      } catch (err) {
        socket.emit('error-msg', { source: 'midi-connect', message: messageOf(err) });
      }
    });

    socket.on('disconnect', () => {
      holds.disconnect(socket.id);
      console.log('Client disconnected:', socket.id);
    });
  });
}

export {
  attachSockets,
};
