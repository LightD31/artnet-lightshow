// Approximate the visual mix on a screen for the rig's RGBWAUV channels.
// Amber adds warm orange (R + 0.5 G); UV reads as blue-violet (R 0.2 + B 0.9).
export function colorToCss({ r, g, b, w = 0, a = 0, uv = 0 }) {
  const rr = Math.min(255, r + w + Math.round(a * 1.0) + Math.round(uv * 0.2));
  const gg = Math.min(255, g + w + Math.round(a * 0.5));
  const bb = Math.min(255, b + w + Math.round(uv * 0.9));
  return `rgb(${rr},${gg},${bb})`;
}

export function fmtTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, '0')}`;
}

export function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${Math.round(v * 100)}%`;
}

export function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '–';
  return v.toFixed(digits);
}

export function fixtureOutputColor(fix, state, dmxSnapshot) {
  if (!fix) return '#000';
  if (state.masterBlackout) return '#000';

  if (fix.override && fix.override.enabled) {
    if (fix.override.blackout) return '#000';
    const ov = fix.override;
    const dim = (ov.dim !== undefined ? ov.dim : 255) / 255;
    const mDim = state.masterDimmer / 255;
    return colorToCss({
      r:  Math.round(ov.r  * dim * mDim),
      g:  Math.round(ov.g  * dim * mDim),
      b:  Math.round(ov.b  * dim * mDim),
      w:  Math.round(ov.w  * dim * mDim),
      a:  Math.round((ov.a  || 0) * dim * mDim),
      uv: Math.round((ov.uv || 0) * dim * mDim),
    });
  }

  // Read DMX snapshot through the fixture's profile channel map. The snapshot
  // is keyed by universe, so pick out the one this fixture lives on.
  const base = fix.address - 1;
  const all = dmxSnapshot || state.dmxSnapshot || {};
  const snap = all[fix.universe ?? 0] || [];
  const profile = state.profiles && state.profiles[fix.profileId];
  if (!profile || !profile.channelMap) return '#111';

  const ch = profile.channelMap;
  const dimCh = ch.dimmer !== undefined ? ch.dimmer : -1;
  const dimScale = dimCh >= 0 && base + dimCh < snap.length ? snap[base + dimCh] / 255 : 1;
  const get = (attr) => (ch[attr] !== undefined && base + ch[attr] < snap.length ? snap[base + ch[attr]] : 0);
  return colorToCss({
    r:  Math.round(get('red')   * dimScale),
    g:  Math.round(get('green') * dimScale),
    b:  Math.round(get('blue')  * dimScale),
    w:  Math.round(get('white') * dimScale),
    a:  Math.round(get('amber') * dimScale),
    uv: Math.round(get('uv')    * dimScale),
  });
}
