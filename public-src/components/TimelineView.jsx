import { useEffect, useRef, useState } from 'preact/hooks';
import { autoPositionSig, stagePreviewSig, pick } from '../state.js';
import { fmtTime } from '../utils.js';
import { timelinePosition } from '../timeline-state.js';
import { createTimelineRenderer } from '../timeline-renderer.js';
import { useTimeline } from '../use-timeline.js';
import { useRehearsalTrack } from '../rehearsal.js';
import { AnalysisStats } from './AnalysisStats.jsx';
import { StagePreview } from './StagePreview.jsx';
import { TrackEdits } from './TrackEdits.jsx';

/**
 * The Timeline view: the loaded track's show, laid out to be read and
 * rehearsed — what the analysis found, what the show plans to do and when,
 * and the edits kept with the track.
 *
 * The timeline is the Auto Show view's, drawn wide enough to zoom into, and
 * it is a scrubber: press anywhere on it (or use the arrow keys on it) and the
 * stage preview here, and the 3D Stage view, show the planned show at that
 * moment. That is rehearsal — nothing goes out to the rig — and it is the same
 * position everywhere it is shown.
 */

const ZOOMS = [1, 2, 4, 8];
// A canvas wider than this many device pixels is refused by some browsers.
const MAX_CANVAS_PX = 16000;

/**
 * Zoomed in, keep the mark in view, the way an editor follows its playhead:
 * after a seek or a zoom it is scrolled to a third of the way across, and when
 * it runs off the end of the stretch in view, the view turns the page. A view
 * the operator has scrolled somewhere else is left there.
 */
function useFollowMark(scroller, fraction, zoom, jump) {
  const last = useRef({ jump: null, zoom, left: 0, inView: true });
  useEffect(() => {
    const box = scroller.current;
    const was = last.current;
    if (!box) return;
    const x = fraction * box.scrollWidth;
    const shows = (left) => x >= left && x <= left + box.clientWidth;
    const jumped = was.zoom !== zoom || (jump !== null && was.jump !== jump);
    const ranOff = was.inView && was.left === box.scrollLeft;
    if (box.scrollWidth > box.clientWidth && !shows(box.scrollLeft) && (jumped || ranOff)) {
      box.scrollLeft = Math.max(0, x - box.clientWidth / 3);
    }
    last.current = { jump, zoom, left: box.scrollLeft, inView: shows(box.scrollLeft) };
  });
}

function useLivePosition(durationMs) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, []);
  return timelinePosition(autoPositionSig.value, performance.now(), durationMs);
}

