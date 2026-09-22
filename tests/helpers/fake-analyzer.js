'use strict';

// Stand-in for src/analyze.py --worker. Speaks the same NDJSON protocol and
// misbehaves on demand so the worker's failure handling can be tested.
// FAKE_MODE: ok (default) | hang | wrongid | crash | hangslow | gpufault
// gpufault answers, asks to be recycled, and would crash on a second request:
// a process whose GPU faulted is not to be trusted with another track.
// hangslow never answers a source containing "slow" and answers everything
// else at once — a prefetch that is still running when the next request lands.
const readline = require('node:readline');

const mode = process.env.FAKE_MODE || 'ok';
const rl = readline.createInterface({ input: process.stdin });
let served = 0;

rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (mode === 'hang') return;
  if (mode === 'hangslow' && String(req.source).includes('slow')) return;
  if (mode === 'crash') process.exit(1);
  if (mode === 'gpufault') {
    if (served++) process.exit(1);
    process.stdout.write(JSON.stringify({ id: req.id, result: { pid: process.pid }, recycle: true }) + '\n');
    return;
  }
  const id = mode === 'wrongid' ? req.id + 999 : req.id;
  process.stdout.write(JSON.stringify({ id, result: { bpm: 128, source: req.source } }) + '\n');
});
