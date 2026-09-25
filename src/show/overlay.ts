/**
 * The operator's edits to one track's show, kept with its analysis and put
 * back on every plan.
 *
 * The director plans a track afresh whenever anything it reads changes: the
 * intensity, the palette size, the rig, the set before it. Edits made to the
 * timeline it produced would be lost on the next of those. So an edit is
 * stored as what the operator meant — this palette, this look for the chorus
 * at 1:02, a blinder here, no strobe there — beside the track's analysis
 * (analysis-cache.ts), and the director applies it last, over whatever it
 * planned:
 *
 *   palette   lock the track to one bank, whatever the music or the night
 *             would choose
 *   sections  a look of the operator's for the section that starts at a
 *             time: the pars' pattern, the bars' picture or both. The
 *             section holds it — the rotation inside it stops too
 *   accents   bursts the operator added, which fire whatever the budget
 *             says, and moments the operator took one away from
 *
 * Times are track times in milliseconds. A section is matched to within two
 * seconds and an accent to within 150 ms, so an edit made against one
 * analysis still lands after the track is analysed again.
 */

import { INTENT, PRIORITY, BURST, accent } from './intents.ts';
import type { BurstKind, Intent, SceneIntent } from './intents.ts';

export interface OverlaySection {
  /** When the section starts, ms. */
  atMs: number;
  /** The pars' pattern (the whole rig's, on a rig of pars). */
  pattern?: string;
  /** The bars' picture, on a rig with bars; null for one pattern on the whole rig. */
  pixelPattern?: string | null;
  /** The panels' picture, on a rig with panels; null for the panels to draw the bars'. */
  panelPattern?: string | null;
}

export interface OverlayAccent {
  atMs: number;
  burst: BurstKind;
  durationMs?: number;
}

export interface ShowOverlay {
  /** A palette bank's name (server/palettes.ts), or nothing to let the show choose. */
  palette?: string | null;
  sections?: OverlaySection[];
  accents?: { add?: OverlayAccent[]; remove?: number[] };
}

/** How near a section's own start an edit has to be to be that section's. */
const SECTION_MATCH_MS = 2000;
/** And an accent to one the plan made, to take it away. */
const ACCENT_MATCH_MS = 150;
const DEFAULT_BURST_MS = 350;

export const BURSTS: readonly BurstKind[] = Object.values(BURST);

/** Is there anything in it? */
function isEmpty(overlay: ShowOverlay | null | undefined): boolean {
  return !overlay || (!overlay.palette && !overlay.sections?.length
    && !overlay.accents?.add?.length && !overlay.accents?.remove?.length);
}

/**
 * Put the operator's edits on a planned track: `intents` time sorted, as the
 * director emits them; `sections` its planned sections, in seconds. Returns
 * the edited intents, time sorted.
 */
function applyOverlay(intents: readonly Intent[], overlay: ShowOverlay | null | undefined,
  sections: readonly { start: number; end: number }[]): Intent[] {
  if (isEmpty(overlay)) return intents.slice();
  const edits = overlay as ShowOverlay;
  let out = intents.slice();

  // Sections: each edit is the section whose start is nearest it, within
  // reach. Its opening scene takes the look, and the rotation inside it goes.
  for (const edit of edits.sections || []) {
    const section = nearestSection(sections, edit.atMs);
    if (!section) continue;
    const from = section.start * 1000 - SECTION_MATCH_MS;
    const to = section.end * 1000;
    let opened = false;
    out = out.filter((i) => {
      if (i.kind !== INTENT.SCENE || i.timeMs < from || i.timeMs >= to) return true;
      const source = String(i.source);
      if (source === 'rotation' || source === 'section:solid-followup') return false;
      if (!opened && source.startsWith('section:')) {
        opened = true;
        applyLook(i, edit);
      }
      return true;
    });
  }

  // Accents: the ones taken away go, drop bursts included; the ones added
  // fire as the drop's do, past the budget.
  const removed = edits.accents?.remove || [];
  if (removed.length) {
    out = out.filter((i) => i.kind !== INTENT.ACCENT
      || !removed.some((t) => Math.abs(i.timeMs - t) <= ACCENT_MATCH_MS));
  }
  for (const add of edits.accents?.add || []) {
    if (!BURSTS.includes(add.burst)) continue;
    out.push(accent(add.atMs, add.burst, Math.max(120, Math.min(2000, add.durationMs || DEFAULT_BURST_MS)), {
      source: 'operator', priority: PRIORITY.DROP, confidence: 1, intensity: 1,
    }));
  }
  return out.sort((a, b) => a.timeMs - b.timeMs || a.priority - b.priority);
}

function applyLook(scene: SceneIntent, edit: OverlaySection): void {
  if (edit.pattern) {
    scene.pattern = edit.pattern;
    // A look the operator chose runs as chosen: no group holding a wash.
    delete scene.split;
    if (edit.pattern !== 'strobe') scene.strobeSpeed = 0;
  }
  if (edit.pixelPattern !== undefined && 'pixelPattern' in scene) {
    scene.pixelPattern = edit.pixelPattern;
    delete scene.pixelSpan;
    delete scene.pixelFrom;
  }
  if (edit.panelPattern !== undefined && 'panelPattern' in scene) scene.panelPattern = edit.panelPattern;
}

function nearestSection<S extends { start: number }>(sections: readonly S[], atMs: number): S | null {
  let best: S | null = null;
  for (const s of sections) {
    const d = Math.abs(s.start * 1000 - atMs);
    if (d <= SECTION_MATCH_MS && (!best || d < Math.abs(best.start * 1000 - atMs))) best = s;
  }
  return best;
}

export { applyOverlay, isEmpty, SECTION_MATCH_MS, ACCENT_MATCH_MS };
