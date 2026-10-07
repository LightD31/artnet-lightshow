import { VoiceManager, HOLD_TIMEOUT_MS } from './voices.ts';
import { ENERGY_EFFECTS } from './presets.ts';
import { energyEffectSpec } from '../shared/effects/catalogue.ts';
import { ENERGY_KIND_BY_ID } from '../shared/effects/energy.ts';
import { canonical } from '../shared/effects/layer.ts';
import { HOLD_STROBE } from '../shared/look-math.ts';
import type { VoiceSummary } from './voices.ts';

const HOLD_KEY = 'energy:hold';
const LATCH_KEY = 'energy:latch';

const ENERGY_OF_VOICE = new Map(ENERGY_EFFECTS.flatMap(({ id }) => [[`energy:${id}`, id], [`energy:${id}:hold`, id]]));
const ENERGY_OF_KIND = new Map<string, string>(Object.entries(ENERGY_KIND_BY_ID).map(([id, kind]) => [kind, id]));
const PALETTE_STROBE = canonical(energyEffectSpec(HOLD_STROBE));

function energyOf(v: VoiceSummary): string | null {
  if (v.hidden || v.source === 'strobe') return null;
  return ENERGY_OF_KIND.get(v.kind) ?? (v.kind === 'strobe' && canonical(v.spec) === PALETTE_STROBE ? HOLD_STROBE : null);
}

class EnergyHold {
  declare onChange: (effect: string | null) => void;
  declare voices: VoiceManager;
  declare _held: string | null;

  constructor(onChange: (effect: string | null) => void, voices?: VoiceManager) {
    this.onChange = onChange;
    this._held = null;
    this.voices = voices ?? new VoiceManager({
      now: () => performance.now(), onChange: () => this.sync(), acknowledged: () => false,
    });
  }

  press(owner: string, token: unknown, effect: string): void {
    const launch = this._launch(effect);
    if (launch) this.voices.admit(launch.spec);
    const hold = this.voices.keyed(HOLD_KEY);
    if (hold) this.voices.stop(hold.id);
    if (launch) this.voices.start({ ...launch, id: `energy:${effect}:hold`, key: HOLD_KEY, mode: 'hold', owner, token });
    this.sync();
  }

  renew(owner: string, token: unknown): void {
    this.voices.renew(owner, token);
  }

  release(owner: string, token: unknown): void {
    this.voices.release(owner, token);
  }

  disconnect(owner: string): void {
    const hold = this.voices.keyed(HOLD_KEY);
    if (hold && hold.owner === owner) this.voices.stop(hold.id);
  }

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

  held(): string | null {
    const hold = this.voices.keyed(HOLD_KEY);
    return hold ? ENERGY_OF_VOICE.get(hold.id) ?? null : null;
  }

  latched(): string | null {
    const latch = this.voices.keyed(LATCH_KEY);
    return latch ? ENERGY_OF_VOICE.get(latch.id) ?? null : null;
  }

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

  sync(): void {
    const latch = this.voices.keyed(LATCH_KEY);
    if (latch) this.voices.setHidden(latch.id, !!this.voices.keyed(HOLD_KEY));
    const held = this.held();
    if (held === this._held) return;
    this._held = held;
    this.onChange(held);
  }

  _launch(effect: string) {
    const spec = ENERGY_OF_VOICE.has(`energy:${effect}`) ? energyEffectSpec(effect) : null;
    if (!spec) return null;
    const label = ENERGY_EFFECTS.find((e) => e.id === effect)?.name ?? effect;
    return { spec, targets: 'shared' as const, tier: effect === HOLD_STROBE ? 'strobe' as const : 'voice' as const,
      source: 'energy' as const, label, holdsGrid: true };
  }
}

export {
  EnergyHold,
  HOLD_TIMEOUT_MS,
};
