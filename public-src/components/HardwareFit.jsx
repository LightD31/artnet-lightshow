import { useEffect, useState } from 'preact/hooks';
import { pick, librarySig, api } from '../state.js';
import { resolverOf } from '../preview-inputs.js';
import { hardwareOf, maximumFlashHz } from '../../src/shared/hardware.ts';
import { effectAdmission } from '../../src/shared/effects/hardware.ts';
import { selectClips } from '../../src/shared/effects/sequence.ts';

const LABELS = { play: 'Full rate', slower: 'Adapted', hold: 'Holding', exclude: 'Excluded', unknown: 'Live phase unavailable' };

export function hardwareFitRows(s, { spec = null, table = null, library = null } = {}) {
  const fixtures = s.fixtures || [], ids = fixtures.map((f) => f.id);
  const base = spec || resolverOf(library?.user)(s.pattern);
  const effects = spec ? [{ id: 'preset', spec, label: 'Preset', beatPos: 0, anchorBeat: 0 }] : [
    ...(base && s.running !== false ? [{ id: 'base', spec: base, label: 'Base', beatPos: s.clock?.beatPos }] : []),
    ...(s.voices || []).filter((v) => v.spec && !v.hidden).map((v) => ({ ...v, label: v.label || v.spec.kind, beatPos: s.clock?.beatPos })),
  ];
  const sequence = !spec && s.sequence?.loaded && (s.sequence.playing || s.sequence.paused);
  if (sequence && table) {
    const { winners, active } = selectClips(table, s.sequence.beat, ids);
    for (const index of new Set(winners.filter((i) => i >= 0))) {
      const clip = table.clips[index], lap = active.find((a) => a.index === index);
      const label = s.sequence.activeClips?.find((c) => c.id === clip.id)?.name || clip.id;
      effects.push({ id: `sequence:${clip.id}`, spec: clip.spec, label: `Sequence · ${label}`,
        targets: ids.filter((_, k) => winners[k] === index), beatPos: s.sequence.beat,
        anchorBeat: s.sequence.paused ? undefined : lap?.lapStart });
    }
  }
  const rows = effects.flatMap((effect) => fixtures.filter((f) => !Array.isArray(effect.targets) || effect.targets.includes(f.id)).map((f) => {
    const caps = hardwareOf(f, s.profiles?.[f.profileId], s.hardware);
    // Missing launch phase must not masquerade as a container's first step.
    const unknown = effect.spec.kind === 'pattern.bundle' || effect.spec.kind === 'macro' && (!Number.isFinite(effect.beatPos) || !Number.isFinite(effect.anchorBeat));
    const decision = unknown ? { mode: 'unknown', ratio: 1, limitHz: maximumFlashHz(caps) }
      : effectAdmission(effect.spec, { bpm: s.clock?.bpm || s.bpm || 120, beatPos: effect.beatPos, anchorBeat: effect.anchorBeat, fixtureIds: [f.id] }, caps);
    return { key: `${effect.id}:${f.id}`, label: `${effect.label} · ${f.label}`, caps, ...decision };
  }));
  return { rows, incomplete: !!sequence && !table || rows.some((r) => r.mode === 'unknown') || !spec && s.running !== false && !base };
}

export function HardwareFit({ spec = null }) {
  const s = pick(['hardware', 'profiles', 'fixtures', 'bpm', 'voices', 'pattern', 'running', 'clock', 'sequence']);
  const [loaded, setLoaded] = useState(null);
  const id = spec ? null : s.sequence?.loaded?.id, revision = s.sequence?.revision;
  useEffect(() => {
    if (!id) return;
    let live = true;
    api('/api/sequence').then((r) => { if (live) setLoaded(r?.ok ? { id: r.status?.loaded?.id, revision: r.status?.revision, table: r.table } : null); });
    return () => { live = false; };
  }, [id, revision]);
  if (!s.hardware || !s.fixtures?.length) return null;
  const table = loaded?.id === id && loaded?.revision === revision ? loaded.table : null;
  const { rows, incomplete } = hardwareFitRows(s, { spec, table, library: librarySig.value });
  const changed = rows.filter((r) => r.mode !== 'play' && r.mode !== 'unknown');
  const summary = [changed.length ? `${changed.length} adaptations` : !incomplete && rows.length ? 'Full rate' : null, incomplete || !rows.length ? 'Some checks unavailable' : null].filter(Boolean).join(' · ');
  return <details class="hardware-fit card"><summary>Hardware fit · {summary}</summary>
    {rows.length ? <ul>{rows.map((r) => <li key={r.key}>{r.label}: <strong>{LABELS[r.mode]}</strong>
      {r.mode === 'slower' && r.ratio < 1 ? ` (${Math.round(r.ratio * 100)}% speed)` : ''} · {r.limitHz.toFixed(1)} Hz limit{r.caps.measured ? ', measured' : ', unverified'}
    </li>)}</ul> : <p class="setting-help">Fixture limits also apply to classic patterns. Select a preset to inspect its fit.</p>}
    {incomplete && <p class="setting-help">Live phase or sequence data is unavailable for some checks. Device limits still apply during playback.</p>}
    <p class="setting-help">RGB outputs approximate missing white, amber and UV with visible colour.{spec?.kind === 'macro' ? ' Preset inspection starts at the first step.' : ''}</p>
  </details>;
}
