import { z } from 'zod';
import { JsonStore } from './json-store.ts';
import { lookSchema, captureLook, recallLook } from './cues.ts';
import { state } from './state.ts';
import { messageOf, statusOf } from '../errors.ts';

// Never restore held energy effects because a lost release could leave a blinder or strobe latched.

const savedSchema = z.object({
  savedAt: z.string().max(40),
  look: lookSchema,
  auto: z.object({
    running: z.boolean(),
    key: z.string().max(2048).nullable(),
    track: z.record(z.string(), z.unknown()).nullable(),
    source: z.string().max(16),
    positionMs: z.number().finite().min(0).nullable(),
  }).strict().nullable(),
}).strict();

export type SavedLook = z.output<typeof savedSchema>;
type Unsaved = Omit<SavedLook, 'savedAt'>;

export class LookStore extends JsonStore {
  declare _last: string | null;

  constructor(file: string) {
    super(file, { tag: 'look', fallback: 'nothing to put back' });
    this._last = null;
  }

  load(): SavedLook | undefined {
    return this.readValid(savedSchema);
  }

  save(look: Unsaved): boolean {
    const body = JSON.stringify(look);
    if (body === this._last) return false;
    try {
      this.writeJson({ savedAt: new Date().toISOString(), ...look });
      this._last = body;
      return true;
    } catch (err) {
      console.warn(`[look] could not save ${this.file}: ${messageOf(err)}`);
      return false;
    }
  }
}

export interface ResumableShow {
  running: boolean;
  analysisKey: string | null;
  track: Record<string, unknown> | null;
  getPositionMs(): number;
}

export function currentLook(autoShow: ResumableShow | null, source = 'timer'): Unsaved {
  const auto = autoShow && autoShow.running && autoShow.analysisKey ? {
    running: true,
    key: autoShow.analysisKey,
    track: autoShow.track ? { ...autoShow.track } : null,
    source,
    positionMs: source === 'timer' ? Math.max(0, Math.round(autoShow.getPositionMs())) : null,
  } : null;
  return { look: lookSchema.parse(captureLook()), auto };
}

// Keep current settings on recovery so an older look snapshot cannot undo saved safety or audio changes.
export function putBack(saved: SavedLook): boolean {
  const { audioMode: _audioMode, strobe: _strobe, ...look } = saved.look;
  try {
    try {
      recallLook({ ...look, energyOverride: null });
    } catch (err) {
      if (statusOf(err) !== 409) throw err;
      console.warn(`[look] the look from ${saved.savedAt} comes back without ${look.pattern}: ${messageOf(err)}`);
      recallLook({ ...look, pattern: state.pattern, energyOverride: null });
    }
    return true;
  } catch (err) {
    console.warn(`[look] could not put back the look from ${saved.savedAt}: ${messageOf(err)}`);
    return false;
  }
}

export function resumeAt(saved: SavedLook, now = Date.now()): number | null {
  if (!saved.auto || saved.auto.positionMs === null) return null;
  const since = now - Date.parse(saved.savedAt);
  return saved.auto.positionMs + (Number.isFinite(since) && since > 0 ? since : 0);
}
