export const EXIT_RESTART = 75;
export const EXIT_CONFIG = 78;

export interface LastExit {
  code: number | null;
  signal: string | null;
  reason: string;
  at: string;
}

export interface Supervision {
  supervised: boolean;
  restarts: number;
  lastExit: LastExit | null;
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

export function startHeartbeat(send: Send | undefined = process.send?.bind(process), everyMs = 1000): () => void {
  if (!send) return () => {};
  const beat = () => { try { send({ type: 'heartbeat' }); } catch (_) { /* the supervisor is gone */ } };
  try { send({ type: 'ready' }); } catch (_) { /* the supervisor is gone */ }
  const timer = setInterval(beat, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface SupervisorHandlers {
  stop: (signal: string) => void;
  gone: () => void;
}

interface Channel {
  on(event: 'message', fn: (message: unknown) => void): unknown;
  on(event: 'disconnect', fn: () => void): unknown;
}

export function listenToSupervisor(handlers: SupervisorHandlers,
  channel: Channel | null = process.send ? process as Channel : null): void {
  if (!channel) return;
  channel.on('message', (message) => {
    const m = (message && typeof message === 'object' ? message : {}) as { type?: unknown; signal?: unknown };
    if (m.type === 'stop') handlers.stop(typeof m.signal === 'string' && m.signal ? m.signal : 'SIGTERM');
  });
  channel.on('disconnect', () => handlers.gone());
}
