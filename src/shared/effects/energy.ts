// The fork's six energy effects as kinds, so pads and the API can play them as
// voices over the look. Each forces on every slot exactly what the energy
// burst always has (look-math's resolveEnergyOverride): look colour A,
// whatever the effect's palette or an override says.

import { z } from 'zod';
import { resolveEnergyOverride } from '../look-math.ts';
import { registerKind } from './registry.ts';

/** Each energy effect's id (server/presets.ts) and its kind. Spelled out: the kind names are not derived from the ids. */
export const ENERGY_KIND_BY_ID = {
  'white-strobe': 'energy.whiteStrobe',
  'color-strobe': 'energy.colorStrobe',
  blinder: 'energy.blinder',
  'uv-wash': 'energy.uvWash',
  kill: 'energy.kill',
  glow: 'energy.glow',
} as const;

// The two that drive the fixtures' strobe channels need the acknowledgement;
// the blinder is bright but steady.
const RAPID = new Set(['white-strobe', 'color-strobe']);
const schema = z.object({}).strict();

for (const [id, kind] of Object.entries(ENERGY_KIND_BY_ID)) {
  registerKind<Record<string, never>, null>({
    kind, app: 'own', schema, defaults: { params: {} },
    rapidFlash: RAPID.has(id),
    // Glow rides the expression level through its own 150..255 curve. The
    // renderer must not multiply its level by the expression again.
    rideLevel: id === 'glow',
    init: () => null,
    render(_params, _state, room, frame, out) {
      const raw = frame.expressionLevel ?? 1;
      const level = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
      const look = resolveEnergyOverride(id, frame.lookPalette[0], level)!;
      // Kill owns its black at full strength, so it hides every layer below.
      for (let i = 0; i < room.n; i++) out[i] = { colour: { ...look.col }, level: look.dim / 255, strength: 1, strobe: look.strobe };
    },
  });
}
