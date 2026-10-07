export const ANALYSIS_RATE_HZ = 22050;
export const FFT_SIZE = 1024;
export const BIN_HZ = ANALYSIS_RATE_HZ / FFT_SIZE;
export const BAND_HZ_MAX = ANALYSIS_RATE_HZ / 2;

export function validBand(lo: number, hi: number): boolean {
  return Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && lo < hi && hi <= BAND_HZ_MAX;
}

// Include at least two bins so a band narrower than one FFT bin still has usable power.
export function bandBins(lo: number, hi: number, binHz = BIN_HZ): { lower: number; upper: number; count: number } {
  const lower = Math.floor(lo / binHz);
  const upper = Math.max(Math.floor(hi / binHz), lower + 1);
  return { lower, upper, count: upper - lower + 1 };
}

export function perBinFloorDb(totalFloor: number, lo: number, hi: number, binHz = BIN_HZ): number {
  return 10 * Math.log10(totalFloor / bandBins(lo, hi, binHz).count);
}
