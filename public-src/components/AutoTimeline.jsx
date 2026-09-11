import { useEffect, useRef } from 'preact/hooks';
import { autoPositionSig, autoTimelineSig, stateSig } from '../state.js';
import { fmtTime } from '../utils.js';

// Imperative canvas drawing — same logic as the original app.js, kept whole
// because Preact buys us nothing for raw canvas painting.
function drawTimeline(canvas, data, posMs) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const H = cssH;

  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, W, H);

  if (!data || !data.duration) {
    ctx.fillStyle = '#444';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No analysis loaded', W / 2, H / 2);
    return;
  }

  const durMs = data.duration * 1000;
  const xForMs = (ms) => (ms / durMs) * W;
  const xForSec = (s) => (s / data.duration) * W;

  const ROW_SEG    = { y: 0,   h: 16 };
  const ROW_CURVE  = { y: 18,  h: 88 };
  const ROW_BEATS  = { y: 108, h: 14 };
  const ROW_EVENTS = { y: 124, h: 20 };
  const ROW_TIMELN = { y: 146, h: 30 };

  // Sections. Colour by role where the analyser named one, falling back to the
  // energy tier for documents from before roles existed — a cached analysis
  // still draws, it just draws in three colours instead of seven.
  const segColors = { low: '#1e3a5f', mid: '#3a7099', high: '#ff6584' };
  const roleColors = {
    intro: '#3d5a80', verse: '#4f7cac', chorus: '#e07a5f', drop: '#d62839',
    bridge: '#8367c7', breakdown: '#2a9d8f', outro: '#5c677d',
  };
  (data.segments || []).forEach((seg) => {
    const x0 = xForSec(seg.start);
    const x1 = xForSec(seg.end);
    const w = Math.max(1, x1 - x0);
    ctx.fillStyle = roleColors[seg.role] || segColors[seg.level] || '#333';
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x0, ROW_SEG.y, w, ROW_SEG.h);
    ctx.globalAlpha = 1;
    // The role is what the show acts on, so it is what the operator needs to
    // see; the cluster label only matters for telling two verses apart.
    const caption = seg.role && seg.role !== 'unknown'
      ? (w > 46 ? seg.role : seg.role[0].toUpperCase())
      : seg.label;
    if (caption && w > 18) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(caption, x0 + 4, ROW_SEG.y + ROW_SEG.h / 2);
    }
  });

  // Energy curve (filled gradient)
  const energyCurve = data.energyCurve || [];
  if (energyCurve.length > 1) {
    ctx.beginPath();
    ctx.moveTo(xForSec(energyCurve[0].t), ROW_CURVE.y + ROW_CURVE.h);
    for (const pt of energyCurve) {
      const x = xForSec(pt.t);
      const y = ROW_CURVE.y + ROW_CURVE.h - Math.max(0, Math.min(1, pt.v)) * ROW_CURVE.h;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(xForSec(energyCurve[energyCurve.length - 1].t), ROW_CURVE.y + ROW_CURVE.h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, ROW_CURVE.y, 0, ROW_CURVE.y + ROW_CURVE.h);
    grad.addColorStop(0, 'rgba(59, 130, 246, .75)');
    grad.addColorStop(1, 'rgba(59, 130, 246, .08)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Sub-band overlay lines
  const drawCurveLine = (curve, color, width = 1.2, alpha = 0.8) => {
    if (!curve || curve.length < 2) return;
    ctx.beginPath();
    for (let i = 0; i < curve.length; i++) {
      const pt = curve[i];
      const x = xForSec(pt.t);
      const y = ROW_CURVE.y + ROW_CURVE.h - Math.max(0, Math.min(1, pt.v)) * ROW_CURVE.h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  drawCurveLine(data.bassCurve, 'rgba(255, 101, 132, .85)', 1.2);
  drawCurveLine(data.kickCurve, 'rgba(255, 170, 68, .75)', 1.0, 0.7);
  drawCurveLine(data.highCurve, 'rgba(102, 221, 255, .7)',  1.0, 0.65);

  // Tempo overlay only when stability < 0.85 — wavy line means real drift.
  if (data.tempoCurve && data.tempoCurve.length > 2 && data.tempoStability != null && data.tempoStability < 0.85) {
    const bpmMid = data.bpm || 120;
    const bpmLo = bpmMid * 0.85;
    const bpmHi = bpmMid * 1.15;
    const bandTop = ROW_CURVE.y + 2;
    const bandBot = ROW_CURVE.y + 22;
    const bandH = bandBot - bandTop;
    ctx.beginPath();
    let started = false;
    for (const pt of data.tempoCurve) {
      const v = (pt.v - bpmLo) / Math.max(0.001, bpmHi - bpmLo);
      const x = xForSec(pt.t);
      const y = bandBot - Math.max(0, Math.min(1, v)) * bandH;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(153, 255, 153, .85)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(153, 255, 153, .25)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, bandTop); ctx.lineTo(W, bandTop);
    ctx.moveTo(0, bandBot); ctx.lineTo(W, bandBot);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Beat ticks
  const beats = data.beats || [];
  const beatStrengths = data.beatStrengths || [];
  if (beats.length) {
    const step = beats.length > W ? Math.ceil(beats.length / W) : 1;
    ctx.strokeStyle = 'rgba(200, 200, 240, .35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < beats.length; i += step) {
      const strength = beatStrengths[i] != null ? Math.max(0.25, beatStrengths[i]) : 0.5;
      const tickH = Math.max(3, ROW_BEATS.h * strength);
      const x = xForSec(beats[i]);
      ctx.moveTo(x, ROW_BEATS.y + ROW_BEATS.h - tickH);
      ctx.lineTo(x, ROW_BEATS.y + ROW_BEATS.h);
    }
    ctx.stroke();
  }
  // Downbeats — taller, brighter
  const downbeats = data.downbeats || [];
  if (downbeats.length) {
    ctx.strokeStyle = 'rgba(255, 255, 255, .85)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const step = downbeats.length > W / 2 ? Math.ceil(downbeats.length / (W / 2)) : 1;
    for (let i = 0; i < downbeats.length; i += step) {
      const x = xForSec(downbeats[i]);
      ctx.moveTo(x, ROW_BEATS.y);
      ctx.lineTo(x, ROW_BEATS.y + ROW_BEATS.h);
    }
    ctx.stroke();
  }

  // Build-up gradient bars
  (data.buildups || []).forEach((b) => {
    const x0 = xForSec(b.start);
    const x1 = xForSec(b.end);
    const w = Math.max(2, x1 - x0);
    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, 'rgba(255, 170, 68, .1)');
    grad.addColorStop(1, 'rgba(255, 170, 68, .85)');
    ctx.fillStyle = grad;
    ctx.fillRect(x0, ROW_EVENTS.y, w, ROW_EVENTS.h);
  });

  // Drops — triangle flag, height scaled by confidence; vertical streak across curve.
  (data.drops || []).forEach((d) => {
    const x = xForSec(d.t);
    const confidence = Math.max(0.3, Math.min(1, d.confidence || 0.5));
    const triH = ROW_EVENTS.h * (0.5 + confidence * 0.5);
    const isDownbeat = d.snapTo === 'downbeat';
    ctx.fillStyle = isDownbeat ? '#ff2222' : '#ff5555';
    ctx.beginPath();
    ctx.moveTo(x,     ROW_EVENTS.y + (ROW_EVENTS.h - triH));
    ctx.lineTo(x - 5, ROW_EVENTS.y + ROW_EVENTS.h);
    ctx.lineTo(x + 5, ROW_EVENTS.y + ROW_EVENTS.h);
    ctx.closePath();
    ctx.fill();
    if (isDownbeat) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.strokeStyle = `rgba(255, 68, 68, ${0.25 + confidence * 0.4})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, ROW_CURVE.y);
    ctx.lineTo(x, ROW_CURVE.y + ROW_CURVE.h);
    ctx.stroke();
  });

  // Timeline events — patches (top), energy bursts (bottom).
  //
  // Not every patch is a change you can see, and drawing them all as one mark
  // made the row unreadable: the expression channel alone patches twice a
  // second, so a solid line of dots labelled "Pattern" ran the length of a
  // track in which the pattern had changed a dozen times. The three are drawn
  // apart — a tall tick for a new pattern, a dot for a colour move, and a faint
  // hairline for the continuous channel underneath both.
  const events = data.timeline || [];
  const patchY  = ROW_TIMELN.y + 6;
  const energyY = ROW_TIMELN.y + ROW_TIMELN.h - 6;
  events.forEach((ev) => {
    const x = xForMs(ev.timeMs);
    if (ev.action === 'patch') {
      if (ev.pattern) {
        ctx.fillStyle = '#60a5fa';
        ctx.fillRect(x - 0.75, patchY - 5, 1.5, 10);
      } else if (ev.colorA != null) {
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(x, patchY, 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(59, 130, 246, .28)';
        ctx.fillRect(x, patchY - 1, 1, 2);
      }
    } else if (ev.action === 'energy') {
      const w = Math.max(2, xForMs(ev.durationMs || 150) - xForMs(0));
      ctx.fillStyle = '#ffee44';
      ctx.fillRect(x - w / 2, energyY - 3, w, 6);
    }
  });

  // Row dividers
  ctx.strokeStyle = 'rgba(255,255,255,.04)';
  ctx.lineWidth = 1;
  [ROW_SEG.y, ROW_CURVE.y, ROW_BEATS.y, ROW_EVENTS.y, ROW_TIMELN.y].forEach((y) => {
    ctx.beginPath();
    ctx.moveTo(0, y - 1);
    ctx.lineTo(W, y - 1);
    ctx.stroke();
  });

  // Playhead
  if (posMs >= 0 && posMs <= durMs) {
    const px = xForMs(posMs);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(255,255,255,.7)';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

function timelineKey(s) {
  if (!s.autoShow || !s.autoShow.analysis) return null;
  const t = s.autoShow.track || {};
  return `${t.name || ''}|${t.artist || ''}|${s.autoShow.timelineLength || 0}|${s.autoShow.analysis.duration || 0}`;
}

function currentPosMs() {
  const ap = autoPositionSig.value;
  if (!ap.running) return ap.positionMs;
  return ap.positionMs + (performance.now() - ap.updatedAt);
}

export function AutoTimeline() {
  const s = stateSig.value;
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  // Fetch the heavy timeline payload when the analysis identity changes.
  useEffect(() => {
    const key = timelineKey(s);
    if (!key) {
      autoTimelineSig.value = { data: null, fetchedKey: null };
      return;
    }
    if (autoTimelineSig.value.fetchedKey === key) return;
    autoTimelineSig.value = { ...autoTimelineSig.value, fetchedKey: key };
    fetch('/api/auto/timeline')
      .then((r) => r.json())
      .then((d) => {
        if (d && d.ok && d.data) {
          autoTimelineSig.value = { data: d.data, fetchedKey: key };
        }
      })
      .catch(() => { /* silent */ });
  }, [timelineKey(s)]);

  // Animation loop — drives the playhead at frame rate.
  useEffect(() => {
    const tick = () => {
      const canvas = canvasRef.current;
      const data = autoTimelineSig.value.data;
      if (canvas) drawTimeline(canvas, data, currentPosMs());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); };
  }, []);

  if (!s.autoShow || !s.autoShow.analysis) return null;

  const data = autoTimelineSig.value.data;
  const durMs = data && data.duration ? data.duration * 1000 : 0;

  return (
    <div class="auto-timeline auto-timeline-bare">
      <div class="auto-timeline-header">
        <span class="auto-timeline-title">Timeline</span>
        <span class="auto-timeline-time">
          <span>{fmtTime(currentPosMs())}</span> / <span>{fmtTime(durMs)}</span>
        </span>
      </div>
      <canvas id="auto-timeline-canvas" ref={canvasRef} width={800} height={200} />
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
