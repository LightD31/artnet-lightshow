'use strict';

// Stand-in for essentia-analyze.py --worker. Speaks the same NDJSON protocol and
// misbehaves on demand so the worker's failure handling can be tested.
// FAKE_MODE: ok (default) | hang | wrongid | crash
const readline = require('node:readline');

const mode = process.env.FAKE_MODE || 'ok';
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (mode === 'hang') return;
  if (mode === 'crash') process.exit(1);
  const id = mode === 'wrongid' ? req.id + 999 : req.id;
  process.stdout.write(JSON.stringify({ id, result: { bpm: 128, source: req.source } }) + '\n');
});
