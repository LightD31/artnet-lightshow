import { useEffect, useRef, useState } from 'preact/hooks';
import { autoPositionSig, autoTimelineSig, connectedSig, stateSig } from '../state.js';
import { fmtTime } from '../utils.js';
import { timelineDetails, timelineKey, timelinePosition } from '../timeline-state.js';
import { useTimeline } from '../use-timeline.js';

import { createTimelineRenderer } from '../timeline-renderer.js';

const LEGEND = [
  ['seg-low', 'Low'], ['seg-mid', 'Mid'], ['seg-high', 'High'],
  ['curve-energy', 'Energy'], ['curve-bass', 'Bass'], ['curve-kick', 'Kick'],
  ['curve-high', 'Highs'], ['tempo', 'Tempo'], ['downbeat', 'Downbeat'],
  ['buildup', 'Build-up'], ['drop', 'Drop'], ['event-pattern', 'Pattern'],
  ['event-patch', 'Colour'], ['event-express', 'Expression'], ['event-energy', 'Burst'],
];

function currentPosMs() {
  const ap = autoPositionSig.value;
  const timeline = autoTimelineSig.value;
  const durationMs = timeline.key === timelineKey(stateSig.value)
    ? timeline.data?.duration * 1000 : 0;
  return timelinePosition(ap, performance.now(), durationMs);
}

// The two pieces that follow the 10 Hz position stream are split out so that
// reading it subscribes only them. Held in the parent, that one signal re-diffed
// the header, the tooltip and a fifteen-item legend ten times a second to move
// one clock.

function PlaybackStatus({ connected, running }) {
  const label = !connected ? 'Offline'
    : running ? (autoPositionSig.value.advancing ? 'Playing' : 'Position held')
      : 'Stopped';
  return <span class="auto-timeline-status" aria-live="polite">{label}</span>;
}

function Elapsed({ durMs }) {
  return (
    <span class="auto-timeline-time">
      <span>{fmtTime(currentPosMs())}</span> / <span>{fmtTime(durMs)}</span>
    </span>
  );
}

/**
 * The canvas and its hover readout.
 *
 * Owns `hover` so that moving the pointer across the timeline re-renders one
 * tooltip rather than the whole panel. The canvas itself is never re-rendered:
 * it is painted by the animation loop through a ref.
 */
function TimelineSurface({ data, durMs }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const rendererRef = useRef(null);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const tick = () => {
      const canvas = canvasRef.current;
      const timeline = autoTimelineSig.value;
      const current = timeline.key === timelineKey(stateSig.value) ? timeline.data : null;
      if (canvas) {
        if (!rendererRef.current) rendererRef.current = createTimelineRenderer(canvas);
        rendererRef.current(current, currentPosMs());
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rendererRef.current = null;
    };
  }, []);

  const updateHover = (event) => {
    if (!data) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const percent = rect.width > 0
      ? Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) : 0;
    setHover(timelineDetails(data, percent * durMs));
  };

  return (
    <div
      class="auto-timeline-canvas-wrap"
      onPointerMove={updateHover}
      onPointerLeave={() => setHover(null)}
    >
      <canvas
        id="auto-timeline-canvas"
        ref={canvasRef}
        width={800}
        height={200}
        role="img"
        tabIndex="0"
        onFocus={() => { if (data) setHover(timelineDetails(data, currentPosMs())); }}
        onBlur={() => setHover(null)}
        aria-label="Audio analysis timeline with sections, energy curves, and lighting events"
      />
      {/* Deliberately not a live region. As one it re-announced on every
          pointer move, which is noise rather than information; the canvas
          carries its own description for anyone arriving by keyboard. */}
      {hover && (
        <div class="auto-timeline-tooltip" style={{ left: `${hover.percent}%` }}>
          <strong>{fmtTime(hover.positionMs)}</strong>
          {hover.section && <span>{hover.section}</span>}
          {hover.events.map((event) => <span key={`${event.timeMs}-${event.label}`}>{event.label}</span>)}
        </div>
      )}
    </div>
  );
}

export function AutoTimeline() {
  const s = stateSig.value;
  const connected = connectedSig.value;
  const timeline = useTimeline();

  if (!s.autoShow || !s.autoShow.analysis) return null;

  const { data } = timeline;
  const durMs = data && data.duration ? data.duration * 1000 : 0;

  return (
    <div class="auto-timeline auto-timeline-bare">
      <div class="auto-timeline-header">
        <span class="auto-timeline-title">Timeline</span>
        <PlaybackStatus connected={connected} running={s.autoShow.running} />
        {timeline.status === 'loading' && <span class="auto-timeline-status">Loading…</span>}
        {timeline.status === 'offline' && <span class="auto-timeline-status">Waiting for connection…</span>}
        {timeline.error && <button class="auto-timeline-status error" type="button" onClick={timeline.retry}>{timeline.error} Retry</button>}
        <Elapsed durMs={durMs} />
      </div>
      <TimelineSurface data={data} durMs={durMs} />
      <div class="auto-timeline-legend">
        {LEGEND.map(([cls, label]) => <span key={cls}><i class={`swatch ${cls}`} />{label}</span>)}
      </div>
    </div>
  );
}
