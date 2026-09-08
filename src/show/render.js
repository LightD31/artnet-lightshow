'use strict';

/**
 * Intents to Art-Net patches.
 *
 *     musical events -> lighting intent -> DMX / ART-NET OUTPUT
 *
 * This is the only file in the show layer that knows what a patch field is
 * called. Everything above it reasons about music and about gestures; this
 * translates a gesture into whatever the rig in front of it happens to be, and
 * enforces the two rules the timeline itself has to guarantee:
 *
 *   Every value must be one the patch schema accepts. The timeline fires from a
 *   timer callback, so an out-of-range number is not a bad look — it is an
 *   uncaught exception that ends the process mid-set and leaves the rig stuck
 *   on whatever it was last told. Scale first, then clamp, always.
 *
 *   Every burst must get the length it asked for. Bursts come from independent
 *   passes that cannot see each other, and two overlapping ones mean the first
 *   is cut off before the fixtures have finished responding to it.
 */

const { INTENT } = require('./intents');

const u8 = (n) => Math.max(0, Math.min(255, Math.round(n) || 0));
const clampBpm = (n) => Math.max(20, Math.min(300, Math.round(n) || 120));
const division = (n) => Math.max(1, Math.min(16, Math.round(n) || 1));

// Loudest wins when two bursts collide.
const BURST_PRIORITY = { 'white-strobe': 3, blinder: 2, 'color-strobe': 1 };

// A burst may not start until the previous one has fully played out, plus this
// gap. Without it a second burst 150 ms in clips the first one in half, and at
// a 300 ms minimum length that is most of it.
const DEBOUNCE_SAFETY_MS = 60;

// Scenes from these sources leave any running burst alone. A build-up phase or
// a hype pattern is layered *under* a burst that is already playing, so
// clearing the energy override there would cancel the very thing it decorates.
const KEEPS_ENERGY = new Set(['buildup:tension', 'buildup:rise', 'buildup:peak',
  'drop:hype-pattern']);

/**
 * Render planned intents into the timeline the playback loop fires.
 *
 * Returns `[{ timeMs, action: 'patch' | 'energy', data }]`, time sorted, with
 * bursts debounced.
 */
function renderIntents(intents, { blackoutIndex = 0 } = {}) {
  const events = [];

  for (const intent of intents) {
    switch (intent.kind) {
      case INTENT.SCENE:
        events.push({ timeMs: intent.timeMs, action: 'patch', data: sceneData(intent) });
        break;

      case INTENT.COLOR: {
        const data = {};
        const slots = ['colorA', 'colorB', 'colorC', 'colorD'];
        (intent.colors || []).forEach((value, i) => {
          if (value != null && slots[i]) data[slots[i]] = Math.max(0, Math.round(value));
        });
        if (Object.keys(data).length) {
          events.push({ timeMs: intent.timeMs, action: 'patch', data });
        }
        break;
      }

      case INTENT.TEMPO:
        events.push({
          timeMs: intent.timeMs, action: 'patch', data: { bpm: clampBpm(intent.bpm) },
        });
        break;

      case INTENT.DARK:
        events.push({
          timeMs: intent.timeMs,
          action: 'patch',
          data: {
            colorA: Math.max(0, Math.round(
              intent.colorIndex != null ? intent.colorIndex : blackoutIndex)),
            strobeSpeed: 0,
            beatDivision: 1,
          },
        });
        break;

      case INTENT.ACCENT:
        events.push({
          timeMs: intent.timeMs,
          action: 'energy',
          data: { id: intent.burst, durationMs: Math.max(1, Math.round(intent.durationMs)) },
        });
        break;

      default:
        break;
    }
  }

  return debounceBursts(sortEvents(events));
}

function sceneData(intent) {
  const data = {};
  if (intent.pattern) data.pattern = String(intent.pattern);

  const slots = ['colorA', 'colorB', 'colorC', 'colorD'];
  (intent.colors || []).forEach((value, i) => {
    if (value != null && slots[i]) data[slots[i]] = Math.max(0, Math.round(value));
  });

  if (intent.beatDivision != null) data.beatDivision = division(intent.beatDivision);
  if (intent.strobeSpeed != null) data.strobeSpeed = u8(intent.strobeSpeed);
  if (intent.strobeFunction) data.strobeFunction = String(intent.strobeFunction);
  if (intent.bpm != null) data.bpm = clampBpm(intent.bpm);
  if (intent.running != null) data.running = Boolean(intent.running);
  if (intent.masterBlackout != null) data.masterBlackout = Boolean(intent.masterBlackout);
  if (!KEEPS_ENERGY.has(intent.source)) data.energyOverride = null;
  return data;
}

/**
 * Sort by time; at the same instant patches fire before bursts, and insertion
 * order is preserved within each.
 *
 * The patch-first rule matters: a section boundary and a burst can land on the
 * same downbeat, and the boundary's `energyOverride: null` would otherwise
 * cancel the burst that started a moment earlier on the same millisecond.
 */
function sortEvents(events) {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      if (a.event.timeMs !== b.event.timeMs) return a.event.timeMs - b.event.timeMs;
      if (a.event.action !== b.event.action) return a.event.action === 'patch' ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ event }) => event);
}

/**
 * Guarantee every emitted burst its full declared length.
 *
 * The next burst cannot start until the previous one has finished plus a safety
 * gap. When two collide, the louder one wins and replaces the earlier one —
 * a white strobe that arrives during a colour strobe is the bigger musical
 * moment, and the colour strobe was the one that turned out to be premature.
 */
function debounceBursts(events) {
  const out = [];
  let active = null;
  let activeEnd = -Infinity;

  for (const event of events) {
    if (event.action !== 'energy') {
      out.push(event);
      continue;
    }
    const id = event.data && event.data.id;
    const priority = BURST_PRIORITY[id] != null ? BURST_PRIORITY[id] : 0;
    const durationMs = (event.data && event.data.durationMs) || 200;

    if (active && event.timeMs < activeEnd + DEBOUNCE_SAFETY_MS) {
      const activePriority = BURST_PRIORITY[active.data.id] != null
        ? BURST_PRIORITY[active.data.id] : 0;
      if (priority > activePriority) {
        const at = out.lastIndexOf(active);
        if (at >= 0) out.splice(at, 1);
        out.push(event);
        active = event;
        activeEnd = event.timeMs + durationMs;
      }
      continue;
    }

    out.push(event);
    active = event;
    activeEnd = event.timeMs + durationMs;
  }
  return out;
}

module.exports = { renderIntents, sortEvents, debounceBursts, DEBOUNCE_SAFETY_MS };
