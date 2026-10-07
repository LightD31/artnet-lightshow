const REPORT_INTERVAL_MS = 5000;
const reports = new Map<string, { at: number; suppressed: number }>();

function report(where: string, err: unknown): void {
  const now = Date.now();
  const last = reports.get(where) || { at: -Infinity, suppressed: 0 };
  if (now - last.at < REPORT_INTERVAL_MS) {
    last.suppressed++;
    reports.set(where, last);
    return;
  }
  const extra = last.suppressed ? ` (and ${last.suppressed} more since the last report)` : '';
  reports.set(where, { at: now, suppressed: 0 });
  const stack = err && typeof err === 'object' ? (err as { stack?: unknown }).stack : undefined;
  const detail = stack ? stack : String(err);
  console.error(`[${where}] ${detail}${extra}`);
}

// Catch timer callback failures so one bad frame does not end the render loop.
function guarded<A extends unknown[], R, T = unknown>(where: string,
  fn: (this: T, ...args: A) => R): (this: T, ...args: A) => R | undefined {
  return function guardedCall(this: T, ...args: A): R | undefined {
    try {
      return fn.apply(this, args);
    } catch (err) {
      report(where, err);
      return undefined;
    }
  };
}

let installed = false;

function installProcessSafetyNet(): void {
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
