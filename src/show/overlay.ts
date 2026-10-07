// Store edits as musical intents so replanning a track does not overwrite operator choices.

import { INTENT, PRIORITY, BURST, accent } from './intents.ts';
import type { BurstKind, Intent, SceneIntent } from './intents.ts';

export interface OverlaySection {
  atMs: number;
  pattern?: string;
  pixelPattern?: string | null;
  panelPattern?: string | null;
}

export interface OverlayAccent {
  atMs: number;
  burst: BurstKind;
  durationMs?: number;
}

export interface ShowOverlay {
  palette?: string | null;
  sections?: OverlaySection[];
  accents?: { add?: OverlayAccent[]; remove?: number[] };
}

const SECTION_MATCH_MS = 2000;
const ACCENT_MATCH_MS = 150;
const DEFAULT_BURST_MS = 350;

export const BURSTS: readonly BurstKind[] = Object.values(BURST);

function isEmpty(overlay: ShowOverlay | null | undefined): boolean {
  return !overlay || (!overlay.palette && !overlay.sections?.length
    && !overlay.accents?.add?.length && !overlay.accents?.remove?.length);
}

function applyOverlay(intents: readonly Intent[], overlay: ShowOverlay | null | undefined,
  sections: readonly { start: number; end: number }[]): Intent[] {
  if (isEmpty(overlay)) return intents.slice();
  const edits = overlay as ShowOverlay;
  let out = intents.slice();

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
