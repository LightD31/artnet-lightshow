import { HardwareFit } from './HardwareFit.jsx';
import { ADMISSION_LABELS } from './setup/Hardware.jsx';
import { gradientSettings } from './GradientEditor.jsx';
import { useMemo, useState } from 'preact/hooks';
import { api, librarySig, patchLibrary, pick } from '../state.js';
import { PaletteEditor, isHexColour, normaliseHex, pickerValue } from './PaletteEditor.jsx';
import { parseHex, toHex, HEX_COLOUR } from '../../src/shared/palette-model.ts';
import { FieldInput } from './setup/FieldInput.jsx';

/**
 * The preset picked in the Effects list, with every setting its family can
 * use. A built-in is read-only until "Save as…" copies it to a preset of your
 * own; a preset of your own saves in place. Settings are what the shared
 * effect schemas take (src/shared/effects): Hue Dynamics' times in beats, with
 * the app's ticks read beside them.
 */

const TICKS_PER_BEAT = 960;
const CURVES = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'cut'];
const DIRECTIONS = ['forward', 'reverse', 'alternate', 'random'];
const ORDERS = ['position', 'track', 'random'];
const TRIGGER_MODES = { timeline: 'Timeline', beatAccent: 'Beat accent', volumeGate: 'Volume gate' };
const BANDS = ['full', 'bass', 'mid', 'high'];
const VISUALIZER_ACTIVE = ['splotch', 'firework', 'pulse', 'flash', 'mix'];
const VISUALIZER_MELLOW = ['swirl', 'wave', 'solid', 'none'];
const DISCO_STYLES = ['spectrum', 'peak', 'neural'];
const DISCO_BANDS = ['bass', 'voice', 'treble'];
const DISCO_CHANNELS = ['Bass', 'Voice', 'Treble', 'Peak', 'Neural'];
const DISCO_CHANNEL_FIELDS = [
  ['enabled', 'On', 'check'], ['fade', 'Fade', 'check'], ['allowPulse', 'Pulse', 'check'],
  ['minHue', 'Min hue', 65535], ['maxHue', 'Max hue', 65535], ['fadeBrightness', 'Fade bri', 254], ['fadeSaturation', 'Fade sat', 255],
  ['idleFadeBrightness', 'Idle bri', 254], ['sequenceLength', 'Seq', 64],
  ['strobeOn', 'Strobe', 'check'], ['linkLights', 'Link', 'check'], ['modulateSaturation', 'Mod sat', 'check'],
];
const DISCO_GLOBALS = [
  ['sensitivity', 'Sensitivity'], ['advancedDecay', 'Decay'], ['smoothness', 'Smoothness'], ['minimumThreshold', 'Min threshold'],
  ['simpleSensitivity', 'Simple sensitivity'], ['simpleDecay', 'Simple decay'], ['simpleMinimumThreshold', 'Simple threshold'],
  ['analyserSensitivity', 'Analyser sensitivity'], ['smoothnessAnalyser', 'Analyser smoothing'],
];
const AHDSR = [['attack', 'A'], ['hold', 'H'], ['decay', 'D'], ['sustain', 'S'], ['release', 'R'], ['peak', 'Peak']];

