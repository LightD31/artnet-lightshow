import net from 'node:net';

/**
 * Whether `host` means this machine only: `localhost`, `::1`, an address on
 * the IPv4 loopback network (127.0.0.0/8), or one mapped into IPv6
 * (`::ffff:127.0.0.1`, which is how a socket reports a local client on a
 * dual-stack listener). Takes a name, an address, a bracketed IPv6 literal or
 * a socket's remote address.
 *
 * One answer for everything that asks: whether binding to a host needs a
 * token, whether a request comes from this machine, what the pre-show check
 * says about access, and which Art-Net targets are worth polling.
 */
export function isLoopback(host: unknown): boolean {
  let h = String(host ?? '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost' || h === '::1') return true;
  if (h.startsWith('::ffff:')) h = h.slice('::ffff:'.length);
  return net.isIPv4(h) && h.startsWith('127.');
}
