import { useState } from 'preact/hooks';
import { api, librarySig, pick, send } from '../state.js';
import { parseHex, toHex } from '../../src/shared/palette-model.ts';
import { colorToCss } from '../utils.js';
import { PaletteEditor, isRandom, paletteName } from './PaletteEditor.jsx';

export const overrideBody = (palette) => ({ paletteId: palette.id });
export function activeOverride(override, palettes, id = null) {
  if (!override?.length) return 'off';
  if (id && palettes.some((p) => p.id === id)) return id;
  const want = override.map((c) => toHex(parseHex(c))).join();
  return palettes.find((p) => !p.colours.some(isRandom) && p.colours.map((c) => toHex(parseHex(c))).join() === want)?.id ?? null;
}

export function PaletteStrip({ initialTarget = 'override' }) {
  const s = pick(['palette', 'basePalette', 'paletteOverride', 'overridePalette', 'paletteOverrideId',
    'builtinPalettes', 'userPalettes', 'colorPresets', 'colorA', 'colorB', 'colorC', 'colorD', 'pattern']);
  const [target, setTarget] = useState(initialTarget);
  const [draft, setDraft] = useState(null);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState('');
  const [size, setSize] = useState(() => {
    try { const n = Number(localStorage.getItem('lightshow.paletteSize')); return [2, 3, 4].includes(n) ? n : 4; } catch { return 4; }
  });
  const lib = librarySig.value;
  const builtin = s.builtinPalettes || lib.palettes?.builtin || [];
  const user = s.userPalettes || lib.palettes?.user || [];
  const all = [...builtin, ...user];
  const override = target === 'override';
  const active = override ? activeOverride(s.paletteOverride, all, s.paletteOverrideId) : s.palette;
  const base = [...(lib.builtin || []), ...(lib.user || [])].find((p) => p.id === s.pattern);
  const reason = !override && (s.paletteOverride?.length ? 'Palette override controls the stage colours.'
    : base?.spec?.palette?.length ? 'This effect has its own palette. Select Override to recolour it.' : null);
  const current = override ? s.overridePalette || { colours: s.paletteOverride || ['#FFFFFF'] }
    : s.basePalette || { colours: ['colorA', 'colorB', 'colorC', 'colorD'].map((k) => toHex(s.colorPresets?.[s[k]] || { r: 255, g: 255, b: 255 })) };
  const choose = async (p) => {
    if (override) await api('/api/palette-override', { method: 'PUT', body: JSON.stringify(overrideBody(p)) });
    else send({ palette: p.id, paletteSize: size });
  };
  const apply = async () => {
    const result = await api('/api/set', { method: 'POST', body: JSON.stringify({ [override ? 'overridePalette' : 'basePalette']: draft }) });
    if (result.ok) { setDraft(null); setError(''); } else setError(result.error || 'Could not apply palette');
  };
  return <section class="palette-strip" aria-label={override ? 'Palette override' : 'Base palette'}>
    <div class="palette-tools">
      <span class="palette-title">Palette</span>
      <div class="segmented" role="group" aria-label="Palette destination">
        {['base', 'override'].map((t) => <button key={t} type="button" class={`segmented-btn ${target === t ? 'active' : ''}`}
          aria-pressed={target === t} onClick={() => { setTarget(t); setDraft(null); setError(''); }}>{t === 'base' ? 'Base' : 'Override'}</button>)}
      </div>
      {!override && <select aria-label="Classic palette size" value={size} onChange={(e) => {
        const n = Number(e.target.value); setSize(n);
        try { localStorage.setItem('lightshow.paletteSize', String(n)); } catch { /* private mode */ }
        if (builtin.some((p) => p.id === active && p.app === 'look')) send({ paletteSize: n });
      }}><option value="2">Classic duo</option><option value="3">Classic triad</option><option value="4">Classic tetrad</option></select>}
      <button type="button" class="btn sm" onClick={() => setDraft(JSON.parse(JSON.stringify(current)))}>Edit palette</button>
    </div>
    {reason && <p class="muted" role="status">{reason}</p>}
    <div class="perform-override">
      {override && <button type="button" class={`override-pad${active === 'off' ? ' active' : ''}`} aria-pressed={active === 'off'} data-override="off"
        onClick={() => api('/api/palette-override', { method: 'DELETE' })}><span class="override-name">Off</span></button>}
      {all.map((p) => <button key={p.id} type="button" class={`override-pad${active === p.id ? ' active' : ''}`}
        aria-pressed={active === p.id} data-override={override ? p.id : undefined} data-palette={p.id} onClick={() => choose(p)}>
        <span class="override-swatches" aria-hidden="true">{(override && active === p.id ? s.paletteOverride : p.colours).map((c, i) =>
          <span key={i} class={isRandom(c) ? 'random' : ''} style={isRandom(c) ? {} : { background: c.length <= 7 ? c : colorToCss(parseHex(c)) }} />)}</span>
        <span class="override-name">{paletteName(p)}</span>
      </button>)}
    </div>
    {override && all.some((p) => p.id === active && p.colours.some(isRandom)) && <p class="muted">Random colours held — tap again to reroll</p>}
    {draft && <div class="palette-draft">
      <PaletteEditor body={draft} onBodyChange={setDraft} onInvalid={setInvalid} builtin={builtin} user={user} />
      <button type="button" class="btn sm" disabled={invalid} onClick={apply}>Apply palette</button>
      <button type="button" class="btn sm" onClick={() => setDraft(null)}>Cancel</button>
      {error && <p role="alert">{error}</p>}
    </div>}
  </section>;
}
