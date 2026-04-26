import { stateSig } from '../state.js';

function buildChannelLabels(s) {
  const labels = {};
  if (!s.fixtures || !s.profiles) return labels;
  for (const fix of s.fixtures) {
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

export function DmxMonitor() {
  const s = stateSig.value;
  const snap = s.dmxSnapshot || [];
  const labels = buildChannelLabels(s);

  return (
    <div class="card">
      <div class="card-title">DMX Monitor</div>
      <div class="dmx-monitor">
        {snap.map((v, i) => (
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
    </div>
  );
}
