'use strict';

const { state, getClientState, getFixtureCount, countUniverses, universeOf } = require('./state');
const { applyPatch, applyOverride, processTap } = require('./patch');
const {
  overrideMessageSchema,
  fixtureMessageSchema,
  midiConnectSchema,
  validate,
} = require('./validation');
const { listProfiles, getProfile, endChannel, fitsInUniverse, UNIVERSE_SIZE } = require('./profiles');
const { showStore } = require('./show-store');
const { MAX_UNIVERSES } = require('./universes');
const { settings } = require('./settings');
const { midiMap } = require('./midi-map');

function attachSockets(io, { midi, integrations }) {
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
      catch (err) { socket.emit('error-msg', { source: 'set', message: err.message }); }
    });

    socket.on('override', (payload) => {
      try {
        const { id, override } = validate(overrideMessageSchema, payload, 'override-msg');
        applyOverride(id, override);
      } catch (err) {
        socket.emit('error-msg', { source: 'override', message: err.message });
      }
    });

    socket.on('fixture', (payload) => {
      try {
        const { id, address, universe, label, profileId, maxBrightness } = validate(fixtureMessageSchema, payload, 'fixture-msg');
        if (id < 0 || id >= getFixtureCount()) return;

        const profiles = listProfiles();
        const nextProfileId = (profileId !== undefined && profiles[profileId])
          ? profileId : state.fixtures[id].profileId;
        const nextAddress = address !== undefined ? address : state.fixtures[id].address;
        const nextUniverse = universe !== undefined ? universe : universeOf(state.fixtures[id]);

        // A fixture has to fit inside its universe. Past channel 512 the writes
        // land outside the DMX buffer and Node drops them silently, leaving the
        // fixture half-controllable with no error.
        const chCount = getProfile({ profileId: nextProfileId }).channelCount;
        if (!fitsInUniverse(nextAddress, chCount)) {
          socket.emit('error-msg', {
            source: 'fixture',
            message: `Address ${nextAddress} + ${chCount} channels ends at `
              + `${endChannel(nextAddress, chCount)}, past the ${UNIVERSE_SIZE}-channel universe`,
          });
          return;
        }

        // Each universe is another stream going out at the render rate, so the
        // patch may not spread across more of them than the engine transmits.
        const proposed = state.fixtures.map((f, i) => (i === id ? { ...f, universe: nextUniverse } : f));
        if (countUniverses(proposed) > MAX_UNIVERSES) {
          socket.emit('error-msg', {
            source: 'fixture',
            message: `Moving "${state.fixtures[id].label}" to universe ${nextUniverse} would put the `
              + `patch on more than the ${MAX_UNIVERSES} universes this server transmits`,
          });
          return;
        }

        state.fixtures[id].address = nextAddress;
        state.fixtures[id].universe = nextUniverse;
        state.fixtures[id].profileId = nextProfileId;
        if (label !== undefined) state.fixtures[id].label = label;
        // A trim, not part of the patch: it needs none of the universe or
        // address checks above, but it rides the same message so dragging the
        // slider does not need a second channel.
        if (maxBrightness !== undefined) state.fixtures[id].maxBrightness = maxBrightness;
        showStore.scheduleSave();
        integrations.broadcast();
      } catch (err) {
        socket.emit('error-msg', { source: 'fixture', message: err.message });
      }
    });

    socket.on('tap', processTap);

    socket.on('midi-connect', (payload) => {
      try {
        // Same schema the REST route uses — these two paths had drifted apart.
        const { input, output } = validate(midiConnectSchema, payload || {}, 'midi-connect');
        midi.close();
        const ok = midi.connect(input || null, output || null);
        try {
          settings.update({ midi: { input: input || '', output: output || '' } });
        } catch (err) {
          console.warn(`[settings] could not persist MIDI ports: ${err.message}`);
        }
        socket.emit('midi-status', { ok, ports: midi.listPorts(), enabled: midi.enabled });
      } catch (err) {
        socket.emit('error-msg', { source: 'midi-connect', message: err.message });
      }
    });

    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
  });
}

module.exports = { attachSockets };
