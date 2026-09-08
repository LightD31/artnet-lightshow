#!/usr/bin/env node
/**
 * Real-track test harness.
 *
 * Downloads a song via yt-dlp (cached under tests/fixtures/), runs the
 * Python analyzer on it, builds a show timeline with AutoShow, then prints a
 * diagnostic summary covering mood, segments, drops, timeline event counts,
 * and burst/pattern-change density.
 *
 * Usage:
 *   node tests/real-track-analyze.js <query-or-url>
 *   node tests/real-track-analyze.js "Porter Robinson Shelter"
 *   node tests/real-track-analyze.js https://www.youtube.com/watch?v=...
 *
 * Fixtures are cached at tests/fixtures/<slug>.wav and reused across runs
 * so iterating on analyzer / show tweaks doesn't re-download.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const AutoShow = require('../src/auto-show');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
if (!fs.existsSync(FIXTURE_DIR)) fs.mkdirSync(FIXTURE_DIR, { recursive: true });

// The real tables rather than copies of them. Hand-maintained duplicates went
// stale the first time the colour list was reworked, which left this harness
// clamping palette indices against the wrong length, printing colour names the
// server had not had for a while, and offering the picker a pattern pool that
// no longer matched what the engine could render.
const { COLOR_PRESETS, PATTERNS } = require('../src/server/presets');

function slugify(q) {
  return q.toLowerCase()
    .replace(/https?:\/\/(www\.)?/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function downloadCached(query, { fresh } = {}) {
  return new Promise((resolve, reject) => {
    const slug = slugify(query);
    const target = path.join(FIXTURE_DIR, slug + '.wav');

    if (!fresh && fs.existsSync(target)) {
      console.log(`[cache] ${target}`);
      return resolve(target);
    }
    if (fresh && fs.existsSync(target)) {
      fs.unlinkSync(target);
    }

    console.log(`[yt-dlp] downloading: ${query}`);
    const isUrl = /^https?:\/\//.test(query);
    const source = isUrl ? query : `ytsearch1:${query}`;
    const outTemplate = path.join(FIXTURE_DIR, slug + '.%(ext)s');

    const args = [
      '-x',
      '--audio-format', 'wav',
      '--audio-quality', '0',
      '--no-playlist',
      '--no-warnings',
      '-o', outTemplate,
      source,
    ];

    const proc = spawn('yt-dlp', args, { stdio: 'inherit' });
    proc.on('error', (err) => reject(new Error(
      `yt-dlp not found. Install it: pip install yt-dlp\n${err.message}`
    )));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`yt-dlp exited ${code}`));
      if (fs.existsSync(target)) return resolve(target);
      // Fallback: scan for any file that starts with the slug
      const files = fs.readdirSync(FIXTURE_DIR).filter(f => f.startsWith(slug));
      if (files.length) return resolve(path.join(FIXTURE_DIR, files[0]));
      reject(new Error(`yt-dlp completed but no output file for ${slug}`));
    });
  });
}

function runAnalyzer(audioPath) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, '..', 'src', 'analyze.py');
    const proc = spawn('python', [script, audioPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', (err) => reject(new Error(
      `Python analyzer failed to start: ${err.message}`
    )));
    proc.on('close', (code) => {
      if (stderr.trim()) {
        for (const line of stderr.trim().split('\n')) {
          console.error(`[analyzer] ${line}`);
        }
      }
      if (code !== 0) {
        return reject(new Error(`analyzer exited ${code}: ${stderr || stdout}`));
      }
      try {
        const result = JSON.parse(stdout);
        if (result.error) return reject(new Error(result.error));
        resolve(result);
      } catch (e) {
        reject(new Error(`parse failed: ${e.message}\nstdout: ${stdout.slice(0, 400)}`));
      }
    });
  });
}

function fmt(n, w = 6, p = 2) {
  if (n == null || !Number.isFinite(n)) return ''.padStart(w);
  return n.toFixed(p).padStart(w);
}

function printSummary(analysis, timeline) {
  const mood = analysis.mood || {};

  console.log('\n── Analysis ─────────────────────────────────');
  console.log(`  duration       ${analysis.duration}s`);
  console.log(`  bpm            ${analysis.bpm} (source: ${analysis.beatSource || 'n/a'})`);
  console.log(`  tempoStability ${analysis.tempoStability}`);
  console.log(`  key/scale      ${analysis.key} ${analysis.scale}  (kstr ${analysis.keyStrength})`);
  console.log(`  meter          ${analysis.meter}  downbeats=${(analysis.downbeats || []).length}  dbConf=${analysis.downbeatConfidence}`);

  if (analysis.loudness) {
    const l = analysis.loudness;
    console.log(`  loudness       ${l.integratedLufs} LUFS  range ${l.range} LU  peak ${l.truePeakDb} dBFS`
      + `  (gain ${l.appliedGainDb} dB${l.denoised ? ', denoised' : ''})`);
  }

  console.log('\n── Mood ────────────────────────────────────');
  console.log(`  valence        ${mood.valence}`);
  console.log(`  arousal        ${mood.arousal}`);
  console.log(`  danceability   ${mood.danceability}`);
  console.log(`  kickiness      ${mood.kickiness}`);
  console.log(`  tension        ${mood.tension}`);

  if (analysis.bands) {
    console.log('\n── Bands ───────────────────────────────────');
    console.log('  band        energy  attack   decay   rhy   perc    imp');
    for (const b of Object.values(analysis.bands)) {
      console.log(`  ${String(b.name).padEnd(10)}${fmt(b.energy)}${fmt(b.attackMs, 8, 0)}${fmt(b.decayMs, 8, 0)}`
        + `${fmt(b.rhythmic, 6)}${fmt(b.percussive, 7)}${fmt(b.importance, 7)}`);
    }
  }

  if (analysis.instruments && analysis.instruments.scores) {
    const scores = Object.entries(analysis.instruments.scores)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join('  ');
    console.log(`\n  instruments    ${scores}`);
  }

  if (analysis.genre) {
    const g = analysis.genre;
    console.log('\n── Genre (PANNs) ───────────────────────────');
    console.log(`  label          ${g.label} (${g.labelConf})`);
    if (g.subScores) {
      const ranked = Object.entries(g.subScores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${k}:${v}`)
        .join('  ');
      console.log(`  sub-scores     ${ranked}`);
    }
    if (g.topTags) {
      console.log(`  top tags:      ${g.topTags.map(t => `${t.label} (${t.p})`).join(', ')}`);
    }
  }

  const segs = analysis.segments || [];
  console.log(`\n── Sections (${segs.length}) ──────────────────────`);
  console.log('  role       label    start     end   level      e     br     bs');
  for (const s of segs) {
    console.log(`  ${String(s.role || '?').padEnd(10)} ${String(s.label || '?').padEnd(4)}`
      + `${fmt(s.start, 8, 1)}${fmt(s.end, 8, 1)}  ${String(s.level).padEnd(4)}`
      + ` ${fmt(s.energy)} ${fmt(s.brightness)} ${fmt(s.bass)}`);
  }

  const drops = analysis.drops || [];
  console.log(`\n── Drops (${drops.length}) ─────────────────────────`);
  if (drops.length) {
    console.log('       t     conf    bd    sus  snapTo');
    for (const d of drops) {
      console.log(`  ${fmt(d.t, 6, 1)}  ${fmt(d.confidence, 5, 2)}  ${fmt(d.breakdownScore, 4, 2)}  ${fmt(d.sustainScore, 4, 2)}  ${d.snapTo || '-'}`);
    }
  }

  const buildups = analysis.buildups || [];
  console.log(`\n── Buildups (${buildups.length}) ───────────────────`);
  for (const b of buildups) {
    console.log(`  ${fmt(b.start, 6, 1)} .. ${fmt(b.end, 6, 1)}`
      + `  intensity=${b.intensity}  roll=1/${(b.subdivision || 1) * 4}`);
  }

  const events = analysis.events || [];
  if (events.length) {
    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
    console.log(`\n── Musical events (${events.length}) ─────────────`);
    for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(16)} ${v}`);
    }
  }

  // Timeline event tallies
  const counts = {};
  for (const ev of timeline) {
    let k;
    if (ev.action === 'patch') {
      if (ev.data.bpm != null && Object.keys(ev.data).length === 1) k = 'patch:bpm';
      else if (ev.data.pattern) k = 'patch:' + ev.data.pattern;
      else k = 'patch:color-update';
    } else {
      k = 'energy:' + ev.data.id;
    }
    counts[k] = (counts[k] || 0) + 1;
  }

  console.log(`\n── Timeline (${timeline.length} events) ─────────────`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(26)} ${v}`);
  }

  // Density metrics: the things the user reports being "too much"
  const highSegDur = segs
    .filter(s => s.level === 'high')
    .reduce((a, s) => a + (s.end - s.start), 0);
  const accents = timeline.filter(e =>
    e.action === 'energy' && /strobe|blinder/.test(e.data.id || '')
  ).length;
  const patternChanges = timeline.filter(e =>
    e.action === 'patch' && e.data.pattern
  ).length;
  const bpmPatches = timeline.filter(e =>
    e.action === 'patch' && e.data.bpm != null && Object.keys(e.data).length === 1
  ).length;

  const durMin = Math.max(analysis.duration / 60, 1 / 60);
  console.log('\n── Density ─────────────────────────────────');
  console.log(`  pattern changes  ${patternChanges}  (${(patternChanges / durMin).toFixed(1)}/min)`);
  console.log(`  accent bursts    ${accents}  (${(accents / durMin).toFixed(1)}/min)`);
  console.log(`  bpm patches      ${bpmPatches}  (${(bpmPatches / durMin).toFixed(1)}/min)`);
  if (highSegDur > 0) {
    console.log(`  accents / min of high-energy seg: ${(accents / (highSegDur / 60)).toFixed(1)}`);
  }
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node tests/real-track-analyze.js [--fresh] <query or URL>');
    process.exit(1);
  }
  const fresh = args.includes('--fresh');
  const query = args.filter(a => a !== '--fresh').join(' ');
  if (!query) {
    console.error('Missing query. Example: node tests/real-track-analyze.js "Bon Iver Holocene"');
    process.exit(1);
  }

  const audioPath = await downloadCached(query, { fresh });
  console.log(`[analyze] ${audioPath}`);
  const analysis = await runAnalyzer(audioPath);

  const show = new AutoShow(() => {}, COLOR_PRESETS, PATTERNS, null);
  show.analysis = analysis;
  show.buildTimeline();

  printSummary(analysis, show.timeline);
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });
