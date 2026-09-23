// Stand-in for src/analyze.py --worker. Speaks the same NDJSON protocol and
// misbehaves on demand so the worker's failure handling can be tested.
// FAKE_MODE: ok (default) | hang | wrongid | crash | hangslow | gpufault | env
// env answers with the separator flag it was started with, and its pid.
// gpufault answers, asks to be recycled, and would crash on a second request:
// a process whose GPU faulted is not to be trusted with another track.
// hangslow never answers a source containing "slow" and answers everything
// else at once — a prefetch that is still running when the next request lands.
// nanreply answers with a bare NaN in the result, the way Python's json.dumps
// writes one — valid Python output, unreadable JSON. exitnow dies before
// reading anything, so the first write to its stdin lands on a closed pipe.
// In hangslow, a source containing "late" is answered after 300 ms: long
// enough for recycled workers to die first.
import readline from 'node:readline';

const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'exitnow') process.exit(3);
const rl = readline.createInterface({ input: process.stdin });
let served = 0;

rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (mode === 'hang') return;
  if (mode === 'hangslow' && String(req.source).includes('slow')) return;
  if (mode === 'hangslow' && String(req.source).includes('late')) {
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ id: req.id, result: { bpm: 128, source: req.source, pid: process.pid } }) + '\n');
    }, 300);
    return;
  }
  if (mode === 'nanreply') {
    process.stdout.write(`{"id": ${req.id}, "result": {"bpm": NaN}}\n`);
    return;
  }
  if (mode === 'crash') process.exit(1);
  if (mode === 'env') {
    process.stdout.write(JSON.stringify({ id: req.id, result: { separator: process.env.ARTNET_USE_BS_ROFORMER, pid: process.pid } }) + '\n');
    return;
  }
  if (mode === 'gpufault') {
    if (served++) process.exit(1);
    process.stdout.write(JSON.stringify({ id: req.id, result: { pid: process.pid }, recycle: true }) + '\n');
    return;
  }
  const id = mode === 'wrongid' ? req.id + 999 : req.id;
  process.stdout.write(JSON.stringify({ id, result: { bpm: 128, source: req.source } }) + '\n');
});
