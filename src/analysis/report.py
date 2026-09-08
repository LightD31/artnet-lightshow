"""
Debug visualisation: one self-contained HTML file per analysis.

Deliberately not matplotlib. The people who need this — someone asking why the
show fired a blinder in the middle of a verse — are looking at a laptop next to
a rig, and an interactive page they can zoom and hover beats a PNG. It also
means the tool has no dependency beyond the standard library: the analysis
document is embedded as JSON and a few hundred lines of vanilla JavaScript draw
it on canvases.

What it shows, top to bottom:

  waveform + energy    with section bands behind it, so a boundary that landed
                       in the wrong place is visible at a glance
  beat markers         height is per-beat confidence; downbeats are taller
  seven bands          stacked, so which band carries the track is obvious
  impact + dynamics    drops, build-ups, breaks and silences over the curve
                       the detectors actually read
  event stream         every musical event on a lane per type, hoverable

`analysis_to_html(document) -> str`. Write it wherever you like.
"""

import json


def analysis_to_html(document, title='Analysis report', waveform=None):
    """
    Render an analysis document as a standalone HTML page.

    `waveform` is an optional decimated peak envelope — a list of floats in
    -1..1 — which the page draws behind everything else. Without it the page
    still works and shows the energy curve in its place.
    """
    payload = json.dumps({
        'analysis': document,
        'waveform': list(waveform) if waveform is not None else None,
    }, allow_nan=False)
    return _TEMPLATE.replace('__TITLE__', _escape(title)).replace(
        '__PAYLOAD__', payload.replace('</', '<\\/'))


