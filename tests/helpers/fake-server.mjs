// A stand-in for the server under the supervisor (tests/unit/supervisor.test.js):
// it records how it was started, then does what FAKE_SERVER_PLAN says for
// this run — one word per run, in order: exit codes, "hang", "stay" (beat
// until told to stop, by a signal or by the supervisor), "restart" (ask to be
// started again), "nostart" (die before saying it is ready). Whatever ends a
// run that stays is recorded too.

import fs from 'node:fs';
import { listenToSupervisor } from '../../src/server/supervised.ts';

const run = Number(process.env.LIGHTSHOW_RESTARTS) || 0;
const plan = (process.env.FAKE_SERVER_PLAN || '0').split(',');
const step = plan[Math.min(run, plan.length - 1)];

fs.appendFileSync(process.env.FAKE_SERVER_RECORD, `${JSON.stringify({
  run,
  recover: process.env.LIGHTSHOW_RECOVER,
  lastExit: process.env.LIGHTSHOW_LAST_EXIT ? JSON.parse(process.env.LIGHTSHOW_LAST_EXIT).reason : null,
  execArgv: process.execArgv,
  nodeOptions: process.env.NODE_OPTIONS || '',
  pid: process.pid,
})}\n`);

if (step === 'nostart') process.exit(1);
process.send({ type: 'ready' });
const beat = setInterval(() => process.send({ type: 'heartbeat' }), 50);

if (step === 'hang') {
  clearInterval(beat);
  for (;;) { /* the main thread stuck */ }
} else if (step === 'stay') {
  const end = (how) => {
    clearInterval(beat);
    fs.appendFileSync(process.env.FAKE_SERVER_RECORD, `${JSON.stringify({ ended: how })}\n`);
    process.exit(0);
  };
  process.on('SIGTERM', () => end('SIGTERM'));
  listenToSupervisor({ stop: (signal) => end(`asked (${signal})`), gone: () => end('the supervisor has gone') });
} else if (step === 'restart') {
  process.send({ type: 'restart', reason: 'a setting' });
  setTimeout(() => process.exit(75), 20);
} else {
  setTimeout(() => process.exit(Number(step)), 30);
}
