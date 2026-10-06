import { useEffect, useState } from 'preact/hooks';
import { api, audioFeedSig, pick, wantAudio } from '../state.js';

/**
 * What the room hears: the audio mode (off, tempo, reactive), Hue Dynamics'
 * party meters (full, bass, mid, high), the Disco band gates, Light DJ's
 * loudness class and the live input's latency. The 30 Hz `audio` feed is
 * subscribed only while this panel is on screen and the page is visible;
 * without it the once-a-second levels in the live `audio` key stand in.
 */

const MODES = [['off', 'Off'], ['tempo', 'Tempo'], ['reactive', 'Reactive']];
const BANDS = ['full', 'bass', 'mid', 'high'];

export function meterRows(party) {
  return BANDS.map((key) => ({ key, pct: Math.round(Math.min(1, Math.max(0, Number(party && party[key]) || 0)) * 100) }));
}

/** The beat's class when there is one, else the section's: loud, soft or quiet. */
export function splClass(spl) {
  if (!spl) return null;
  return spl.beat || spl.section || null;
}

export function latencyText(ms) {
  if (!Number.isFinite(ms)) return '–';
  return `${ms < 0 ? '−' : '+'}${Math.abs(Math.round(ms))} ms`;
}

function useAudioFeed() {
  useEffect(() => {
    let release = null;
    const sync = () => {
      const visible = document.visibilityState !== 'hidden';
      if (visible && !release) release = wantAudio();
      else if (!visible && release) { release(); release = null; }
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      if (release) release();
    };
  }, []);
}

export function AudioMeters({ latencyMs } = {}) {
  const s = pick(['audio']);
  const audio = s.audio || {};
  const feed = audioFeedSig.value;
  const [latency, setLatency] = useState(latencyMs);
  useAudioFeed();
  useEffect(() => {
    if (latencyMs !== undefined) return;
    api('/api/settings').then((res) => {
      const ms = res.ok && res.settings && res.settings.live ? res.settings.live.latencyMs : undefined;
      setLatency(ms);
    });
  }, []);

  const party = feed ? feed.party : audio.levels;
  const spl = feed ? feed.spl : audio.spl;
  const gates = feed && feed.disco ? feed.disco.gate : [];
  const chip = splClass(spl);
  const setMode = (mode) => api('/api/audio', { method: 'PUT', body: JSON.stringify({ mode }) });

  return (
    <section class="perform-audio" aria-label="Audio">
      <div class="audio-row">
        <select class="audio-mode" aria-label="Audio mode" value={audio.mode || 'tempo'} onChange={(e) => setMode(e.target.value)}>
          {MODES.map(([value, label]) => <option key={value} value={value} selected={(audio.mode || 'tempo') === value}>{label}</option>)}
        </select>
        {chip && <span class={`spl-chip ${chip}`} title="Light DJ's loudness class">{chip}</span>}
        <span class="audio-latency" title="Live input latency">Latency {latencyText(latency)}</span>
      </div>
      <div class="audio-meters">
        {meterRows(party).map((r) => (
          <div key={r.key} class="audio-meter" role="meter" aria-label={r.key} aria-valuemin="0" aria-valuemax="100" aria-valuenow={r.pct}>
            <span class="audio-meter-fill" style={{ height: `${r.pct}%` }} />
            <span class="audio-meter-name">{r.key}</span>
          </div>
        ))}
      </div>
      {gates.length > 0 && (
        <div class="audio-gates" aria-label="Disco band gates">
          {gates.map((g, i) => <span key={i} class={g > 0 ? 'gate open' : 'gate'} title={`Band ${i + 1}`} />)}
        </div>
      )}
      {audio.listening === false && !feed && <p class="audio-quiet">Nothing heard: the live input is off or silent.</p>}
    </section>
  );
}
