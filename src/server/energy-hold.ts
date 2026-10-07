import { VoiceManager, HOLD_TIMEOUT_MS } from './voices.ts';
import { ENERGY_EFFECTS } from './presets.ts';
import { energyEffectSpec } from '../shared/effects/catalogue.ts';
import { ENERGY_KIND_BY_ID } from '../shared/effects/energy.ts';
import { canonical } from '../shared/effects/layer.ts';
import { HOLD_STROBE } from '../shared/look-math.ts';
import type { VoiceSummary } from './voices.ts';

/**
 * The energy effects as they have always been asked for, played as voices:
 * one latched (`energyOverride`: REST, cues, MIDI, the auto show) and one held
 * from a socket (`energy-hold`: Companion). As when the
 * engine showed `heldEnergy ?? energyOverride`, the hold plays over the latch
 * and the latch comes back when it is let go: kept underneath, hidden, its
 * launch and end untouched. Whatever ends a voice — a stop, a disarm, a
 * lease — leaves nothing to restore. The strobe ones stay dark until the
 * photosensitivity acknowledgement, the renderer's gate, so the endpoints
 * answer as they always have.
 */

const HOLD_KEY = 'energy:hold';
const LATCH_KEY = 'energy:latch';

// Each voice id the two slots launch under, to its energy's id.
const ENERGY_OF_VOICE = new Map(ENERGY_EFFECTS.flatMap(({ id }) => [[`energy:${id}`, id], [`energy:${id}:hold`, id]]));
// Each energy kind to its energy's id; the palette strobe is the strobe kind, known by its whole spec.
const ENERGY_OF_KIND = new Map<string, string>(Object.entries(ENERGY_KIND_BY_ID).map(([id, kind]) => [kind, id]));
const PALETTE_STROBE = canonical(energyEffectSpec(HOLD_STROBE));

/** The energy effect a voice plays, whoever launched it, or null; the manual strobe is none. */
function energyOf(v: VoiceSummary): string | null {
  if (v.hidden || v.source === 'strobe') return null;
  return ENERGY_OF_KIND.get(v.kind) ?? (v.kind === 'strobe' && canonical(v.spec) === PALETTE_STROBE ? HOLD_STROBE : null);
}

class EnergyHold {
  declare onChange: (effect: string | null) => void;
  declare voices: VoiceManager;
  declare _held: string | null;

  /**
   * `onChange` hears the held effect, or null, each time it changes. With no
   * manager given this keeps one of its own (no tempo, nothing acknowledged:
   * the energies' admission is the renderer's), for a hold on its own; the
   * server's is one over the live manager, whose changes call sync().
   */
  constructor(onChange: (effect: string | null) => void, voices?: VoiceManager) {
    this.onChange = onChange;
    this._held = null;
    this.voices = voices ?? new VoiceManager({
      now: () => performance.now(), onChange: () => this.sync(), acknowledged: () => false,
    });
  }

  /** Hold `effect` down: the hold before it, whoever's, is let go first. */
  press(owner: string, token: unknown, effect: string): void {
    const hold = this.voices.keyed(HOLD_KEY);
    if (hold) this.voices.stop(hold.id);
    const launch = this._launch(effect);
    if (launch) this.voices.start({ ...launch, id: `energy:${effect}:hold`, key: HOLD_KEY, mode: 'hold', owner, token });
    this.sync();
  }

  renew(owner: string, token: unknown): void {
    this.voices.renew(owner, token);
  }

  release(owner: string, token: unknown): void {
    this.voices.release(owner, token);
  }

  /** The owner went: its hold goes with it. */
  disconnect(owner: string): void {
    const hold = this.voices.keyed(HOLD_KEY);
    if (hold && hold.owner === owner) this.voices.stop(hold.id);
  }

  /**
   * Latch `effect`, or nothing (null, or an id that is no energy effect).
   * The one latched already stays as it is, not launched again; under a
   * hold, the new latch waits hidden.
   */
  latch(effect: string | null): void {
    const current = this.voices.keyed(LATCH_KEY);
    const launch = effect ? this._launch(effect) : null;
    if (!launch) {
      if (current) this.voices.stop(current.id);
    } else if (!current || ENERGY_OF_VOICE.get(current.id) !== effect) {
      this.voices.start({ ...launch, id: `energy:${effect}`, key: LATCH_KEY, mode: 'latched', hidden: !!this.voices.keyed(HOLD_KEY) });
    }
    this.sync();
  }

  /** The held energy effect, or null. */
  held(): string | null {
    const hold = this.voices.keyed(HOLD_KEY);
    return hold ? ENERGY_OF_VOICE.get(hold.id) ?? null : null;
  }

  /** The latched one, held over or not, or null. */
  latched(): string | null {
    const latch = this.voices.keyed(LATCH_KEY);
    return latch ? ENERGY_OF_VOICE.get(latch.id) ?? null : null;
  }

  /**
   * The energy effect playing over the latch, or null: of the voices playing
   * an energy effect (this hold, a pad's, the API's), the one on top — the
   * strobe tier, then the latest launch — unless that is the latch.
   */
  over(): string | null {
    let top: VoiceSummary | null = null;
    let energy: string | null = null;
    for (const v of this.voices.list()) {
      const id = energyOf(v);
      if (id && (!top || (v.tier === top.tier ? v.launchSeq > top.launchSeq : v.tier === 'strobe'))) {
        top = v;
        energy = id;
      }
    }
    return top && top.id !== this.voices.keyed(LATCH_KEY)?.id ? energy : null;
  }

  /** After any change to the voices: the latch hides while a hold is down, and a change of hold is told. */
  sync(): void {
    const latch = this.voices.keyed(LATCH_KEY);
    if (latch) this.voices.setHidden(latch.id, !!this.voices.keyed(HOLD_KEY));
    const held = this.held();
    if (held === this._held) return;
    this._held = held;
    this.onChange(held);
  }

  /** An energy effect as the energy burst always played it; null for an id that is none. */
  _launch(effect: string) {
    const spec = ENERGY_OF_VOICE.has(`energy:${effect}`) ? energyEffectSpec(effect) : null;
    if (!spec) return null;
    const label = ENERGY_EFFECTS.find((e) => e.id === effect)?.name ?? effect;
    // On the global beat grid, a jump in the music included, as the hold
    // strobe always flashed; the strobe tier for it, as the renderer's own
    // compatibility voice had.
    return { spec, targets: 'shared' as const, tier: effect === HOLD_STROBE ? 'strobe' as const : 'voice' as const,
      source: 'energy' as const, label, holdsGrid: true, admission: 'render' as const };
  }
}

export {
  EnergyHold,
  HOLD_TIMEOUT_MS,
};
