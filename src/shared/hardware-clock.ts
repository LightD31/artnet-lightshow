import type { Colour } from '../types/rig.ts';
type Held = { colour: Colour; dim: number };
interface Run { held: Map<number, Held>; anchor: number; lastBeat: number; beat: number; lastPhase: number; phase: number }

export class HardwareClock {
  private runs = new Map<string, Run>();
  clear(): void { this.runs.clear(); }
  at(key: string, anchor: number, beat: number, phase: number, ratio: number): { beat: number; phase: number } {
    let run = this.runs.get(key);
    if (!run || run.anchor !== anchor || beat < run.lastBeat) {
      run = { held: new Map(), anchor, lastBeat: beat, beat: anchor + (beat - anchor) * ratio, lastPhase: phase, phase: phase * ratio };
      this.runs.set(key, run);
    }
    run.beat += (beat - run.lastBeat) * ratio;
    run.phase = (run.phase + ((phase - run.lastPhase + 1) % 1) * ratio) % 1;
    run.lastBeat = beat; run.lastPhase = phase;
    return run;
  }
  hold(key: string, unit: number, colour: Colour, dim: number): Held {
    const run = this.runs.get(key);
    if (run && !run.held.has(unit) && dim > 0 && Object.values(colour).some((v) => v > 0)) run.held.set(unit, { colour: { ...colour }, dim });
    return run?.held.get(unit) ?? { colour, dim };
  }
  clone(): HardwareClock {
    const copy = new HardwareClock();
    copy.runs = new Map([...this.runs].map(([key, value]) => [key, { ...value, held: new Map([...value.held].map(([u, light]) => [u, { ...light, colour: { ...light.colour } }])) }]));
    return copy;
  }
}
