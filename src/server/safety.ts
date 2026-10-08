import { settings } from './settings.ts';
import { requiresAcknowledgement } from '../shared/effects/registry.ts';
import { HttpError } from '../errors.ts';
import type { EffectSpec } from '../shared/effects/types.ts';

/**
 * The photosensitivity gate: one check for every effect that flashes faster
 * than the photosensitivity threshold, wherever it is asked for — a pattern,
 * a cue, a preset saved over the one on stage.
 *
 * Until the operator acknowledges it (Hue Dynamics' rapid-flash switch), such
 * an effect is refused with a 409 and the running look stays; the renderer
 * holds it dark as well, so nothing that slips past a route ever flashes.
 * The acknowledgement is a setting: given once, saved, and only then given.
 */

export const ACKNOWLEDGEMENT_REQUIRED = 'photosensitivity acknowledgement required';

/** What GET /api/safety answers, and the live state's `safety`. */
export interface SafetyStatus {
  photosensitivityAcknowledged: boolean;
  hdFlashIntervalMs: number;
  strobeMaxLatchSec: number;
}

export const safety = {
  acknowledged(): boolean {
    return settings.get('safety.photosensitivityAcknowledged');
  },

  /** Saved first: a write that fails throws, and the room is still unacknowledged. Given twice, nothing more is written. */
  acknowledge(): void {
    settings.update({ safety: { photosensitivityAcknowledged: true } });
  },

  /**
   * Refuse an effect that needs the acknowledgement while there is none: its
   * kind, its own flag or its parameters (a Light DJ row at a fast cadence)
   * may each ask for it, and a flag saying false waives none of them.
   */
  requireAcknowledged(spec: EffectSpec): void {
    if (requiresAcknowledgement(spec) && !safety.acknowledged()) throw new HttpError(409, ACKNOWLEDGEMENT_REQUIRED);
  },

  status(): SafetyStatus {
    return {
      photosensitivityAcknowledged: settings.get('safety.photosensitivityAcknowledged'),
      hdFlashIntervalMs: settings.get('safety.hdFlashIntervalMs'),
      strobeMaxLatchSec: settings.get('safety.strobeMaxLatchSec'),
    };
  },
};