// Hue Dynamics asks once whether a family change takes the family's
// recommendation; the answer may be kept, on this browser.
const RECOMMENDED_KEY = 'lightshow.effects.recommended';
const PREFERENCES = ['ask', 'apply', 'keep'];
export function readRecommendedPreference() {
  try {
    const value = localStorage.getItem(RECOMMENDED_KEY);
    return PREFERENCES.includes(value) ? value : 'ask';
  } catch {
    return 'ask';
  }
}
export function writeRecommendedPreference(value) {
  try { localStorage.setItem(RECOMMENDED_KEY, value); } catch { /* private mode */ }
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const words = (name) => name.replace(/([a-z])(?=[A-Z])/g, '$1 ').replace(/^./, (c) => c.toUpperCase());
function setPath(obj, path, value) {
  const keys = path.split('.');
  const out = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur = out;
  for (const k of keys.slice(0, -1)) {
    cur[k] = Array.isArray(cur[k]) ? [...cur[k]] : { ...(cur[k] || {}) };
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return out;
}
const fid = (path) => `insp-${path.replace(/[^a-z0-9]+/gi, '-')}`;

/** The preset an id names: one saved here, a built-in (by id or alias), or a pattern row with no spec. */
export function findPreset(id, lib, patterns = []) {
  const user = lib.user.find((p) => p.id === id);
  if (user) return { source: 'user', ...user };
  const builtin = lib.builtin.find((p) => p.id === id || (p.aliases || []).includes(id));
  if (builtin) return { source: 'builtin', ...builtin };
  const row = patterns.find((p) => p.id === id);
  return row ? { source: 'pattern', ...row } : null;
}

/** The family whose kinds include this one. */
export function familyOf(kind, families = []) {
  return families.find((f) => f.kinds.some((k) => k.kind === kind)) || null;
}
export function kindDef(kind, families = []) {
  for (const f of families) {
    const k = f.kinds.find((x) => x.kind === kind);
    if (k) return k;
  }
  return null;
}

/** Hue Dynamics' loop for a preset that set none: a beat for a single-beat preset, else the bar or the envelope, whichever is longer. */
export function scopedLoopLength(spec) {
  const p = spec.params || {};
  if (spec.scope === 'singleBeat') return 1;
  return Math.max(4, (p.attack || 0) + (p.hold || 0) + (p.release || 0));
}

/** The spec on a kind's recommendation: its params and the output settings that travel with them. */
export function withRecommended(spec, def) {
  const d = def.defaults || {};
  const carried = {};
  for (const key of ['brightness', 'rapidFlash', 'minFlashIntervalMs', 'scope', 'palette']) {
    if (d[key] !== undefined) carried[key] = clone(d[key]);
  }
  return { ...spec, ...(spec.gradients || d.gradients ? gradientSettings(d) : {}), kind: def.kind, params: clone(d.params) || {}, ...carried };
}

// Light DJ's backlit rows are kinds of their own (BL…): a row with a twin gets
// the switch, whichever family each of the two sits in.
function backlitTwin(kind, families) {
  const match = /^ldj\.(BL)?(.+)$/.exec(kind);
  if (!match) return null;
  const plain = `ldj.${match[2]}`, backlit = `ldj.BL${match[2]}`;
  const all = families.flatMap((f) => f.kinds.map((k) => k.kind));
  return all.includes(plain) && all.includes(backlit) ? { plain, backlit, on: !!match[1] } : null;
}

const upsertUser = (preset) => patchLibrary((lib) => ({ ...lib, user: [...lib.user.filter((p) => p.id !== preset.id), preset] }));

/** A copy of a built-in (POST), or a preset of your own in place (PUT); the page's library takes the answer at once. */
export async function savePreset(target, { name, spec }) {
  const body = JSON.stringify({ name, spec });
  const res = target.source === 'user'
    ? await api(`/api/effects/${encodeURIComponent(target.id)}`, { method: 'PUT', body })
    : await api('/api/effects', { method: 'POST', body });
  if (res.ok && res.preset) upsertUser(res.preset);
  return res;
}

export async function deletePreset(id) {
  const res = await api(`/api/effects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.ok) patchLibrary((lib) => ({ ...lib, user: lib.user.filter((p) => p.id !== id) }));
  return res;
}

// ── Controls ────────────────────────────────────────────────────────────────

function Field({ label, path, unit, children }) {
  return (
    <div class="insp-field">
      <label for={fid(path)}>{label}</label>
      {children}
      {unit !== undefined && <span class="insp-unit">{unit}</span>}
    </div>
  );
}

/** A number the schema bounds; an emptied field is null where the schema allows it, else left alone. */
function NumberField({ label, path, value, onChange, step = 1, min, max, unit, nullable = false, placeholder }) {
  // The typed text stays while the field is edited; the stored, clamped value shows on blur.
  const [text, setText] = useState(null);
  const onInput = (e) => {
    setText(e.target.value);
    if (e.target.value === '') { if (nullable) onChange(null); return; }
    const n = Number(e.target.value);
    if (Number.isFinite(n)) onChange(n);
  };
  return (
    <Field label={label} path={path} unit={unit}>
      <input id={fid(path)} type="number" value={text ?? value ?? ''} step={step} min={min} max={max} placeholder={placeholder}
        onInput={onInput} onBlur={() => setText(null)} onKeyDown={(e) => { if (e.key === 'Enter') setText(null); }} />
    </Field>
  );
}

const ticks = (beats) => `${Math.round((beats || 0) * TICKS_PER_BEAT)} ticks`;
function BeatsField(props) {
  return <NumberField {...props} step={1 / 16} min={0} unit={ticks(props.value)} />;
}

function UnitField({ label, path, value, onChange, digits = 2 }) {
  return (
    <Field label={label} path={path} unit={(value ?? 0).toFixed(digits)}>
      <input id={fid(path)} type="range" min={0} max={1} step={0.01} value={value ?? 0} onInput={(e) => onChange(Number(e.target.value))} />
    </Field>
  );
}

function SelectField({ label, path, value, onChange, options }) {
  const entries = Array.isArray(options) ? options.map((o) => [o, words(o)]) : Object.entries(options);
  return (
    <Field label={label} path={path}>
      <select id={fid(path)} value={value} onChange={(e) => onChange(e.target.value)}>
        {entries.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </Field>
  );
}

function CheckField({ label, path, value, onChange }) {
  return (
    <label class="insp-check">
      <input id={fid(path)} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

const Section = ({ title }) => <div class="insp-section-title">{title}</div>;

export function SingleColourField({ value = '#FFFFFF', onChange }) {
  const colour = parseHex(value);
  return <Field label="Single colour" path="rgbEnvelope.singleColour">
    <div class="palette-entry">
      <input type="color" aria-label="Single colour RGB picker" value={pickerValue(value)}
        onInput={(e) => onChange(normaliseHex(e.target.value) + normaliseHex(value).slice(7))} />
      <FieldInput id={fid('rgbEnvelope.singleColour')} class="palette-hex" value={value} maxLength={13} spellcheck={false}
        pattern={HEX_COLOUR.source.replaceAll('a-f', 'a-fA-F')} title="Hex colour: RGB, RGBW, RGBWA or RGBWAUV"
        onCommit={(next) => { if (isHexColour(next)) onChange(normaliseHex(next)); }} />
      <details class="palette-emitters"><summary>W / A / UV</summary>
        {['w', 'a', 'uv'].map((die) => <label key={die}>{die.toUpperCase()}
          <FieldInput type="number" min="0" max="255" step="1" aria-label={`Single colour ${die.toUpperCase()}`} value={colour[die]}
            onCommit={(next) => { if (Number.isInteger(next) && next >= 0 && next <= 255) onChange(toHex({ ...colour, [die]: next })); }} />
        </label>)}
      </details>
    </div>
  </Field>;
}

// ── Families ────────────────────────────────────────────────────────────────

/** Hue Dynamics Party: what the family's capabilities allow, nothing else. */
function HdControls({ spec, caps, setParam }) {
  const p = spec.params || {};
  const sp = p.spatial || {}, tr = p.trigger || {};
  const loopDefault = scopedLoopLength(spec);
  return <>
    <div class="insp-grid">
      {caps.curve && <SelectField label="Curve" path="curve" value={p.curve} options={CURVES} onChange={(v) => setParam('curve', v)} />}
      {caps.attack && <BeatsField label="Attack" path="attack" value={p.attack} onChange={(v) => setParam('attack', v)} />}
      {caps.hold && <BeatsField label="Hold" path="hold" value={p.hold} onChange={(v) => setParam('hold', v)} />}
      {caps.release && <BeatsField label="Release" path="release" value={p.release} onChange={(v) => setParam('release', v)} />}
      {caps.stagger && <BeatsField label="Stagger" path="stagger" value={p.stagger} onChange={(v) => setParam('stagger', v)} />}
      {caps.trail && <BeatsField label="Trail" path="trail" value={p.trail} onChange={(v) => setParam('trail', v)} />}
      {caps.direction && <SelectField label="Direction" path="direction" value={p.direction} options={DIRECTIONS} onChange={(v) => setParam('direction', v)} />}
      {caps.order && <SelectField label="Order" path="order" value={p.order} options={ORDERS} onChange={(v) => setParam('order', v)} />}
      {caps.probability && <UnitField label="Probability" path="probability" value={p.probability} onChange={(v) => setParam('probability', v)} />}
      {caps.repetitions && <NumberField label="Repetitions" path="repetitions" value={p.repetitions} min={1} onChange={(v) => setParam('repetitions', Math.max(1, Math.round(v)))} />}
      {caps.loopLength && (
        <NumberField label="Loop length" path="loopLength" value={p.loopLength} step={1 / 16} min={1 / 16} nullable
          placeholder={String(loopDefault)} unit={`default ${loopDefault} beat${loopDefault === 1 ? '' : 's'}`}
          onChange={(v) => setParam('loopLength', v)} />
      )}
    </div>
    {caps.spatial && <>
      <Section title="Space" />
      <div class="insp-grid">
        {caps['spatial.x'] && <UnitField label="Origin x" path="spatial.x" value={sp.x} onChange={(v) => setParam('spatial.x', v)} />}
        {caps['spatial.y'] && <UnitField label="Origin y" path="spatial.y" value={sp.y} onChange={(v) => setParam('spatial.y', v)} />}
        {caps['spatial.z'] && <UnitField label="Origin z" path="spatial.z" value={sp.z} onChange={(v) => setParam('spatial.z', v)} />}
        {caps['spatial.radius'] && <UnitField label="Radius" path="spatial.radius" value={sp.radius} onChange={(v) => setParam('spatial.radius', v)} />}
        {caps['spatial.angle'] && <NumberField label="Angle" path="spatial.angle" value={sp.angle} step={1} unit="degrees" onChange={(v) => setParam('spatial.angle', v)} />}
      </div>
    </>}
    {caps.trigger && <>
      <Section title="Trigger" />
      <div class="insp-grid">
        {caps['trigger.mode'] && <SelectField label="Mode" path="trigger.mode" value={tr.mode} options={TRIGGER_MODES} onChange={(v) => setParam('trigger.mode', v)} />}
        {caps['trigger.band'] && <SelectField label="Band" path="trigger.band" value={tr.band} options={BANDS} onChange={(v) => setParam('trigger.band', v)} />}
        {caps['trigger.beatInterval'] && <BeatsField label="Beat interval" path="trigger.beatInterval" value={tr.beatInterval} onChange={(v) => setParam('trigger.beatInterval', Math.max(1 / TICKS_PER_BEAT, v))} />}
        {caps['trigger.threshold'] && <UnitField label="Threshold" path="trigger.threshold" value={tr.threshold} onChange={(v) => setParam('trigger.threshold', v)} />}
        {caps['trigger.reactiveDepth'] && <UnitField label="Reactive depth" path="trigger.reactiveDepth" value={tr.reactiveDepth} onChange={(v) => setParam('trigger.reactiveDepth', v)} />}
      </div>
    </>}
    {caps.rgbEnvelope && <RgbEnvelope env={p.rgbEnvelope} setParam={setParam} />}
  </>;
}

/** Simple ADSR's per-channel envelope: times as fractions of the loop, levels 0..1. */
function RgbEnvelope({ env, setParam }) {
  if (!env) return null;
  return <>
    <Section title="Envelope" />
    <div class="insp-grid">
      <SelectField label="Colour mode" path="rgbEnvelope.colourMode" value={env.colourMode} options={{ all: 'All channels', singleColour: 'Single colour' }}
        onChange={(v) => setParam('rgbEnvelope.colourMode', v)} />
      {env.colourMode === 'singleColour' && (
        <SingleColourField value={env.singleColour || '#FFFFFF'} onChange={(value) => setParam('rgbEnvelope.singleColour', value)} />
      )}
    </div>
    <div class="insp-table-wrap">
      <table class="insp-table">
        <thead><tr><th>Channel</th>{AHDSR.map(([, h]) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {['r', 'g', 'b', 'brightness'].map((ch) => (
            <tr key={ch}>
              <th>{ch === 'brightness' ? 'Brightness' : ch.toUpperCase()}</th>
              {AHDSR.map(([key, h]) => (
                <td key={key}>
                  <input type="number" min={0} max={1} step={0.01} aria-label={`${ch} ${h}`} value={env[ch]?.[key] ?? (key === 'peak' ? 1 : 0)}
                    onInput={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setParam(`rgbEnvelope.${ch}.${key}`, Math.min(1, Math.max(0, n))); }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </>;
}

/**
 * A row on a wall-clock step ignores params.cadence; the catalogue marks
 * such a kind `wallClock: true`.
 */
export function showsCadence(spec, families) {
  return kindDef(spec.kind, families)?.wallClock !== true;
}

/** A Light DJ row: its step, its length, and Backlit where the row has a backlit twin. */
function LdjControls({ spec, families, setParam, setKind }) {
  const p = spec.params || {};
  const twin = backlitTwin(spec.kind, families);
  return (
    <div class="insp-grid">
      {showsCadence(spec, families) && <NumberField label="Cadence" path="cadence" value={p.cadence} step={0.125} min={0.125} unit="beats a step" onChange={(v) => setParam('cadence', Math.max(0.125, v))} />}
      <NumberField label="Beats" path="beats" value={p.beats} step={1} min={1} unit="row length" onChange={(v) => setParam('beats', Math.max(1, v))} />
      {twin && <CheckField label="Backlit" path="backlit" value={twin.on} onChange={(on) => setKind(on ? twin.backlit : twin.plain)} />}
    </div>
  );
}

function VisualizerControls({ spec, setParam }) {
  const p = spec.params || {};
  return (
    <div class="insp-grid">
      <SelectField label="Active" path="active" value={p.active} options={VISUALIZER_ACTIVE} onChange={(v) => setParam('active', v)} />
      <SelectField label="Mellow" path="mellow" value={p.mellow} options={VISUALIZER_MELLOW} onChange={(v) => setParam('mellow', v)} />
      <UnitField label="Trigger" path="trigger" value={p.trigger} onChange={(v) => setParam('trigger', v)} />
      <CheckField label="Auto colours" path="autoColours" value={p.autoColours} onChange={(v) => setParam('autoColours', v)} />
    </div>
  );
}

/** The bitmap engine's one setting: which picture, from the rows the catalogue lists. */
function BitmapControls({ spec, lib, setParam }) {
  const patterns = lib.builtin.flatMap((row) => (row.spec && row.spec.kind === 'ldj.bitmap' ? [row.spec.params.pattern] : []));
  const options = Object.fromEntries(patterns.map((id) => [id, words(id)]));
  return (
    <div class="insp-grid">
      <SelectField label="Pattern" path="pattern" value={spec.params?.pattern} options={options} onChange={(v) => setParam('pattern', v)} />
    </div>
  );
}

/** Hue Dynamics Disco: the style, its five channels, the bands and globals, and a band per fixture. */
function DiscoControls({ spec, fixtures, setParam }) {
  const p = spec.params || {};
  const bands = p.bands || {}, globals = p.globals || {}, assign = p.assign || {};
  const assignFixture = (id, band) => {
    const next = { ...assign };
    if (band) next[id] = band; else delete next[id];
    setParam('assign', next);
  };
  return <>
    <div class="insp-grid">
      <SelectField label="Style" path="style" value={p.style} options={DISCO_STYLES} onChange={(v) => setParam('style', v)} />
      <CheckField label="Automatic strobe" path="allowStrobe" value={p.allowStrobe} onChange={(v) => setParam('allowStrobe', v)} />
    </div>
    <Section title="Channels" />
    <div class="insp-table-wrap">
      <table class="insp-table">
        <thead><tr><th>Channel</th>{DISCO_CHANNEL_FIELDS.map(([key, head]) => <th key={key}>{head}</th>)}</tr></thead>
        <tbody>
          {(p.channels || []).map((channel, i) => (
            <tr key={i}>
              <th>{DISCO_CHANNELS[i] || `Channel ${i + 1}`}</th>
              {DISCO_CHANNEL_FIELDS.map(([key, head, max]) => (
                <td key={key}>
                  {max === 'check'
                    ? <input type="checkbox" aria-label={`${DISCO_CHANNELS[i]} ${head}`} checked={!!channel[key]} onChange={(e) => setParam(`channels.${i}.${key}`, e.target.checked)} />
                    : <input type="number" aria-label={`${DISCO_CHANNELS[i]} ${head}`} min={0} max={max} step={1} value={channel[key]}
                      onInput={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setParam(`channels.${i}.${key}`, Math.round(n)); }} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <Section title="Bands" />
    <div class="insp-grid">
      {DISCO_BANDS.map((band) => (
        <div key={band} class="insp-field">
          <label for={fid(`bands.${band}.0`)}>{words(band)}</label>
          <div class="insp-pair">
            <input id={fid(`bands.${band}.0`)} type="number" min={0} step={10} aria-label={`${words(band)} low Hz`} value={(bands[band] || [])[0]}
              onInput={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setParam(`bands.${band}.0`, n); }} />
            <input type="number" min={0} step={10} aria-label={`${words(band)} high Hz`} value={(bands[band] || [])[1]}
              onInput={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setParam(`bands.${band}.1`, n); }} />
          </div>
          <span class="insp-unit">Hz</span>
        </div>
      ))}
    </div>
    <Section title="Globals" />
    <div class="insp-grid">
      {DISCO_GLOBALS.map(([key, label]) => (
        <NumberField key={key} label={label} path={`globals.${key}`} value={globals[key]} min={0} onChange={(v) => setParam(`globals.${key}`, Math.max(0, v))} />
      ))}
    </div>
    {fixtures.length > 0 && <>
      <Section title="Band per fixture" />
      <div class="insp-grid">
        {fixtures.map((f) => (
          <SelectField key={f.id} label={f.name || `Fixture ${f.id}`} path={`assign.${f.id}`} value={assign[String(f.id)] || ''}
            options={{ '': 'Automatic', bass: 'Bass', voice: 'Voice', treble: 'Treble' }} onChange={(v) => assignFixture(String(f.id), v)} />
        ))}
      </div>
    </>}
  </>;
}

function ParamControls({ spec, caps, families, lib, fixtures, setParam, setKind }) {
  const { kind } = spec;
  if (kind === 'hd.disco') return <DiscoControls spec={spec} fixtures={fixtures} setParam={setParam} />;
  if (kind.startsWith('hd.')) return <HdControls spec={spec} caps={caps} setParam={setParam} />;
  if (kind === 'ldj.visualizer') return <VisualizerControls spec={spec} setParam={setParam} />;
  if (kind === 'ldj.bitmap') return <BitmapControls spec={spec} lib={lib} setParam={setParam} />;
  if (kind.startsWith('ldj.') && kind !== 'macro' && spec.params && 'cadence' in spec.params) {
    return <LdjControls spec={spec} families={families} setParam={setParam} setKind={setKind} />;
  }
  // The Scene Maker's macros, the energy kinds and the strobe: read here, set elsewhere.
  const params = spec.params || {};
  return Object.keys(params).length
    ? <pre class="insp-raw">{JSON.stringify(params, null, 1)}</pre>
    : <p class="effect-inspector-desc">This effect has no settings of its own.</p>;
}

// ── The card ────────────────────────────────────────────────────────────────

export function Inspector({ id, onSelect, onPlay, onClose }) {
  const s = pick(['families', 'patterns', 'fixtures', 'pattern']);
  const lib = librarySig.value;
  const families = s.families || lib.families || [];
  const preset = id ? findPreset(id, lib, s.patterns || []) : null;
  // The draft follows the preset: a new id or a save from anywhere starts it afresh.
  const key = preset ? `${preset.source}:${preset.id}:${preset.updatedAt || ''}` : null;
  const base = useMemo(() => (preset && preset.spec ? { name: preset.name, spec: clone(preset.spec) } : null), [key]);
  const [edits, setEdits] = useState({ key: null, draft: null });
  const [naming, setNaming] = useState(false);
  const [copyName, setCopyName] = useState('');
  const [ask, setAsk] = useState(null);
  const [remember, setRemember] = useState(false);
  const [preference, setPreference] = useState(readRecommendedPreference);
  const [paletteInvalid, setPaletteInvalid] = useState(false);
  // Bumped by Revert, Apply recommended and a family change: the palette editor starts afresh.
  const [paletteEpoch, setPaletteEpoch] = useState(0);
  const draft = edits.key === key && edits.draft ? edits.draft : base;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(base);
  const update = (fn) => setEdits({ key, draft: fn(draft) });

  const title = (
    <div class="card-title">
      <span class="effect-inspector-title">Inspector</span>
      {onClose && <button type="button" class="btn xs" aria-label="Close the inspector" onClick={onClose}>Close</button>}
    </div>
  );
  if (!preset) {
    return (
      <div class="card effect-inspector">
        {title}
        <p class="effect-inspector-desc">{id && lib.status !== 'ready' ? 'Loading the effect library…' : id ? 'No such effect.' : 'Pick an effect to edit.'}</p>
      </div>
    );
  }
  if (!draft) {
    // A pattern row: one of the upstream patterns or the fork's own looks, drawn by its own code.
    const modelled = preset.preset ? findPreset(preset.preset, lib) : null;
    return (
      <div class="card effect-inspector">
        {title}
        <div class="effect-inspector-head"><strong>{preset.name}</strong></div>
        {preset.desc && <p class="effect-inspector-desc">{preset.desc}</p>}
        <p class="effect-inspector-desc">This classic effect has no editable settings.</p>
        {modelled && onSelect && (
          <button type="button" class="btn sm" onClick={() => onSelect(modelled.id)}>Open {modelled.name}, the preset it was modelled on</button>
        )}
      </div>
    );
  }

  const { spec } = draft;
  const family = familyOf(spec.kind, families);
  const app = family?.app || preset.app;
  const siblings = families.filter((f) => f.app === app && f.kinds.length);
  const def = kindDef(spec.kind, families);
  const caps = def?.capabilities || {};
  const setSpec = (field, value) => update((d) => ({ ...d, spec: { ...d.spec, [field]: value } }));
  const setParam = (path, value) => update((d) => ({ ...d, spec: { ...d.spec, params: setPath(d.spec.params || {}, path, value) } }));
  const setKind = (kind) => setSpec('kind', kind);
  const freshPalette = () => setPaletteEpoch((n) => n + 1);
  const applyRecommended = (target = def) => { if (target) { freshPalette(); update((d) => ({ ...d, spec: withRecommended(d.spec, target) })); } };

  const switchTo = (fam, how) => {
    const next = fam.kinds[0];
    freshPalette();
    if (how === 'apply') applyRecommended(next); else setKind(next.kind);
    setAsk(null);
  };
  const onFamily = (e) => {
    const fam = siblings.find((f) => f.id === e.target.value);
    if (!fam || fam === family) return;
    if (preference === 'ask') setAsk(fam); else switchTo(fam, preference);
  };
  const choosePreference = (how) => {
    writeRecommendedPreference(how);
    setPreference(how);
  };
  const answer = (how) => {
    if (remember) choosePreference(how);
    switchTo(ask, how);
  };

  const saveInPlace = async () => {
    if (paletteInvalid) return;
    const res = await savePreset(preset, draft);
    if (res.ok) setEdits({ key: null, draft: null });
  };
  const saveCopy = async () => {
    const name = copyName.trim();
    if (!name || paletteInvalid) return;
    const res = await savePreset({ source: 'builtin' }, { name, spec: draft.spec });
    if (!res.ok) return;
    setNaming(false);
    setCopyName('');
    setEdits({ key: null, draft: null });
    if (onSelect) onSelect(res.preset.id);
  };
  const remove = async () => {
    const res = await deletePreset(preset.id);
    if (res.ok && onSelect) onSelect(null);
  };

  const playing = s.pattern === preset.id;
  const palettes = lib.palettes || { builtin: [], user: [] };
  return (
    <div class="card effect-inspector">
      {title}
      <div class="effect-inspector-head">
        <strong>{preset.name}</strong>
        {preset.source === 'builtin' && <span class="setting-badge">Built-in</span>}
        {preset.source === 'user' && <span class="setting-badge">Yours</span>}
        {spec.rapidFlash && <span class="setting-badge pending">Rapid flash</span>}
        {playing && <span class="setting-badge">On stage</span>}
        {dirty && <span class="insp-dirty">Changed</span>}
      </div>
      {preset.desc && <p class="effect-inspector-desc">{preset.desc}</p>}

      <div class="insp-grid">
        <Field label="Name" path="name">
          <input id={fid('name')} type="text" value={draft.name} maxLength={80} onInput={(e) => update((d) => ({ ...d, name: e.target.value }))} />
        </Field>
        {siblings.length > 0 && (
          <Field label="Family" path="family">
            <select id={fid('family')} value={family?.id || ''} onChange={onFamily}>
              {!family && <option value="">{spec.kind}</option>}
              {siblings.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
        )}
        {siblings.length > 1 && (
          <SelectField label="On a family change" path="recommended" value={preference} onChange={choosePreference}
            options={{ ask: 'Ask', apply: 'Apply recommended', keep: 'Keep mine' }} />
        )}
        <UnitField label="Brightness" path="brightness" value={spec.brightness ?? 1} onChange={(v) => setSpec('brightness', v)} />
        <HardwareFit spec={spec} />
        <SelectField label="When hardware cannot follow" path="admission" value={spec.admission || 'max'} options={ADMISSION_LABELS}
          onChange={(v) => setSpec('admission', v)} />
        <SelectField label="Scope" path="scope" value={spec.scope || ''} options={{ '': 'Not set', singleBeat: 'Single beat', measure: 'Measure' }}
          onChange={(v) => setSpec('scope', v || undefined)} />
      </div>
      {ask && (
        <div class="insp-ask" role="group" aria-label="Recommended settings">
          <span>Switching to {ask.name}: apply its recommended settings, or keep yours?</span>
          <button type="button" class="btn sm" onClick={() => answer('apply')}>Apply recommended</button>
          <button type="button" class="btn sm" onClick={() => answer('keep')}>Keep mine</button>
          <label class="insp-check"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /><span>Remember</span></label>
        </div>
      )}

      <Section title="Settings" />
      <ParamControls spec={spec} caps={caps} families={families} lib={lib} fixtures={s.fixtures || []} setParam={setParam} setKind={setKind} />

      <Section title="Palette" />
      <label class="insp-check">
        <input type="checkbox" checked={spec.palette == null} onChange={(e) => setSpec('palette', e.target.checked ? null : (def?.defaults?.palette || ['#FFFFFF']))} />
        <span>The look's own colours</span>
      </label>
      {spec.palette != null && (
        <PaletteEditor key={paletteEpoch} body={{ colours: spec.palette, ...gradientSettings(spec) }} onBodyChange={({ colours, ...settings }) => update((d) => ({ ...d, spec: { ...d.spec, ...settings, palette: colours } }))} onInvalid={setPaletteInvalid} builtin={palettes.builtin} user={palettes.user} />
      )}

      <div class="insp-actions">
        {onPlay && !playing && <button type="button" class="btn sm" onClick={() => onPlay(preset.id)}>Play</button>}
        {preset.source === 'user' && <button type="button" class="btn sm" disabled={!dirty || paletteInvalid} onClick={saveInPlace}>Save</button>}
        {!naming && <button type="button" class="btn sm" onClick={() => { setNaming(true); setCopyName(`${draft.name} copy`); }}>Save as…</button>}
        {dirty && <button type="button" class="btn sm" onClick={() => { freshPalette(); setEdits({ key: null, draft: null }); }}>Revert</button>}
        {def && def.defaults && <button type="button" class="btn sm" title="The family's recommended settings, as the app ships them" onClick={() => applyRecommended()}>Apply recommended</button>}
        {preset.source === 'user' && <button type="button" class="btn sm danger" onClick={remove}>Delete</button>}
      </div>
      {naming && (
        <div class="cue-save-row">
          <input class="cue-name-input" aria-label="Preset name" placeholder="Preset name" value={copyName} autoFocus maxLength={80}
            onInput={(e) => setCopyName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') saveCopy(); if (e.key === 'Escape') { e.stopPropagation(); setNaming(false); } }} />
          <button type="button" class="btn sm" onClick={saveCopy} disabled={!copyName.trim() || paletteInvalid}>Save copy</button>
          <button type="button" class="btn sm" onClick={() => setNaming(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
