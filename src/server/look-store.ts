import { z } from 'zod';
import { JsonStore } from './json-store.ts';
import { lookSchema, captureLook, recallLook } from './cues.ts';
import { messageOf } from '../errors.ts';

/**
 * The look on stage, kept so a restart can put it back (config/look.json).
 *
 * When the supervisor starts the server again — after a crash, a hang, or a
 * restart asked for from the app — the rig has been holding its last frame,
 * or has gone dark, and the operator is mid-set. The new run reads this back
 * before its first frame (LIGHTSHOW_RECOVER) and the rig comes back as it
 * was: the pattern, the colours, the masters, every override — the same look
 * a cue captures (cues.ts) — and, if the auto show was running, its track's
 * show, reloaded from the analysis cache and following the music again.
 *
 * Saved every couple of seconds when it has changed. An energy effect is
 * never put back: a held blinder whose release was lost in the crash must not
 * come back stuck on. A normal start ignores the file: the night starts from
 * the defaults, as it always has.
 */

const savedSchema = z.object({
  savedAt: z.string().max(40),
  look: lookSchema,
  auto: z.object({
    running: z.boolean(),
    key: z.string().max(2048).nullable(),
    track: z.record(z.string(), z.unknown()).nullable(),
    // What it followed: the music player, the decks, the live input, or its
    // own clock ('timer').
    source: z.string().max(16),
    // Only with the auto show's own clock: a player-driven show follows the
    // player, wherever it has got to.
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

  /** Save the look when it differs from the last one saved; true when it wrote. */
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

/** The auto show, as far as keeping and resuming it goes. */
export interface ResumableShow {
  running: boolean;
  analysisKey: string | null;
  track: Record<string, unknown> | null;
  getPositionMs(): number;
}

/** What is on stage now, as it would be put back; `source` is what the auto show follows. */
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

/** Put a saved look back on stage — without its energy effect. */
export function putBack(saved: SavedLook): void {
  recallLook({ ...saved.look, energyOverride: null });
}

/**
 * Where a show on its own clock has got to by now: where it was saved, plus
 * the time since — the music did not stop for the restart.
 */
export function resumeAt(saved: SavedLook, now = Date.now()): number | null {
  if (!saved.auto || saved.auto.positionMs === null) return null;
  const since = now - Date.parse(saved.savedAt);
  return saved.auto.positionMs + (Number.isFinite(since) && since > 0 ? since : 0);
}
