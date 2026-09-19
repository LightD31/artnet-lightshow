import { useEffect, useRef, useState } from 'preact/hooks';
import { autoPositionSig, autoTimelineSig, connectedSig, stateSig } from '../state.js';
import { fmtTime } from '../utils.js';
import { loadTimeline, timelineKey, timelinePosition } from '../timeline-state.js';

import { createTimelineRenderer } from '../timeline-renderer.js';



function currentPosMs() {
  const ap = autoPositionSig.value;
  const timeline = autoTimelineSig.value;
  const durationMs = timeline.key === timelineKey(stateSig.value)
    ? timeline.data?.duration * 1000 : 0;
  return timelinePosition(ap, performance.now(), durationMs);
}

export function AutoTimeline() {
  const s = stateSig.value;
  const canvasRef = useRef(null);
  const rafRef = useRef(null);
  const rendererRef = useRef(null);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const key = timelineKey(s);
  const connected = connectedSig.value;

  // Fetch the heavy timeline payload when the analysis identity changes.
  useEffect(() => {
    if (!key) {
      autoTimelineSig.value = { data: null, key: null, status: 'idle', error: null };
      return;
    }
    if (!connected) {
      autoTimelineSig.value = { key, data: null, status: 'offline', error: null };
      return;
    }
    const request = loadTimeline(key, (next) => {
      if (next.status !== 'loading' && autoTimelineSig.value.key !== key) return;
      autoTimelineSig.value = next;
    });
    return () => request.cancel();
  }, [key, connected, retryAttempt]);

  // Animation loop — drives the playhead at frame rate.
  useEffect(() => {
    const tick = () => {
      const canvas = canvasRef.current;
      const timeline = autoTimelineSig.value;
      const data = timeline.key === timelineKey(stateSig.value) ? timeline.data : null;
      if (canvas) {
        if (!rendererRef.current) rendererRef.current = createTimelineRenderer(canvas);
        rendererRef.current(data, currentPosMs());
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rendererRef.current = null;
    };
  }, []);

  if (!s.autoShow || !s.autoShow.analysis) return null;

  const timelineState = autoTimelineSig.value;
  const data = timelineState.key === key ? timelineState.data : null;
  const durMs = data && data.duration ? data.duration * 1000 : 0;
  const playbackStatus = !connected ? 'Offline' : s.autoShow.running
    ? (autoPositionSig.value.advancing ? 'Playing' : 'Position held') : 'Stopped';

  return (
    <div class="auto-timeline auto-timeline-bare">
      <div class="auto-timeline-header">
        <span class="auto-timeline-title">Timeline</span>
        <span class="auto-timeline-status" aria-live="polite">{playbackStatus}</span>
        {timelineState.status === 'loading' && <span class="auto-timeline-status">Loading…</span>}
        {timelineState.status === 'offline' && <span class="auto-timeline-status">Waiting for connection…</span>}
        {timelineState.error && <button class="auto-timeline-status error" type="button" onClick={() => {
          setRetryAttempt((attempt) => attempt + 1);
        }}>{timelineState.error} Retry</button>}
        <span class="auto-timeline-time">
          <span>{fmtTime(currentPosMs())}</span> / <span>{fmtTime(durMs)}</span>
        </span>
      </div>
      <canvas
        id="auto-timeline-canvas"
        ref={canvasRef}
        width={800}
        height={200}
        role="img"
        aria-label="Audio analysis timeline with sections, energy curves, and lighting events"
      />
      <div class="auto-timeline-legend">
        <span><i class="swatch seg-low" />Low</span>
        <span><i class="swatch seg-mid" />Mid</span>
        <span><i class="swatch seg-high" />High</span>
        <span><i class="swatch curve-energy" />Energy</span>
        <span><i class="swatch curve-bass" />Bass</span>
        <span><i class="swatch curve-kick" />Kick</span>
        <span><i class="swatch curve-high" />Highs</span>
        <span><i class="swatch tempo" />Tempo</span>
        <span><i class="swatch downbeat" />Downbeat</span>
        <span><i class="swatch buildup" />Build-up</span>
        <span><i class="swatch drop" />Drop</span>
        <span><i class="swatch event-pattern" />Pattern</span>
        <span><i class="swatch event-patch" />Colour</span>
        <span><i class="swatch event-express" />Expression</span>
        <span><i class="swatch event-energy" />Burst</span>
      </div>
    </div>
  );
}
