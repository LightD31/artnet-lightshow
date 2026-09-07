import { stateSig, dmxSig } from '../state.js';

function buildChannelLabels(s, universe) {
  const labels = {};
  if (!s.fixtures || !s.profiles) return labels;
  for (const fix of s.fixtures) {
    if ((fix.universe ?? 0) !== universe) continue;
    const profile = s.profiles[fix.profileId];
    if (!profile) continue;
    const base = fix.address - 1;
    for (const ch of (profile.channelList || [])) {
      const shortName = (ch.attribute || ch.name || '').substring(0, 3).toUpperCase();
      labels[base + ch.offset] = shortName || String(ch.offset + 1);
    }
  }
  return labels;
}

function UniverseGrid({ s, universe, values }) {
  const labels = buildChannelLabels(s, universe);
  return (
    <div class="dmx-universe">
      <div class="dmx-universe-label">Universe {universe}</div>
      {values.length === 0
        ? <div class="dmx-universe-empty">No fixtures patched — sending an empty frame.</div>
        : (
          <div class="dmx-monitor">
            {values.map((v, i) => (
              <div
                key={i}
                class={`dmx-cell ${v > 0 ? 'active' : ''}`}
                style={{ '--bar': `${(v / 255) * 100}%` }}
              >
                <span class="ch">{i + 1} {labels[i] || String((i % 12) + 1)}</span>
                <span class="val">{v}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

export function DmxMonitor() {
  const s = stateSig.value;
  const snap = dmxSig.value || {};
  // Object keys are strings on the wire; the fixture list holds numbers.
  const universes = Object.keys(snap).map(Number).sort((a, b) => a - b);

  return (
    <div class="card">
      <div class="card-title">DMX Monitor</div>
      {universes.map((u) => (
        <UniverseGrid key={u} s={s} universe={u} values={snap[u] || []} />
      ))}
    </div>
  );
}
