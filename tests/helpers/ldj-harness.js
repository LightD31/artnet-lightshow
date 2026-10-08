import '../../src/shared/effects/index.ts';
import { validateSpec } from '../../src/shared/effects/registry.ts';
import { renderEffect } from '../../src/shared/effects/render.ts';
import { EffectStepper } from '../../src/shared/effects/stepper.ts';
import { HD_MASTER_DEFAULTS } from '../../src/shared/effects/types.ts';
import { buildRoom } from '../../src/shared/room.ts';
import { seedFrom } from '../../src/shared/effects/hash.ts';
import { parseHex } from '../../src/shared/effects/palette.ts';

export const RED = parseHex('#FF0000'), CYAN = parseHex('#00FFFF');
export const square = () => buildRoom(4, (i) => [0, 1, 1, 0][i], (i) => [0, 0, 1, 1][i], () => 0.5, null);
export const row = (n) => buildRoom(n, (i) => n > 1 ? i / (n - 1) : 0.5, () => 0.5, () => 0.5, null);
export const isCyan = (s) => s.colour.g === 255 && s.colour.b === 255 && s.colour.r === 0;

// One instance and real elapsed gaps exercise lamp fades, queued changes and
// palette rolls together. Object samples can change tempo without moving time.
export function harness(kind, room, { bpm = 120, palette = [RED, CYAN], params = {}, acknowledged = true,
  hueStrobe = 'pulse', seed = 'ldj', startedAtMs = 0, anchorBeat = 0, spec = {} } = {}) {
  const stepper = new EffectStepper();
  const inst = { id: kind, spec: validateSpec({ kind, params, ...spec }), seed: seedFrom(seed), anchorBeat, startedAtMs, targets: null };
  let last = null;
  return {
    inst, stepper,
    state: () => stepper.get(kind, () => null, last ?? startedAtMs),
    draw(position, usingStepper = stepper) {
      const input = typeof position === 'object' ? position : { beatPos: position, nowMs: startedAtMs + (position - anchorBeat) * 60000 / bpm };
      const nowMs = input.nowMs, beatPos = input.beatPos;
      const dtMs = last === null ? 0 : nowMs - last;
      last = nowMs;
      const out = Array.from({ length: room.n }, () => ({ colour: RED, level: 0, strength: 0 }));
      renderEffect(inst, { beatPos, bpm, nowMs, dtMs, anchorBeat, lookPalette: palette, paletteOverride: null,
        audio: null, audioMode: 'tempo', master: HD_MASTER_DEFAULTS, seed: inst.seed, acknowledged, hueStrobe, ...input }, room, usingStepper, out);
      return out;
    },
  };
}

export function run(kind, room, positions, options) {
  const h = harness(kind, room, options);
  return positions.map((position) => h.draw(position));
}
