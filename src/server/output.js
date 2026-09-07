'use strict';

const { state } = require('./state');
const { sendArtDmx } = require('./artnet');
const { sendSacn, MIN_UNIVERSE, MAX_UNIVERSE } = require('./sacn');

/**
 * Where a rendered universe goes.
 *
 * The engine builds frames; this decides which wire protocols carry them.
 * Art-Net and sACN are independent — a rig can run either, or both at once
 * while a venue is being migrated from one to the other.
 *
 * The sACN settings are cached rather than read from the store per frame:
 * `settings.group()` deep-clones, and this runs 40 times a second per universe.
 * The applier calls configureSacn() at boot and again whenever they change.
 */

let sacn = {
  enabled: false,
  host: '',
  priority: 100,
  sourceName: 'ArtNet Lightshow',
  universeOffset: 1,
  cid: '',
};

function configureSacn(config) {
  sacn = { ...sacn, ...config };
  return sacn;
}

function getSacnConfig() { return { ...sacn }; }

/**
 * The sACN universe a rig universe maps to.
 *
 * Art-Net counts universes from 0 and sACN from 1, so the default offset of 1
 * lines them up the way every other tool does. Returns null when the result
 * falls outside what E1.31 allows, which the caller reports rather than
 * silently sending nowhere.
 */
function sacnUniverseFor(universe, offset = sacn.universeOffset) {
  const mapped = universe + offset;
  if (!Number.isInteger(mapped) || mapped < MIN_UNIVERSE || mapped > MAX_UNIVERSE) return null;
  return mapped;
}

/**
 * Put one universe on every enabled wire.
 *
 * Returns the protocols it actually reached, which the preflight check uses to
 * tell "nothing is configured" apart from "it went out and nobody answered".
 */
function sendUniverse(universe, frame) {
  const sent = [];

  if (state.artnet.enabled !== false) {
    sendArtDmx({ host: state.artnet.host, port: state.artnet.port, universe }, frame);
    sent.push('artnet');
  }

  if (sacn.enabled) {
    const mapped = sacnUniverseFor(universe);
    if (mapped !== null && sendSacn({
      universe: mapped,
      cid: sacn.cid,
      sourceName: sacn.sourceName,
      priority: sacn.priority,
      host: sacn.host,
    }, frame)) {
      sent.push('sacn');
    }
  }

  return sent;
}

module.exports = {
  configureSacn,
  getSacnConfig,
  sacnUniverseFor,
  sendUniverse,
};
