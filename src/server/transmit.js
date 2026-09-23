'use strict';

const { sendArtDmx } = require('./artnet');
const { sendSacn, MIN_UNIVERSE, MAX_UNIVERSE } = require('./sacn');

/**
 * Putting a rendered universe on the wire: Art-Net, sACN, and the delay line
 * that holds both back for the Hue lamps.
 *
 * It lives wherever frames are rendered — the engine's worker thread, or the
 * main thread when the engine runs there — and is told the output settings
 * with every frame rather than reading them from the live state, which only
 * the main thread has. output.js on the main thread builds that config
 * (`transmitConfig`) and keeps everything to do with Hue itself.
 */

/**
 * The sACN universe a rig universe maps to.
 *
 * Art-Net counts universes from 0 and sACN from 1, so the default offset of 1
 * lines them up the way every other tool does. Returns null when the result
 * falls outside what E1.31 allows, which the caller reports rather than
 * silently sending nowhere.
 */
function sacnUniverseFor(universe, offset) {
  const mapped = universe + offset;
  if (!Number.isInteger(mapped) || mapped < MIN_UNIVERSE || mapped > MAX_UNIVERSE) return null;
  return mapped;
}

/**
 * `wires` stands in for the sockets in tests: `{ artnet(target, frame),
 * sacn(target, frame) }`, each returning whether the frame left.
 */
function createTransmitter({ wires = { artnet: sendArtDmx, sacn: sendSacn }, now = () => performance.now() } = {}) {
  // ── Hue latency compensation ──────────────────────────────────────────────
  // Art-Net reaches a node in about a millisecond; a Hue lamp hears about a
  // frame through the bridge and a Zigbee hop, tens of milliseconds later. So
  // on a mixed rig every accent landed on the pars first and the lamps after
  // it, which on a snare hit is plainly two events. The fast wire is the one
  // that can wait: each universe's frames queue here and go out `delayMs`
  // after they were rendered, while Hue is sent the current frame.
  const delayLine = new Map();     // universe → [{ at, frame }]

  /** The newest frame for this universe old enough to send, or null. */
  function delayedFrame(universe, frame, delayMs) {
    const t = now();
    const queue = delayLine.get(universe) || [];
    queue.push({ at: t, frame: Buffer.from(frame) });
    let ready = null;
    while (queue.length && queue[0].at <= t - delayMs) ready = queue.shift().frame;
    delayLine.set(universe, queue);
    return ready;
  }

  /**
   * Put one universe on every enabled wire.
   *
   * `config` is `{ artnet: { enabled, host, port }, sacn: { enabled, host,
   * priority, sourceName, universeOffset, cid }, delayMs }`.
   *
   * Returns the protocols the frame was handed to. Art-Net counts only once
   * its host has resolved: until then the frame is dropped, and reporting it
   * as sent would say the rig is being driven when nothing has left the
   * machine.
   *
   * With a delay, the frame is queued and an older one goes out in its place.
   * `immediate` skips the queue — for the blackout sent at shutdown and when a
   * universe leaves the patch, which must not wait behind the look they are
   * replacing — and discards what was waiting.
   */
  function send(universe, frame, config, { immediate = false } = {}) {
    const sent = [];
    if (!immediate && config.delayMs > 0) {
      frame = delayedFrame(universe, frame, config.delayMs);
      if (!frame) return sent;
    } else {
      delayLine.delete(universe);
    }

    const { artnet, sacn } = config;
    if (artnet && artnet.enabled !== false) {
      if (wires.artnet({ host: artnet.host, port: artnet.port, universe }, frame)) sent.push('artnet');
    }

    if (sacn && sacn.enabled) {
      const mapped = sacnUniverseFor(universe, sacn.universeOffset);
      if (mapped !== null && wires.sacn({
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

  return { send };
}

module.exports = { createTransmitter, sacnUniverseFor };
