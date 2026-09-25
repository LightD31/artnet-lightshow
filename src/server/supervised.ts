/**
 * The server's side of being supervised (src/supervisor.ts runs it).
 *
 * The supervisor starts the server as a child process with an IPC channel and
 * tells it, through its environment, how it came to be running:
 *
 *   LIGHTSHOW_SUPERVISED=1   there is a supervisor to heartbeat to
 *   LIGHTSHOW_RESTARTS=n     how many times it has had to start the server again
 *   LIGHTSHOW_LAST_EXIT=…    why the run before this one ended (JSON)
 *   LIGHTSHOW_RECOVER=1      this is a restart: put the look back (look-store.ts)
 *
 * The server answers with 'ready' once it is listening and a heartbeat every
 * second after — a server whose main thread stops beating is hung, and the
 * supervisor restarts it — and exits with EXIT_RESTART when it wants starting
 * again (a setting that only applies on a restart), or EXIT_CONFIG when
 * starting again would only fail the same way.
 */

/** Exit to be started again straight away (EX_TEMPFAIL). */
export const EXIT_RESTART = 75;
/** Exit because the configuration will not let the server start (EX_CONFIG): not restarted. */
export const EXIT_CONFIG = 78;

export interface LastExit {
  code: number | null;
  signal: string | null;
  /** In words: 'crashed with exit code 1', 'stopped responding'… */
  reason: string;
  at: string;
}

export interface Supervision {
  supervised: boolean;
  restarts: number;
  lastExit: LastExit | null;
  /** A restart the look should survive. */
  recovering: boolean;
}

export function supervision(env: NodeJS.ProcessEnv = process.env): Supervision {
  let lastExit: LastExit | null = null;
  try {
    const parsed = env.LIGHTSHOW_LAST_EXIT ? JSON.parse(env.LIGHTSHOW_LAST_EXIT) : null;
    if (parsed && typeof parsed === 'object' && typeof parsed.reason === 'string') lastExit = parsed;
  } catch (_) { /* not from the supervisor */ }
  return {
    supervised: env.LIGHTSHOW_SUPERVISED === '1',
    restarts: Math.max(0, Number(env.LIGHTSHOW_RESTARTS) || 0),
    lastExit,
    recovering: env.LIGHTSHOW_RECOVER === '1',
  };
}

type Send = (message: unknown) => unknown;

/**
 * Tell the supervisor the server is up, and keep telling it the main thread
 * is alive. A no-op without one.
 */
export function startHeartbeat(send: Send | undefined = process.send?.bind(process), everyMs = 1000): () => void {
  if (!send) return () => {};
  const beat = () => { try { send({ type: 'heartbeat' }); } catch (_) { /* the supervisor is gone */ } };
  try { send({ type: 'ready' }); } catch (_) { /* the supervisor is gone */ }
  const timer = setInterval(beat, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
