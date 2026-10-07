#!/usr/bin/env node

import '../src/load-env.ts';

import path from 'node:path';
import { runPreflight } from '../src/server/preflight.ts';
import { AnalysisCache } from '../src/analysis-cache.ts';
import { cacheDir } from '../src/server/config-dir.ts';
import * as pythonEnv from '../src/python-env.ts';
import { spawnSync } from 'node:child_process';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

const MARKS = {
  ok:   { glyph: '[ok]  ', color: '32' },
  warn: { glyph: '[warn]', color: '33' },
  fail: { glyph: '[FAIL]', color: '31' },
  info: { glyph: '[--]  ', color: '90' },
};

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
    const python = process.env.ARTNET_PYTHON || pythonEnv.pythonExe();
    console.log('  Downloading pretrained analysis weights from Hugging Face…');
    const result = spawnSync(python, [path.join(import.meta.dirname, 'download-models.py')], {
      stdio: 'inherit', env: process.env,
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  const analysisCache = new AnalysisCache(path.join(cacheDir(), 'analysis'));

  console.log('\n  Pre-show preflight\n');

  // Read stored configuration without live subsystems so preflight can run beside the server.
  const report = await runPreflight({ analysisCache, standalone: true });

  const labelWidth = Math.max(...report.checks.map((c) => c.label.length));
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