def waveform_peaks(samples, buckets=2000):
    """Decimate a waveform to `buckets` peak values for drawing."""
    import numpy as np
    samples = np.asarray(samples, dtype=float)
    if samples.size == 0:
        return []
    size = max(1, samples.size // buckets)
    usable = (samples.size // size) * size
    if usable == 0:
        return [float(np.max(np.abs(samples)))]
    reshaped = np.abs(samples[:usable]).reshape(-1, size)
    return [round(float(v), 4) for v in np.max(reshaped, axis=1)]


def _escape(text):
    return (str(text).replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
  :root {
    --bg: #0e1014; --panel: #161a21; --line: #262c36; --text: #e6e9ef;
    --muted: #8b95a7; --accent: #59c2ff; --warn: #ffb454; --hot: #ff6b81;
    --ok: #7ee787;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  header { padding: 18px 22px 12px; border-bottom: 1px solid var(--line); }
  h1 { margin: 0 0 6px; font-size: 17px; font-weight: 600; }
  .summary { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); }
  .summary b { color: var(--text); font-weight: 600; }
  main { padding: 16px 22px 60px; }
  section { margin-bottom: 22px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--muted); margin: 0 0 6px; font-weight: 600; }
  .panel { background: var(--panel); border: 1px solid var(--line);
           border-radius: 8px; padding: 8px; overflow-x: auto; }
  canvas { display: block; width: 100%; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px;
            color: var(--muted); font-size: 12px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px;
            margin-right: 5px; vertical-align: -1px; }
  #tip { position: fixed; pointer-events: none; background: #000d;
         border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px;
         font-size: 12px; display: none; max-width: 320px; z-index: 10; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; }
</style>
</head>
<body>
<header>
  <h1>__TITLE__</h1>
  <div class="summary" id="summary"></div>
</header>
<main id="main"></main>
<div id="tip"></div>
<script id="payload" type="application/json">__PAYLOAD__</script>
<script>
(function () {
  const payload = JSON.parse(document.getElementById('payload').textContent);
  const a = payload.analysis || {};
  const duration = a.duration || 1;
  const tip = document.getElementById('tip');

  const SECTION_COLORS = {
    intro: '#3d5a80', verse: '#4f7cac', chorus: '#e07a5f', drop: '#d62839',
    bridge: '#8367c7', breakdown: '#2a9d8f', outro: '#5c677d'
  };
  const EVENT_COLORS = {
    BEAT: '#3b4453', BAR: '#59c2ff', DROP: '#ff6b81', BUILDUP: '#ffb454',
    ENERGY_SPIKE: '#ffd166', BASS_HIT: '#7ee787', VOCAL_SECTION: '#c792ea',
    MELODY_CHANGE: '#89ddff', SILENCE: '#4a5160', TRANSITION: '#f78c6c',
    BREAK: '#82aaff', SECTION: '#546178'
  };

  // ── Summary ────────────────────────────────────────────────────────────
  const p = a.perception || {};
  const mood = (p.mood) || a.mood || {};
  const genre = (p.genre) || a.genre || {};
  const facts = [
    ['duration', fmtTime(duration)],
    ['tempo', (a.bpm || 0).toFixed(1) + ' BPM'],
    ['metre', (a.meter || 4) + '/4'],
    ['key', (a.key || '?') + ' ' + (a.scale || '')],
    ['style', genre.style || '?'],
    ['genre', (genre.label || 'unknown') + ' (' + (genre.confidence || 0) + ')'],
    ['arousal', fmt(mood.arousal)],
    ['valence', fmt(mood.valence)],
    ['danceable', fmt(mood.danceability)],
    ['LUFS', (a.loudness && a.loudness.integratedLufs != null)
        ? a.loudness.integratedLufs + ' (LRA ' + a.loudness.range + ')' : '—'],
    ['events', (a.events || []).length],
    ['schema', a.schemaVersion || '1.x']
  ];
  document.getElementById('summary').innerHTML = facts
    .map(([k, v]) => '<span>' + k + ' <b>' + v + '</b></span>').join('');

  // ── Layout ─────────────────────────────────────────────────────────────
  const main = document.getElementById('main');
  addSection('Waveform, energy and sections', 150, drawWaveform);
  addSection('Beats and downbeats', 80, drawBeats);
  addSection('Frequency bands', 190, drawBands, bandLegend());
  addSection('Impact, drops, build-ups and breaks', 130, drawDynamics);
  addSection('Musical events', eventLaneHeight(), drawEvents, eventLegend());
  addTable('Sections', ['start', 'end', 'role', 'label', 'level', 'energy', 'conf'],
    (a.segments || []).map(s => [fmtTime(s.start), fmtTime(s.end), s.role || '—',
      s.label, s.level, fmt(s.energy), fmt(s.confidence)]));
  addTable('Bands', ['band', 'range Hz', 'energy', 'attack ms', 'decay ms',
      'rhythmic', 'percussive', 'importance'],
    Object.values(a.bands || {}).map(b => [b.name, b.range.join('–'),
      fmt(b.energy), b.attackMs, b.decayMs, fmt(b.rhythmic), fmt(b.percussive),
      fmt(b.importance)]));

  function addSection(title, height, draw, legend) {
    const section = document.createElement('section');
    section.innerHTML = '<h2>' + title + '</h2>';
    const panel = document.createElement('div');
    panel.className = 'panel';
    const canvas = document.createElement('canvas');
    panel.appendChild(canvas);
    section.appendChild(panel);
    if (legend) section.appendChild(legend);
    main.appendChild(section);
    fit(canvas, height);
    draw(canvas.getContext('2d'), canvas.width / dpr(), height);
    canvas.addEventListener('mousemove', (e) => hover(e, canvas));
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
    window.addEventListener('resize', () => {
      fit(canvas, height);
      draw(canvas.getContext('2d'), canvas.width / dpr(), height);
    });
  }

  function addTable(title, headers, rows) {
    if (!rows.length) return;
    const section = document.createElement('section');
    section.innerHTML = '<h2>' + title + '</h2>';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = '<table><thead><tr>' +
      headers.map(h => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') +
      '</tbody></table>';
    section.appendChild(panel);
    main.appendChild(section);
  }

  function dpr() { return window.devicePixelRatio || 1; }
  function fit(canvas, height) {
    const width = canvas.parentElement.clientWidth - 16;
    canvas.width = width * dpr();
    canvas.height = height * dpr();
    canvas.style.height = height + 'px';
    canvas.getContext('2d').setTransform(dpr(), 0, 0, dpr(), 0, 0);
  }
  const x = (t, w) => (t / duration) * w;

  // ── Drawings ───────────────────────────────────────────────────────────
  function drawWaveform(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    for (const s of (a.segments || [])) {
      ctx.fillStyle = (SECTION_COLORS[s.role] || '#39414f') + '55';
      ctx.fillRect(x(s.start, w), 0, x(s.end - s.start, w), h);
      ctx.fillStyle = '#cdd5e0';
      ctx.font = '11px ui-sans-serif';
      ctx.fillText((s.role || s.label) + '', x(s.start, w) + 4, 13);
    }
    const wave = payload.waveform;
    if (wave && wave.length) {
      ctx.fillStyle = '#59c2ff44';
      const step = w / wave.length;
      for (let i = 0; i < wave.length; i++) {
        const amp = wave[i] * (h / 2 - 12);
        ctx.fillRect(i * step, h / 2 - amp, Math.max(1, step), amp * 2);
      }
    }
    line(ctx, a.energyCurve || [], w, h, '#e6e9ef', 1.6);
  }

  function drawBeats(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const beats = a.beats || [];
    const conf = (a.rhythm && a.rhythm.beatConfidences) || a.beatStrengths || [];
    const downbeats = new Set((a.downbeats || []).map(t => t.toFixed(3)));
    for (let i = 0; i < beats.length; i++) {
      const isDown = downbeats.has(beats[i].toFixed(3));
      const c = conf[i] == null ? 0.5 : conf[i];
      const height = 10 + c * (h - 26) * (isDown ? 1 : 0.6);
      ctx.fillStyle = isDown ? '#59c2ff' : '#4a5568';
      ctx.fillRect(x(beats[i], w), h - height - 12, isDown ? 2 : 1, height);
    }
    axis(ctx, w, h);
  }

  function drawBands(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const names = Object.keys(a.bands || {});
    const rowHeight = (h - 14) / Math.max(1, names.length);
    names.forEach((name, i) => {
      const band = a.bands[name];
      const top = i * rowHeight;
      ctx.fillStyle = '#1c212a';
      ctx.fillRect(0, top, w, rowHeight - 2);
      area(ctx, band.curve || [], w, rowHeight - 2, top, bandColor(i));
      ctx.fillStyle = '#8b95a7';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(name + '  imp ' + fmt(band.importance), 4, top + 11);
    });
    axis(ctx, w, h);
  }

  function drawDynamics(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const dyn = a.dynamics || {};
    for (const s of (dyn.silences || [])) rect(ctx, s, w, h, '#00000088');
    for (const b of (dyn.breaks || [])) rect(ctx, b, w, h, '#82aaff33');
    for (const b of (dyn.buildups || a.buildups || [])) rect(ctx, b, w, h, '#ffb45444');
    area(ctx, dyn.impactCurve || a.energyCurve || [], w, h - 14, 0, '#59c2ff');
    for (const d of (dyn.drops || a.drops || [])) {
      ctx.strokeStyle = '#ff6b81';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x(d.t, w), 0); ctx.lineTo(x(d.t, w), h - 14); ctx.stroke();
      ctx.fillStyle = '#ff6b81';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText((d.kind || 'drop') + ' ' + fmt(d.confidence), x(d.t, w) + 3, 11);
    }
    axis(ctx, w, h);
  }

  function eventLanes() {
    const types = [...new Set((a.events || []).map(e => e.type))];
    types.sort();
    return types;
  }
  function eventLaneHeight() { return 20 + eventLanes().length * 16; }

  function drawEvents(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const lanes = eventLanes();
    lanes.forEach((type, i) => {
      const y = 8 + i * 16;
      ctx.fillStyle = '#1c212a';
      ctx.fillRect(0, y, w, 13);
      ctx.fillStyle = '#8b95a7';
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillText(type, 4, y + 10);
    });
    for (const e of (a.events || [])) {
      const lane = lanes.indexOf(e.type);
      if (lane < 0) continue;
      const y = 8 + lane * 16;
      const width = e.duration > 0 ? Math.max(2, x(e.duration, w)) : 2;
      ctx.globalAlpha = 0.35 + 0.65 * (e.confidence == null ? 1 : e.confidence);
      ctx.fillStyle = EVENT_COLORS[e.type] || '#7f8ea3';
      ctx.fillRect(x(e.t, w), y + 1, width, 11);
      ctx.globalAlpha = 1;
    }
    axis(ctx, w, h);
  }

  // ── Primitives ─────────────────────────────────────────────────────────
  function line(ctx, curve, w, h, color, width) {
    if (!curve.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = width || 1;
    ctx.beginPath();
    curve.forEach((pt, i) => {
      const px = x(pt.t, w), py = h - 12 - pt.v * (h - 24);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.stroke();
  }
  function area(ctx, curve, w, h, top, color) {
    if (!curve.length) return;
    ctx.fillStyle = color + '66'; ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, top + h);
    curve.forEach(pt => ctx.lineTo(x(pt.t, w), top + h - pt.v * h));
    ctx.lineTo(w, top + h); ctx.closePath(); ctx.fill();
  }
  function rect(ctx, span, w, h, color) {
    const end = span.end != null ? span.end : (span.data && span.data.end) || span.start;
    ctx.fillStyle = color;
    ctx.fillRect(x(span.start, w), 0, Math.max(2, x(end - span.start, w)), h - 14);
  }
  function axis(ctx, w, h) {
    ctx.strokeStyle = '#262c36'; ctx.fillStyle = '#5d6779';
    ctx.font = '10px ui-monospace, monospace'; ctx.lineWidth = 1;
    const step = niceStep(duration);
    for (let t = 0; t <= duration; t += step) {
      const px = x(t, w);
      ctx.beginPath(); ctx.moveTo(px, h - 12); ctx.lineTo(px, h - 8); ctx.stroke();
      ctx.fillText(fmtTime(t), px + 2, h - 1);
    }
  }
  function niceStep(d) {
    for (const s of [5, 10, 15, 30, 60, 120, 300]) if (d / s <= 12) return s;
    return 600;
  }
  function bandColor(i) {
    return ['#ff6b81', '#ffb454', '#ffd166', '#7ee787', '#59c2ff', '#89ddff',
            '#c792ea'][i % 7];
  }
  function bandLegend() {
    const div = document.createElement('div');
    div.className = 'legend';
    div.innerHTML = Object.keys(a.bands || {}).map((n, i) =>
      '<span><i class="swatch" style="background:' + bandColor(i) + '"></i>' +
      n + ' ' + (a.bands[n].range || []).join('–') + ' Hz</span>').join('');
    return div;
  }
  function eventLegend() {
    const div = document.createElement('div');
    div.className = 'legend';
    div.innerHTML = eventLanes().map(t =>
      '<span><i class="swatch" style="background:' + (EVENT_COLORS[t] || '#7f8ea3') +
      '"></i>' + t + '</span>').join('');
    return div;
  }

  function hover(e, canvas) {
    const box = canvas.getBoundingClientRect();
    const t = ((e.clientX - box.left) / box.width) * duration;
    const near = (a.events || [])
      .filter(ev => Math.abs(ev.t - t) < duration / box.width * 6)
      .slice(0, 8);
    const section = (a.segments || []).find(s => t >= s.start && t < s.end);
    let html = '<b>' + fmtTime(t) + '</b>';
    if (section) html += '<br>' + (section.role || section.label) +
      ' · ' + section.level + ' · energy ' + fmt(section.energy);
    for (const ev of near) {
      html += '<br>' + ev.type + ' · ' + fmt(ev.intensity) +
        ' · conf ' + fmt(ev.confidence) + ' · ' + ev.effect;
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    tip.style.left = Math.min(window.innerWidth - 340, e.clientX + 12) + 'px';
    tip.style.top = (e.clientY + 14) + 'px';
  }

  function fmt(v) { return v == null ? '—' : Number(v).toFixed(2); }
  function fmtTime(t) {
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return m + ':' + String(s).padStart(2, '0');
  }
})();
</script>
</body>
</html>
"""
