import { useState } from 'preact/hooks';
import { stateSig, autoPositionSig, autoTimelineSig, api, toast } from '../state.js';
import { fmtTime } from '../utils.js';
import { timelineKey, timelinePosition } from '../timeline-state.js';

/**
 * The operator's edits to the loaded track's show (src/show/overlay.ts): the
 * palette locked, a section's look swapped, accents added at the playhead or
 * taken away. They are kept with the track's analysis, so they come back
 * every time the track plays — whatever the intensity, the rig or the rest
 * of the night makes the show replan.
 */

const BURSTS = [
  ['color-strobe', 'Colour strobe'], ['white-strobe', 'White strobe'], ['blinder', 'Blinder'],
  ['uv-wash', 'UV wash'], ['kill', 'Kill'], ['glow', 'Glow'],
];
const SECTION_MATCH_MS = 2000;
const NEAR_ACCENT_MS = 1000;

function playheadMs(s) {
  const timeline = autoTimelineSig.value;
  const durationMs = timeline.key === timelineKey(s) ? timeline.data?.duration * 1000 : 0;
  return timelinePosition(autoPositionSig.value, performance.now(), durationMs);
}

/** Drop what is empty, so a cleared edit leaves nothing behind. */
function tidy(overlay) {
  const out = {};
  if (overlay.palette) out.palette = overlay.palette;
  if (overlay.sections?.length) out.sections = overlay.sections;
  const add = overlay.accents?.add || [];
  const remove = overlay.accents?.remove || [];
  if (add.length || remove.length) out.accents = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
  return out;
}

/** The look the plan opened a section on: its first scene with a pattern. */
function plannedLook(data, startMs) {
  const scene = (data?.timeline || []).find((ev) => ev.pattern && ev.timeMs >= startMs - SECTION_MATCH_MS
    && ev.timeMs < startMs + SECTION_MATCH_MS && String(ev.source || '').startsWith('section:'));
  return scene ? { pattern: scene.pattern, pixelPattern: scene.pixelPattern } : null;
}

/**
 * `at` says where "the playhead" is for adding and removing accents — the
 * show's live position unless a view that rehearses gives its own mark.
 */
