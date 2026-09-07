'use strict';

const { state, getClientState, getFixtureCount } = require('./state');
const { applyPatch, applyOverride, processTap } = require('./patch');
const {
  overrideMessageSchema,
  fixtureMessageSchema,
  validate,
} = require('./validation');
const { listProfiles } = require('./profiles');

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
        if (address !== undefined) state.fixtures[id].address = address;
        if (label !== undefined) state.fixtures[id].label = label;
        const profiles = listProfiles();
        if (profileId !== undefined && profiles[profileId]) state.fixtures[id].profileId = profileId;
        integrations.broadcast();
      } catch (err) {
        socket.emit('error-msg', { source: 'fixture', message: err.message });
      }
    });

    socket.on('tap', processTap);

    socket.on('midi-connect', ({ input, output } = {}) => {
      midi.close();
      const ok = midi.connect(input || null, output || null);
      socket.emit('midi-status', { ok, ports: midi.listPorts(), enabled: midi.enabled });
    });

    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
  });
}

module.exports = { attachSockets };