export function TimelineView() {
  const s = pick(['autoShow', 'colorPresets']);
  const as = s.autoShow || {};
  const timeline = useTimeline();
  const { data } = timeline;
  const durationMs = data && data.duration ? data.duration * 1000 : 0;
  const ui = stagePreviewSig.value;
  const rehearsing = ui.rehearsal && !!data;
  const [zoom, setZoom] = useState(1);
  const canvas = useRef(null);
  const scroller = useRef(null);
  const drag = useRef(null);
  useRehearsalTrack(as);
  const liveMs = useLivePosition(durationMs);
  const markMs = rehearsing ? ui.position : liveMs;
  // A rehearsal only moves when it is sought or played: each move is a jump.
  useFollowMark(scroller, durationMs ? markMs / durationMs : 0, zoom, rehearsing ? ui.position : null);

  // Paint the timeline every frame: the live playhead moves, and a zoom or a
  // resize changes its width.
  useEffect(() => {
    let raf = 0;
    let render = null;
    const tick = () => {
      if (canvas.current) {
        if (!render) render = createTimelineRenderer(canvas.current);
        const current = timeline.data;
        render(current, timelinePosition(autoPositionSig.value, performance.now(), durationMs));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [timeline.data, durationMs]);

  const setUi = (patch) => { stagePreviewSig.value = { ...stagePreviewSig.value, ...patch }; };
  const seek = (ms) => setUi({ rehearsal: true, position: Math.max(0, Math.min(durationMs, Math.round(ms))) });
  const msAt = (event) => {
    const rect = canvas.current.getBoundingClientRect();
    return rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * durationMs : 0;
  };

  // Rehearsal playback here: the stage preview on this view advances its own
  // position while it plays.
  const maxZoom = ZOOMS.filter((z) => (scroller.current ? scroller.current.clientWidth : 1400) * z * (window.devicePixelRatio || 1) <= MAX_CANVAS_PX);

  if (!as.analysis) {
    return (
      <div class="timeline-view">
        <section class="panel">
          <header class="panel-head"><h2 class="panel-title">Timeline</h2></header>
          <p class="panel-empty">No track is analysed yet. Start a show in the Auto Show view (or analyse a track there), and its
            sections, curves, planned looks and accents appear here to read, rehearse and edit.</p>
        </section>
      </div>
    );
  }

  const sections = (data && data.segments) || [];
  const current = sections.find((sec) => markMs >= sec.start * 1000 && markMs < sec.end * 1000);
  const track = as.track || {};

  return (
    <div class="timeline-view">
      <section class="panel timeline-main" aria-labelledby="timeline-title">
        <header class="panel-head">
          <h2 class="panel-title" id="timeline-title">Timeline</h2>
          <span class="timeline-track">{track.name || 'Untitled'}{track.artist ? ` — ${track.artist}` : ''}</span>
          <span class="panel-tag">{rehearsing ? 'Rehearsing' : as.running ? 'Live' : 'Stopped'}</span>
        </header>
        <div class="timeline-tools" role="toolbar" aria-label="Timeline">
          <button type="button" class={`btn sm ${rehearsing ? 'active' : ''}`} aria-pressed={rehearsing} disabled={!data}
            onClick={() => setUi({ rehearsal: !rehearsing, playing: false })}>{rehearsing ? 'Back to live' : 'Rehearse'}</button>
          {rehearsing && (
            <button type="button" class="btn sm" onClick={() => setUi({ position: ui.position >= durationMs ? 0 : ui.position, playing: !ui.playing })}>
              {ui.playing ? 'Pause' : 'Play'}
            </button>
          )}
          <span class="timeline-time" aria-live="off">
            {rehearsing ? <>Rehearsal {fmtTime(ui.position)}</> : <>Live {fmtTime(liveMs)}</>} / {fmtTime(durationMs)}
            {current ? ` · ${current.role || current.label || 'section'}` : ''}
          </span>
          <span class="timeline-gap" />
          <div class="segmented" role="group" aria-label="Zoom">
            {ZOOMS.map((z) => (
              <button key={z} type="button" class={`segmented-btn ${zoom === z ? 'active' : ''}`} aria-pressed={zoom === z}
                disabled={!maxZoom.includes(z)} onClick={() => setZoom(z)}>{z}×</button>
            ))}
          </div>
          <a class="btn sm" href="#stage">Watch in 3D</a>
        </div>
        {timeline.status === 'loading' && <p class="look-note">Loading the timeline…</p>}
        {timeline.error && <p class="look-note"><button type="button" class="btn sm" onClick={timeline.retry}>{timeline.error} Retry</button></p>}
        <div class="timeline-scroll" ref={scroller}>
          <div class="timeline-canvas-wrap" style={{ width: `${zoom * 100}%` }}>
            <canvas ref={canvas} class="timeline-canvas" width={800} height={200} tabIndex={0} role="slider"
              aria-label="Rehearsal position on the track's timeline" aria-valuemin={0} aria-valuemax={Math.round(durationMs / 1000)}
              aria-valuenow={Math.round((rehearsing ? ui.position : liveMs) / 1000)} aria-valuetext={fmtTime(rehearsing ? ui.position : liveMs)}
              onPointerDown={(e) => {
                if (!durationMs || e.button !== 0) return;
                drag.current = e.pointerId;
                e.currentTarget.setPointerCapture(e.pointerId);
                seek(msAt(e));
              }}
              onPointerMove={(e) => { if (drag.current === e.pointerId) seek(msAt(e)); }}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
              onKeyDown={(e) => {
                if (!durationMs) return;
                const from = rehearsing ? ui.position : liveMs;
                const step = e.shiftKey ? 10000 : 1000;
                const to = e.key === 'ArrowRight' ? from + step : e.key === 'ArrowLeft' ? from - step
                  : e.key === 'Home' ? 0 : e.key === 'End' ? durationMs : null;
                if (to === null) return;
                e.preventDefault();
                seek(to);
              }} />
            {rehearsing && durationMs > 0 && (
              <span class="timeline-mark" aria-hidden="true" style={{ left: `${(ui.position / durationMs) * 100}%` }} />
            )}
          </div>
        </div>
        {sections.length > 0 && (
          <div class="timeline-sections" role="group" aria-label="Sections: rehearse from one">
            {sections.map((sec) => (
              <button key={sec.start} type="button" class={`timeline-section role-${sec.role || 'unknown'} ${current === sec ? 'current' : ''}`}
                style={{ flexGrow: Math.max(0.2, sec.end - sec.start) }}
                title={`${sec.role || sec.label || 'Section'} at ${fmtTime(sec.start * 1000)}`}
                onClick={() => seek(sec.start * 1000)}>
                <span>{sec.role || sec.label || '·'}</span>
              </button>
            ))}
          </div>
        )}
        <p class="look-note">
          Press or drag on the timeline, or use the arrow keys on it (Shift for ten seconds), to rehearse from there: the
          stage preview below and the Stage view show the planned show at that moment. The white line is where the music
          is now.
        </p>
      </section>
      <div class="setup-columns">
        <div class="setup-col">
          <StagePreview />
          <section class="panel">
            <header class="panel-head"><h2 class="panel-title">Analysis</h2></header>
            <AnalysisStats as={as} colorPresets={s.colorPresets} />
          </section>
        </div>
        <div class="setup-col">
          <TrackEdits at={rehearsing ? () => stagePreviewSig.value.position : null}
            atLabel={rehearsing ? 'rehearsal mark' : 'playhead'} />
        </div>
      </div>
    </div>
  );
}