export function TrackEdits({ at = null, atLabel = 'playhead' } = {}) {
  const s = stateSig.value;
  const as = s.autoShow || {};
  const [burst, setBurst] = useState('color-strobe');
  if (!as.analysis) return null;

  const overlay = as.overlay || {};
  const timeline = autoTimelineSig.value;
  const data = timeline.key === timelineKey(s) ? timeline.data : null;
  const patterns = s.patterns || [];
  const bars = !!as.pixels;
  const edits = overlay.sections || [];
  const added = overlay.accents?.add || [];
  const removed = overlay.accents?.remove || [];

  const save = (next) => api('/api/auto/overlay', { method: 'PUT', body: JSON.stringify(tidy(next)) });

  const setSection = (startMs, field, value) => {
    const others = edits.filter((e) => Math.abs(e.atMs - startMs) > SECTION_MATCH_MS);
    const current = edits.find((e) => Math.abs(e.atMs - startMs) <= SECTION_MATCH_MS) || { atMs: Math.round(startMs) };
    const next = { ...current };
    if (value === '') delete next[field];
    else next[field] = value === 'whole' ? null : value;
    const keep = next.pattern !== undefined || next.pixelPattern !== undefined;
    save({ ...overlay, sections: keep ? [...others, next].sort((a, b) => a.atMs - b.atMs) : others });
  };

  const addAccent = () => {
    const atMs = Math.round(at ? at() : playheadMs(s));
    save({ ...overlay, accents: { add: [...added, { atMs, burst }].sort((a, b) => a.atMs - b.atMs), remove: removed } });
  };

  const removeAccent = () => {
    const mark = at ? at() : playheadMs(s);
    const near = (data?.timeline || []).filter((ev) => ev.action === 'energy' && Math.abs(ev.timeMs - mark) <= NEAR_ACCENT_MS)
      .sort((a, b) => Math.abs(a.timeMs - mark) - Math.abs(b.timeMs - mark))[0];
    if (!near) { toast.error(`No accent within a second of the ${atLabel}`); return; }
    if (near.source === 'operator') {
      save({ ...overlay, accents: { add: added.filter((a) => Math.abs(a.atMs - near.timeMs) > 150), remove: removed } });
    } else {
      save({ ...overlay, accents: { add: added, remove: [...removed, near.timeMs].sort((a, b) => a - b) } });
    }
  };

  const sections = data?.segments || [];
  const any = overlay.palette || edits.length || added.length || removed.length;

  return (
    <section class="panel track-edits">
      <header class="panel-head">
        <h2 class="panel-title">Track edits</h2>
        {any ? <button type="button" class="btn sm" onClick={() => save({})}>Clear all</button> : null}
      </header>
      <p class="look-note">
        Kept with this track&rsquo;s analysis and put back every time it plays, whatever else makes the show replan.
      </p>

      <div class="look-row">
        <span class="look-label">Palette</span>
        <span class="look-hint">{as.paletteName || '—'}{overlay.palette ? ' (locked)' : ''}</span>
        {overlay.palette
          ? <button type="button" class="btn sm" onClick={() => save({ ...overlay, palette: null })}>Unlock</button>
          : <button type="button" class="btn sm" disabled={!as.paletteName} onClick={() => save({ ...overlay, palette: as.paletteName })}
            title="Keep this palette for this track, whatever the music or the rest of the night would choose">Lock</button>}
      </div>

      <div class="look-row">
        <span class="look-label">Accent</span>
        <select class="auto-select" value={burst} onChange={(e) => setBurst(e.target.value)} aria-label="Accent to add">
          {BURSTS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <button type="button" class="btn sm" onClick={addAccent} title={`Add this burst at the ${atLabel}`}>Add at {atLabel}</button>
        <button type="button" class="btn sm" onClick={removeAccent} title={`Take away the accent nearest the ${atLabel}`}>Remove nearest</button>
      </div>
      {(added.length > 0 || removed.length > 0) && (
        <ul class="edit-list">
          {added.map((a) => (
            <li key={`a${a.atMs}`}>
              {fmtTime(a.atMs)} · {BURSTS.find(([id]) => id === a.burst)?.[1] || a.burst} added
              <button type="button" class="btn xs" aria-label="Undo"
                onClick={() => save({ ...overlay, accents: { add: added.filter((x) => x !== a), remove: removed } })}>×</button>
            </li>
          ))}
          {removed.map((t) => (
            <li key={`r${t}`}>
              {fmtTime(t)} · accent taken away
              <button type="button" class="btn xs" aria-label="Restore"
                onClick={() => save({ ...overlay, accents: { add: added, remove: removed.filter((x) => x !== t) } })}>×</button>
            </li>
          ))}
        </ul>
      )}

      {sections.length > 0 && (
        <table class="edit-sections">
          <thead><tr><th>Section</th><th>{bars ? 'Pars' : 'Look'}</th>{bars && <th>Bars</th>}</tr></thead>
          <tbody>
            {sections.map((sec) => {
              const startMs = sec.start * 1000;
              const edit = edits.find((e) => Math.abs(e.atMs - startMs) <= SECTION_MATCH_MS) || {};
              const planned = plannedLook(data, startMs) || {};
              return (
                <tr key={startMs}>
                  <td>{fmtTime(startMs)} {sec.role || sec.label || ''}</td>
                  <td>
                    <select class="auto-select" value={edit.pattern || ''} aria-label={`Look for the ${sec.role || 'section'} at ${fmtTime(startMs)}`}
                      onChange={(e) => setSection(startMs, 'pattern', e.target.value)}>
                      <option value="">Show&rsquo;s choice{planned.pattern ? ` (${planned.pattern})` : ''}</option>
                      {patterns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>
                  {bars && (
                    <td>
                      <select class="auto-select" aria-label={`Bars for the ${sec.role || 'section'} at ${fmtTime(startMs)}`}
                        value={edit.pixelPattern === null ? 'whole' : edit.pixelPattern || ''}
                        onChange={(e) => setSection(startMs, 'pixelPattern', e.target.value)}>
                        <option value="">Show&rsquo;s choice{planned.pixelPattern ? ` (${planned.pixelPattern})` : ''}</option>
                        <option value="whole">Same as the pars</option>
                        {patterns.filter((p) => p.pixel).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
