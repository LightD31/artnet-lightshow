import net from 'node:net';

export function isLoopback(host: unknown): boolean {
  let h = String(host ?? '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h === '::1') return true;
  if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length);
  return net.isIPv4(h) && h.startsWith('127.');
}
