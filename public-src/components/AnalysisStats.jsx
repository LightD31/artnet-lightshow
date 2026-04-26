import { fmtPct, fmtNum, colorToCss } from '../utils.js';

const GENRE_COLORS = {
  edm: '#ff2fb2', dubstep: '#ff3b5f', trance: '#8f6bff', disco: '#ff6ecf',
  hiphop: '#ff9a3d', pop: '#ffcf57', funk: '#ff7c4a', rock: '#ff5d45',
  metal: '#9b4cff', country: '#d9a86b', reggae: '#38d67f', latin: '#ff6f3c',
  jazz: '#7f6dff', classical: '#7ec6ff', folk: '#b09068', ambient: '#52d6ff',
  unknown: '#8d8d9a',
};

export function AnalysisStats({ as, colorPresets }) {
  if (!as || !as.analysis) return null;
  const a = as.analysis;
  const blocks = [];

  // Genre badge — most prominent. Renders even when mood is missing so the
  // operator always sees the PANNs label when available.
  if (a.genre && a.genre.label) {
    const label = a.genre.label;
    const color = GENRE_COLORS[label] || '#888';
    const conf = a.genre.labelConf != null ? ` ${fmtPct(a.genre.labelConf)}` : '';
    const tags = (a.genre.topTags || []).filter((t) => !/^Music$/i.test(t.label)).slice(0, 3);
    blocks.push(
      <div class="auto-analysis-row tier-row">
        <span
          class="tier-badge"
          style={{ background: `${color}22`, color, borderColor: `${color}55` }}
          title={`PANNs AudioSet genre classifier (${label}${conf})`}
        >{label.toUpperCase()}{conf}</span>
        {tags.length > 0 && (
          <span class="dim">{tags.map((t) => `${t.label} ${fmtPct(t.p)}`).join(' · ')}</span>
        )}
      </div>
    );
  }

  // Palette swatches — the locked tetrad for this song.
  if (Array.isArray(as.palette) && as.palette.length && Array.isArray(colorPresets)) {
    blocks.push(
      <div class="auto-analysis-row palette-row">
        <span class="palette-label" title="The 4-colour tetrad the auto-show has locked this song into">Palette</span>
        <span class="palette-swatches">
          {as.palette.map((idx, i) => {
            const preset = colorPresets[idx];
            if (!preset) return null;
            const css = colorToCss(preset);
            const border = i === 0 ? { boxShadow: '0 0 0 1px #fff8 inset' } : {};
            return (
              <span
                key={`${idx}-${i}`}
                class="palette-swatch"
                style={{ background: css, ...border }}
                title={`${preset.name || 'color'} (#${idx})`}
              />
            );
          })}
        </span>
        {as.paletteName && (
          <span class="dim" title="Tetrad name — the song's locked 4-colour look">{as.paletteName}</span>
        )}
      </div>
    );
  }

  // Track basics
  blocks.push(
    <div class="auto-analysis-row">
      <span>BPM: <strong>{a.bpm}</strong></span>
      {a.tempoStability != null && (
        <span title="Tempo stability — 1.0 = locked, lower = drifting">
          Stability: <strong>{fmtPct(a.tempoStability)}</strong>
        </span>
      )}
      {a.beatSource && <span title="Beat tracking algorithm">Beat: <strong>{a.beatSource}</strong></span>}
      <span>Key: <strong>{a.key} {a.scale}</strong>{a.keyStrength != null && <span class="dim"> ({fmtNum(a.keyStrength)})</span>}</span>
      <span>Duration: <strong>{Math.round(a.duration)}s</strong></span>
    </div>
  );

  // Mood
  if (a.mood) {
    const m = a.mood;
    blocks.push(
      <div class="auto-analysis-row">
        <span title="Valence — happy/bright vs dark/sad">Valence: <strong>{fmtPct(m.valence)}</strong></span>
        <span title="Arousal — intense vs calm">Arousal: <strong>{fmtPct(m.arousal)}</strong></span>
        {m.loudness    != null && <span title="Loudness vs reference">Loud: <strong>{fmtPct(m.loudness)}</strong></span>}
        {m.brightness  != null && <span title="Spectral brightness">Bright: <strong>{fmtPct(m.brightness)}</strong></span>}
        {m.danceability != null && <span title="Danceability — pulse steadiness">Dance: <strong>{fmtPct(m.danceability)}</strong></span>}
        {m.kickiness    != null && <span title="Kick-band median energy">Kick: <strong>{fmtPct(m.kickiness)}</strong></span>}
      </div>
    );
  }

  // Structure
  blocks.push(
    <div class="auto-analysis-row">
      <span>Segments: <strong>{a.segmentCount}</strong></span>
      <span>Beats: <strong>{a.beatCount}</strong></span>
      {a.meter != null && <span title="Time signature">Meter: <strong>{a.meter}/4</strong></span>}
      {a.downbeatCount != null && (
        <span title="Downbeats detected (with detection confidence)">
          Downbeats: <strong>{a.downbeatCount}</strong>
          {a.downbeatConfidence != null && <span class="dim"> ({fmtPct(a.downbeatConfidence)})</span>}
        </span>
      )}
      <span>Drops: <strong>{a.dropCount || 0}</strong></span>
      <span>Builds: <strong>{a.buildupCount || 0}</strong></span>
      <span>Events: <strong>{as.timelineLength}</strong></span>
    </div>
  );

  return <div class="auto-analysis-stats">{blocks}</div>;
}
