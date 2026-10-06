// A pattern pad's voice: one internal kind that plays a resolved pattern's
// lanes and clips through the sequence's own helpers. Only the server builds
// one (bundleSpec); it has no catalogue row and public validation refuses it.

import { z, ZodError } from 'zod';
import type { RefinementCtx, ZodType } from 'zod';
import { MAX_NEST_DEPTH, anyChildSpec, nestRefusal, withinNest } from './nesting.ts';
import { pacesOwnFlashes, registerKind, requiresAcknowledgement, validateSpec } from './registry.ts';
import { newSequenceRun, renderPlaced } from './sequence.ts';
import type { SequenceRun, SequenceTable, SequenceTransport, TableClip } from './sequence.ts';
import { EffectStepper } from './stepper.ts';
import type { EffectSpec } from './types.ts';

export const BUNDLE_KIND = 'pattern.bundle';

/** A resolved pattern: frozen lanes and clips over the voice's fixtures, its length, and whether the launch was once (no lap after the length). */
export interface BundleParams { patternId: string; lengthBeats: number; table: SequenceTable; once: boolean }

const word = z.number().int().min(0).max(0xffffffff);
const laneSchema = z.object({
  id: z.string(), kind: z.enum(['shared', 'track']), fixtureId: z.number().int().optional(), name: z.string(), mute: z.boolean(), solo: z.boolean(),
}).strict();
const clipSchema = z.object({
  id: z.string(), laneId: z.string(), fixtureIds: z.array(z.number().int()).nullable(), startBeat: z.number().min(0),
  lengthBeats: z.number().positive(), loopBeats: z.number().positive(), spec: z.unknown(), seed: z.tuple([word, word, word, word]), mute: z.boolean(),
}).strict();
const shapeSchema = z.object({
  patternId: z.string(), lengthBeats: z.number().positive(), once: z.boolean(),
  table: z.object({ revision: z.number().int(), lanes: z.array(laneSchema), clips: z.array(z.unknown()) }).strict(),
}).strict();

const forward = (ctx: RefinementCtx, error: unknown, path: PropertyKey[]) => {
  if (!(error instanceof ZodError)) throw error;
  for (const issue of error.issues) ctx.addIssue({ code: 'custom', message: issue.message, path: [...path, ...issue.path] });
};

const schema: ZodType<BundleParams> = z.unknown().transform((input, ctx): BundleParams => {
  const shape = shapeSchema.safeParse(input);
  if (!shape.success) { forward(ctx, shape.error, []); return z.NEVER; }
  // The caller's own array: identity is what reveals a cycle.
  const raw = (input as { table: { clips: unknown[] } }).table.clips;
  const refusal = nestRefusal(raw);
  if (refusal) {
    const message = refusal === 'cycle' ? 'a pattern bundle may not contain itself' : `containers nest at most ${MAX_NEST_DEPTH} deep`;
    ctx.addIssue({ code: 'custom', message, path: ['table', 'clips'] });
    return z.NEVER;
  }
  const clips: TableClip[] = [];
  withinNest(raw, () => shape.data.table.clips.forEach((item, k) => {
    const path = ['table', 'clips', k];
    const clip = clipSchema.safeParse(item);
    if (!clip.success) { forward(ctx, clip.error, path); return; }
    let spec: EffectSpec;
    try { spec = validateSpec(clip.data.spec); } catch (error) { forward(ctx, error, [...path, 'spec']); return; }
    // As in a sequence: each lap is a fresh instance, which would restart a self-paced flash limit.
    if (pacesOwnFlashes(spec)) {
      ctx.addIssue({ code: 'custom', message: `a pattern bundle may not hold ${spec.kind === 'strobe' ? 'the strobe' : 'an automatic strobe'}`, path: [...path, 'spec'] });
      return;
    }
    clips.push({ ...clip.data, spec, seed: [...clip.data.seed] });
  }));
  if (clips.length !== shape.data.table.clips.length) return z.NEVER;
  return { ...shape.data, table: { ...shape.data.table, clips } };
});

/** The children play in the bundle's own stepper and run, so they are cloned, swept and reset with it. */
interface BundleState { children: EffectStepper; run: SequenceRun }

const BLACK = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0 };

registerKind<BundleParams, BundleState>({
  kind: BUNDLE_KIND, app: 'own', schema, stateful: true, internal: true,
  defaults: { params: { patternId: '', lengthBeats: 4, once: false, table: { revision: 0, lanes: [], clips: [] } } },
  rapidFlashWhen: (p) => {
    const clips: unknown = (p as Partial<BundleParams> | null)?.table?.clips;
    return Array.isArray(clips) && anyChildSpec(clips.map((c) => (c as Partial<TableClip> | null)?.spec), requiresAcknowledgement);
  },
  init: () => ({ children: new EffectStepper(), run: newSequenceRun() }),
  render: (p, s, room, frame, out) => {
    const rel = frame.beatPos - frame.anchorBeat;
    if (!Number.isFinite(rel) || !Number.isFinite(frame.nowMs) || (p.once && rel >= p.lengthBeats)) return;
    // The voice's launch is the table's beat 0; hold and loop wrap at the length, each lap a traversal of its own.
    const transport: SequenceTransport = { startBeat: frame.anchorBeat, loop: p.once ? null : { on: true, startBeat: 0, endBeat: p.lengthBeats }, generation: 0 };
    const ids = frame.fixtureIds ?? Array.from({ length: room.n }, (_, i) => i);
    // Children see the frame a sequence clip sees; the voice's brightness and targets apply after this.
    const { spec: _spec, palette: _palette, roll: _roll, ...base } = frame;
    renderPlaced(base, p.table, transport, s.run, s.children, room, ids, (k, slot, kind) => {
      out[k] = slot ? { ...slot, kind: slot.kind ?? kind } : { colour: BLACK, level: 0, strength: 1 };
    });
  },
});

const minted = new WeakSet<object>();

/** The spec a pattern pad's voice starts with: the only way past validation for this kind (voices.ts voiceSpec). */
export function bundleSpec(bundle: Omit<BundleParams, 'once'>, once: boolean): EffectSpec {
  const spec = Object.freeze({ kind: BUNDLE_KIND, params: Object.freeze({ patternId: bundle.patternId, lengthBeats: bundle.lengthBeats, table: bundle.table, once }) });
  minted.add(spec);
  return spec as EffectSpec;
}

/** Whether `raw` is a spec bundleSpec built (not a copy of one). */
export const isMintedBundle = (raw: unknown): boolean => typeof raw === 'object' && raw !== null && minted.has(raw);
