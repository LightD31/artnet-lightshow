import { useState } from 'preact/hooks';
import { DEFAULT_HARDWARE, OUTPUT_TECHNOLOGIES, TECHNOLOGY_LIMITS, hardwareOf, technologyOf } from '../../../src/shared/hardware.ts';
import { FieldInput } from './FieldInput.jsx';
import { settingsSig, saveSettings, slugify } from '../../setup-state.js';

export const ADMISSION_LABELS = { max: 'Play at device maximum', hold: 'Hold a value', exclude: 'Exclude when unsupported' };

function Rates({ id, value, fallback, change }) {
  const field = (key, label, min, max, step) => <div class="setting-field">
    <label for={`${id}-${key}`}>{label}</label>
    <FieldInput id={`${id}-${key}`} type="number" min={min} max={max} step={step}
      value={value[key] ?? fallback[key]} onCommit={(v) => { if (Number.isFinite(v) && v >= min && v <= max) change({ ...value, [key]: v }); }} />
  </div>;
  return <div class="setting-rows">
    {field('maxFlashHz', 'Maximum flashes / second', .1, 100, .1)}
    {field('minTransitionMs', 'Minimum transition (ms)', 0, 10000, 1)}
    {field('verifiedFlashHz', 'Verified flashes / second', .1, 100, .1)}
    <div class="setting-field"><label for={`${id}-evidence`}>Measurement evidence</label>
      <FieldInput id={`${id}-evidence`} maxLength={500} value={value.evidence || ''} onCommit={(evidence) => change({ ...value, evidence })} /></div>
  </div>;
}

export function FixtureHardware({ fixture, profile, settings = DEFAULT_HARDWARE, send }) {
  const caps = hardwareOf(fixture, profile, settings);
  const inherited = hardwareOf({ ...fixture, hardware: null }, profile, settings);
  const products = Object.entries(settings.products).filter(([, p]) => p.technology === technologyOf(fixture, profile));
  return <details class="setup-section hardware-limits"><summary>Hardware capability · {caps.maxFlashHz} Hz · {caps.source}</summary>
    <p class="setting-help">{caps.pixels > 1 ? `${caps.pixels} pixels` : 'Single lamp'} · {caps.channels.map((c) => c.toUpperCase()).join(' / ') || 'No colour channels'}.
      {' '}{caps.measured ? 'Measured to the configured rate.' : 'Configured limit; not verified to this rate.'}</p>
    <div class="setting-field"><label for="insp-product">Product</label><select id="insp-product" value={fixture.productId || ''}
      onChange={(e) => send({ productId: e.target.value || null })}>
      <option value="">Profile default</option>
      {fixture.productId && !products.some(([id]) => id === fixture.productId) && <option value={fixture.productId}>{fixture.productId} (unavailable)</option>}
      {products.map(([id, p]) => <option key={id} value={id}>{p.name}</option>)}
    </select></div>
    <div class="setting-field"><label for="insp-admission">When unsupported</label><select id="insp-admission" value={fixture.admission || 'max'}
      onChange={(e) => send({ admission: e.target.value })}>
      {Object.entries(ADMISSION_LABELS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select></div>
    <Rates id="insp-hardware" value={fixture.hardware || {}} fallback={inherited} change={(hardware) => send({ hardware })} />
    {fixture.hardware && <button type="button" class="btn sm" onClick={() => send({ hardware: null })}>Use inherited limits</button>}
  </details>;
}

export function HardwareSettings() {
  const hardware = settingsSig.value?.settings?.hardware || DEFAULT_HARDWARE;
  const [name, setName] = useState(''), [technology, setTechnology] = useState('ddp'), [error, setError] = useState('');
  const save = async (next) => {
    const res = await saveSettings({ hardware: next });
    setError(res.ok ? '' : res.error || 'Could not save hardware settings');
    return res.ok;
  };
  const product = (id, value) => save({ ...hardware, products: { ...hardware.products, [id]: value } });
  const add = async (e) => {
    e.preventDefault();
    const id = slugify(name);
    if (!id || hardware.products[id]) { setError('Choose a unique product name.'); return; }
    if (await product(id, { name: name.trim(), technology, ...TECHNOLOGY_LIMITS[technology] })) setName('');
  };
  return <section class="panel setup-section hardware-limits" aria-labelledby="hardware-title">
    <header class="panel-head"><h2 class="panel-title" id="hardware-title">Hardware limits</h2></header>
    <p class="section-desc">Technology defaults, product limits, then individual fixture overrides. Limits slow playback; the fixture or preset can instead hold a value or exclude unsupported effects. Existing photosensitivity limits still apply.</p>
    {error && <p role="alert">{error}</p>}
    {OUTPUT_TECHNOLOGIES.map((tech) => <details key={tech}><summary>{tech.toUpperCase()} defaults</summary>
      <Rates id={`hardware-${tech}`} value={hardware.technologies[tech] || {}} fallback={TECHNOLOGY_LIMITS[tech]}
        change={(value) => save({ ...hardware, technologies: { ...hardware.technologies, [tech]: value } })} />
    </details>)}
    {Object.entries(hardware.products).map(([id, value]) => <details key={id}><summary>{value.name} · {value.technology.toUpperCase()}</summary>
      <Rates id={`product-${id}`} value={value} fallback={TECHNOLOGY_LIMITS[value.technology]} change={(v) => product(id, v)} />
      <button type="button" class="btn sm" onClick={() => { const products = { ...hardware.products }; delete products[id]; save({ ...hardware, products }); }}>Remove product limits</button>
    </details>)}
    <form onSubmit={add} class="setting-rows">
      <label for="hardware-product-name">New product name</label><input id="hardware-product-name" value={name} maxLength={80} required onInput={(e) => setName(e.target.value)} />
      <label for="hardware-product-tech">Output technology</label><select id="hardware-product-tech" value={technology} onChange={(e) => setTechnology(e.target.value)}>
        {OUTPUT_TECHNOLOGIES.map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
      </select><button class="btn sm" type="submit">Add product limits</button>
    </form>
  </section>;
}
