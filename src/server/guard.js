/**
 * Keep one fault from ending the show.
 *
 * Everything that drives the rig runs from a timer: the 44 Hz render, the beat
 * clock, the auto show's cursor, the status sweeps. A throw inside any of them
 * is an uncaught exception, and Node's answer to that is to exit — at which
 * point the fixtures latch whatever frame they last received and hold it for
 * the rest of the night, with nothing left running that could put them out.
 *
 * So faults are contained where they happen and reported, loudly but not at
 * frame rate: a bug in the render path would otherwise print forty identical
 * stack traces a second and bury everything else in the console.
 */

const REPORT_INTERVAL_MS = 5000;
const reports = new Map();       // where → { at, suppressed }

/** Log a contained fault, at most once per interval for each `where`. */
function report(where, err) {
  const now = Date.now();
  const last = reports.get(where) || { at: -Infinity, suppressed: 0 };
  if (now - last.at < REPORT_INTERVAL_MS) {
    last.suppressed++;
    reports.set(where, last);
    return;
  }
  const extra = last.suppressed ? ` (and ${last.suppressed} more since the last report)` : '';
  reports.set(where, { at: now, suppressed: 0 });
  const detail = err && err.stack ? err.stack : String(err);
  console.error(`[${where}] ${detail}${extra}`);
}

/**
 * Wrap a callback so a throw is reported instead of escaping. For timers:
 * `createTicker({ onTick: guarded('render', renderDmx) })` keeps rendering the
 * next frame even if this one failed.
 */
function guarded(where, fn) {
  return function guardedCall(...args) {
    try {
      return fn.apply(this, args);
    } catch (err) {
      report(where, err);
      return undefined;
    }
  };
}

let installed = false;

/**
 * The last line of defence, for faults that no guard was placed around: a
 * callback from a library, a promise nobody awaited.
 *
 * Staying up after an uncaught exception is not what Node recommends for a
 * web service, which would rather restart clean. A light show is the other
 * way round: the render loop is independent of whatever just failed, and a
 * rig that keeps running on slightly inconsistent state is far better than
 * one frozen on its last frame mid-set. The fault is still reported.
 */
function installProcessSafetyNet() {
  if (installed) return;
  installed = true;
  process.on('uncaughtException', (err) => report('uncaught exception', err));
  process.on('unhandledRejection', (reason) => report('unhandled rejection', reason));
}

export {
  guarded,
  report,
  installProcessSafetyNet,
  REPORT_INTERVAL_MS,
};
