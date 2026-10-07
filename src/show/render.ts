// Clamp final values to the patch schema so timer callbacks cannot fail on generated intents.

import { INTENT } from './intents.ts';
import type { Intent, IntentKind, SceneIntent } from './intents.ts';
import type { ShowDynamics } from '../types/rig.ts';

export interface PatchData {
  pattern?: string;
  colorA?: number;
  colorB?: number;
  colorC?: number;
  colorD?: number;
  fadeMs?: number;
  split?: number | null;
  pixelMap?: string;
  pixelPattern?: string | null;
  pixelSpan?: number | null;
  pixelFrom?: number | null;
  panelPattern?: string | null;
  beatDivision?: number;
  strobeSpeed?: number;
  strobeFunction?: string;
  bpm?: number;
  showDynamics?: ShowDynamics | null;
  running?: boolean;
  energyOverride?: null;
}

export interface EnergyData {
  id: string;
  durationMs: number;
}

interface EventBase {
  timeMs: number;
  source?: string;
  kind?: IntentKind;
}

export interface PatchEvent extends EventBase {
  action: 'patch';
  data: PatchData;
}

export interface EnergyEvent extends EventBase {
  action: 'energy';
  data: EnergyData;
}

export type TimelineEvent = PatchEvent | EnergyEvent;

type ColourSlot = 'colorA' | 'colorB' | 'colorC' | 'colorD';
const SLOTS: readonly ColourSlot[] = ['colorA', 'colorB', 'colorC', 'colorD'];

const u8 = (n: number): number => Math.max(0, Math.min(255, Math.round(n) || 0));
const clampBpm = (n: number): number => Math.max(20, Math.min(300, Math.round(n * 100) / 100 || 120));
const division = (n: number): number => Math.max(1, Math.min(16, Math.round(n) || 1));

const BURST_PRIORITY: Record<string, number> = {
  glow: 0, kill: 1, 'uv-wash': 2, 'color-strobe': 3, blinder: 4, 'white-strobe': 5,
};

const DEBOUNCE_SAFETY_MS = 60;

const KEEPS_ENERGY = new Set(['buildup:tension', 'buildup:rise', 'buildup:peak',
  'drop:hype-pattern']);

function renderIntents(intents: readonly Intent[], { blackoutIndex = 0 } = {}): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const intent of intents) {
    const first = events.length;
    switch (intent.kind) {
      case INTENT.EXPRESSION:
        events.push({ timeMs: intent.timeMs, action: 'patch', data: { showDynamics: intent.dynamics,
          ...(intent.dynamics?.level === 0 ? { energyOverride: null } : {}) } });
        break;
      case INTENT.SCENE:
        events.push({ timeMs: intent.timeMs, action: 'patch', data: sceneData(intent) });
        break;

      case INTENT.COLOR: {
        const data: PatchData = {};
        (intent.colors || []).forEach((value, i) => {
          if (value != null && SLOTS[i]) data[SLOTS[i]] = Math.max(0, Math.round(value));
        });
        if (Object.keys(data).length) {
          if (intent.fadeMs && intent.fadeMs > 0) data.fadeMs = Math.min(10000, Math.round(intent.fadeMs));
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
    for (let i = first; i < events.length; i++) {
      events[i].source = intent.source;
      events[i].kind = intent.kind;
    }
  }

  return debounceBursts(sortEvents(events));
}

function sceneData(intent: SceneIntent): PatchData {
  const data: PatchData = {};
  if (intent.pattern) data.pattern = String(intent.pattern);

  (intent.colors || []).forEach((value, i) => {
    if (value != null && SLOTS[i]) data[SLOTS[i]] = Math.max(0, Math.round(value));
  });

  if (intent.fadeMs && intent.fadeMs > 0) data.fadeMs = Math.min(10000, Math.round(intent.fadeMs));
  data.split = Number.isInteger(intent.split) ? intent.split as number : null;
  if (intent.pixelMap) data.pixelMap = String(intent.pixelMap);
  if (intent.pixelPattern !== undefined) {
    data.pixelPattern = intent.pixelPattern ? String(intent.pixelPattern) : null;
    data.pixelSpan = intent.pixelSpan && intent.pixelSpan > 0 ? Math.min(4096, intent.pixelSpan) : null;
    data.pixelFrom = intent.pixelFrom && intent.pixelFrom > 0 ? Math.min(1, intent.pixelFrom) : null;
  }
  if (intent.panelPattern !== undefined) data.panelPattern = intent.panelPattern ? String(intent.panelPattern) : null;
  if (intent.beatDivision != null) data.beatDivision = division(intent.beatDivision);
  if (intent.strobeSpeed != null) data.strobeSpeed = u8(intent.strobeSpeed);
  if (intent.strobeFunction) data.strobeFunction = String(intent.strobeFunction);
  if (intent.bpm != null) data.bpm = clampBpm(intent.bpm);
  if (intent.opening) data.showDynamics = null;
  if (intent.running != null) data.running = Boolean(intent.running);
  if (!KEEPS_ENERGY.has(intent.source)) data.energyOverride = null;
  return data;
}

// Apply same-time patches before bursts so clearing an old override cannot cancel a new burst.
function sortEvents<E extends { timeMs: number; action: string }>(events: readonly E[]): E[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      if (a.event.timeMs !== b.event.timeMs) return a.event.timeMs - b.event.timeMs;
      if (a.event.action !== b.event.action) return a.event.action === 'patch' ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ event }) => event);
}

// Resolve collisions before output so every accepted burst receives its full duration.
function debounceBursts(events: readonly TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let active: EnergyEvent | null = null;
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

export {
  renderIntents,
  sortEvents,
  debounceBursts,
  DEBOUNCE_SAFETY_MS,
};
