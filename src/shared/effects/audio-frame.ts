export interface AudioFrame {
  t: number;
  generation?: number;
  rms: number;
  power: number;
  dominantHz: number | null;
  party: { full: number; bass: number; mid: number; high: number };
  // Disco level and gate use the same raw FFT power scale so meters can compare them.
  disco: { hit: boolean[]; gate: number[]; level: number[]; peakHit: boolean; neural: { mainFrequency: number; amplitude: number } };
  // Use eventT to consume a held SPL classification once; older producers fall back to t.
  spl: { db: number; level: number; beat: 'loud' | 'soft' | 'quiet' | null; section: 'loud' | 'soft' | 'quiet' | null; eventT?: number };
}
