import { useEffect } from 'preact/hooks';
import { wantDmx } from './state.js';

/**
 * Keep the DMX feed coming while this view is on screen and `active`: the
 * server sends it only to pages that ask (src/server/protocol.ts).
 */
export function useDmxFeed(active = true) {
  useEffect(() => (active ? wantDmx() : undefined), [active]);
}
