/**
 * Errors, as the server throws and reports them.
 *
 * A caught value is `unknown` — anything can be thrown — so reading one goes
 * through the helpers here rather than assuming it is an Error.
 */

/**
 * An error that says which HTTP status it should answer with. The route
 * handlers send `status` and the message; anything thrown without one is a
 * 500.
 */
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A caught value's message: an Error's own, or the value as text. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A system error's code (ENOENT, EADDRINUSE…), if it has one. */
export function codeOf(err: unknown): string | undefined {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** The HTTP status an error asks to be answered with, if it names one. */
export function statusOf(err: unknown): number | undefined {
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : undefined;
}
