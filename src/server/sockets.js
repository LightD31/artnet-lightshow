'use strict';

const { state, getClientState, getFixtureCount } = require('./state');
const { applyPatch, applyOverride, processTap } = require('./patch');
const {
  overrideMessageSchema,
  fixtureMessageSchema,
  midiConnectSchema,
  validate,
} = require('./validation');
const { listProfiles, getProfile, endChannel, fitsInUniverse, UNIVERSE_SIZE } = require('./profiles');

function attachSockets(io, { midi, integrations }) {
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
        const { id, address, label, profileId } = validate(fixtureMessageSchema, payload, 'fixture-msg');
        if (id < 0 || id >= getFixtureCount()) return;

        const profiles = listProfiles();
        const nextProfileId = (profileId !== undefined && profiles[profileId])
          ? profileId : state.fixtures[id].profileId;
        const nextAddress = address !== undefined ? address : state.fixtures[id].address;

        // A fixture has to fit inside the universe. Past channel 512 the writes
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

        state.fixtures[id].address = nextAddress;
        state.fixtures[id].profileId = nextProfileId;
        if (label !== undefined) state.fixtures[id].label = label;
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
        socket.emit('midi-status', { ok, ports: midi.listPorts(), enabled: midi.enabled });
      } catch (err) {
        socket.emit('error-msg', { source: 'midi-connect', message: err.message });
      }
    });

    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
  });
}

module.exports = { attachSockets };
