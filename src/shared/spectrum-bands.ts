// The live service's spectrum as band settings read it: a 1024-point FFT at
// 22 050 Hz. Shared so the detector, the Disco kind and its editor count the
// same bins for a band and so derive the same floors from it.

export const ANALYSIS_RATE_HZ = 22050;
export const FFT_SIZE = 1024;
export const BIN_HZ = ANALYSIS_RATE_HZ / FFT_SIZE;
/** The highest band edge: Nyquist at the analysis rate. */
export const BAND_HZ_MAX = ANALYSIS_RATE_HZ / 2;

/** A band the service can sum: finite edges, 0 ≤ lo < hi ≤ BAND_HZ_MAX. */
export function validBand(lo: number, hi: number): boolean {
  return Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && lo < hi && hi <= BAND_HZ_MAX;
}

/**
 * The inclusive FFT bins a band sums. Never fewer than two: a band inside one
 * bin takes the one above it too, which exists because no edge passes Nyquist.
 */
export function bandBins(lo: number, hi: number, binHz = BIN_HZ): { lower: number; upper: number; count: number } {
  const lower = Math.floor(lo / binHz);
  const upper = Math.max(Math.floor(hi / binHz), lower + 1);
  return { lower, upper, count: upper - lower + 1 };
}

/** The per-bin floor in dB whose bins add up to `totalFloor` over the band. */
export function perBinFloorDb(totalFloor: number, lo: number, hi: number, binHz = BIN_HZ): number {
  return 10 * Math.log10(totalFloor / bandBins(lo, hi, binHz).count);
}
