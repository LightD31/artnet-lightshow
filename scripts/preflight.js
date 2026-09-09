#!/usr/bin/env node
'use strict';

/**
 * Pre-show preflight: one command that checks everything that fails quietly.
 *
 *   npm run preflight
 *
 * Exits 0 when nothing is broken, 1 when something will not work. Warnings do
 * not fail the run — a missing PANNs checkpoint or a node that ignores ArtPoll
 * is worth knowing about, not worth blocking on.
 *
 * Runs standalone: it reads the same config/settings.json the server does, so
 * it can be run before the server is started, or alongside it.
 */

require('dotenv').config();

const path = require('path');
const { runPreflight } = require('../src/server/preflight');
const { AnalysisCache } = require('../src/analysis-cache');
const { spawnSync } = require('child_process');

// ANSI only when someone is actually looking at a terminal; piping this into a
// log or a CI job should produce plain text.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

const MARKS = {
  ok:   { glyph: '[ok]  ', color: '32' },
  warn: { glyph: '[warn]', color: '33' },
  fail: { glyph: '[FAIL]', color: '31' },
  info: { glyph: '[--]  ', color: '90' },
};

/** Wrap `text` to the terminal width, indented under the label column. */
function wrap(text, indent, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && (line.length + 1 + word.length) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : ' '.repeat(indent) + l)).join('\n');
}

async function main() {
  if (process.argv.includes('--download-models')) {
    const python = process.env.ARTNET_PYTHON || 'python';
    console.log('  Downloading pretrained analysis weights from Hugging Face…');
    const result = spawnSync(python, [path.join(__dirname, 'download-models.py')], {
      stdio: 'inherit', env: process.env,
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  const analysisCache = new AnalysisCache(path.join(__dirname, '..', 'cache', 'analysis'));

  console.log('\n  Pre-show preflight\n');

  // No live subsystems here: this runs before (or beside) the server, so the
  // MIDI/Spotify/PRO DJ LINK checks report what is configured rather than what
  // is connected. Everything that matters for output and analysis is checked
  // from the stored config, which is the same config the server will read.
  const report = await runPreflight({ analysisCache });

  const labelWidth = Math.max(...report.checks.map((c) => c.label.length));
  // Two spaces, a six-character mark, a space, the label column, two spaces.
  const indent = 2 + 6 + 1 + labelWidth + 2;
  const gutter = ' '.repeat(indent);
  const width = Math.max(40, (process.stdout.columns || 100) - indent);

  for (const check of report.checks) {
    const mark = MARKS[check.status];
    const label = check.label.padEnd(labelWidth);
    console.log(`  ${paint(mark.color, mark.glyph)} ${label}  ${wrap(check.detail, indent, width)}`);
    if (check.fix && check.status !== 'ok' && check.status !== 'info') {
      console.log(`${gutter}${paint('90', wrap(`→ ${check.fix}`, indent, width))}`);
    }
  }

  const { counts } = report;
  console.log('');
  if (report.ok && !counts.warn) {
    console.log(`  ${paint('32', 'Ready.')} ${counts.ok} checks passed.\n`);
  } else if (report.ok) {
    console.log(`  ${paint('33', 'Ready, with warnings.')} `
      + `${counts.ok} passed, ${counts.warn} to look at.\n`);
  } else {
    console.log(`  ${paint('31', 'Not ready.')} `
      + `${counts.fail} problem${counts.fail === 1 ? '' : 's'} to fix, ${counts.warn} warning${counts.warn === 1 ? '' : 's'}.\n`);
  }

  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  Preflight could not run: ${err.stack || err.message}\n`);
  process.exit(1);
});
