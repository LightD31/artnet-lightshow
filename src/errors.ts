// Treat caught values as unknown because JavaScript can throw values other than Error.

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function codeOf(err: unknown): string | undefined {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}

export function cancelledError(what = 'analysis'): Error & { cancelled: true } {
  return Object.assign(new Error(`${what} cancelled`), { cancelled: true as const });
}

export function isCancelled(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { cancelled?: unknown }).cancelled === true;
}

export function statusOf(err: unknown): number | undefined {
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof status === 'number' ? status : undefined;
}
