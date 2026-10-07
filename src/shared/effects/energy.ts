import { z } from 'zod';
import { resolveEnergyOverride } from '../look-math.ts';
import { registerKind } from './registry.ts';

export const ENERGY_KIND_BY_ID = {
  'white-strobe': 'energy.whiteStrobe',
  'color-strobe': 'energy.colorStrobe',
  blinder: 'energy.blinder',
  'uv-wash': 'energy.uvWash',
  kill: 'energy.kill',
  glow: 'energy.glow',
} as const;

// Hardware strobe requests require acknowledgement.
const RAPID = new Set(['white-strobe', 'color-strobe']);
const schema = z.object({}).strict();

for (const [id, kind] of Object.entries(ENERGY_KIND_BY_ID)) {
  registerKind<Record<string, never>, null>({
    kind, app: 'own', schema, defaults: { params: {} },
    rapidFlash: RAPID.has(id),
    // Glow applies expression itself to preserve its 150..255 curve.
    rideLevel: id === 'glow',
    init: () => null,
    render(_params, _state, room, frame, out) {
      const raw = frame.expressionLevel ?? 1;
      const level = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
      const look = resolveEnergyOverride(id, frame.palette[0], level)!;
      // Kill owns its black at full strength, so it hides every layer below.
      for (let i = 0; i < room.n; i++) out[i] = { colour: { ...look.col }, level: look.dim / 255, strength: 1, strobe: look.strobe };
    },
  });
}
