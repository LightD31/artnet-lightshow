// One frame of live-input features as the party effects read it; plain JSON, since the render snapshot carries it to the worker.

export interface AudioFrame {
  t: number;
  rms: number;
  power: number;
  dominantHz: number | null;
  /** Hue Dynamics Party: 0..1 band levels for its triggers and reactive strength. */
  party: { full: number; bass: number; mid: number; high: number };
  /** Hue Dynamics Disco: per-band hit, gate and level (bass, voice, treble), the Peak hit and the Neural reading. */
  disco: { hit: boolean[]; gate: number[]; level: number[]; peakHit: boolean; neural: { mainFrequency: number; amplitude: number } };
  /** Light DJ's sound-reactive classes: the beat's loudness class and the running section. */
  spl: { db: number; level: number; beat: 'loud' | 'soft' | 'quiet' | null; section: 'loud' | 'soft' | 'quiet' | null };
}
