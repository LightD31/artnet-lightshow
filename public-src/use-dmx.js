import { useEffect } from 'preact/hooks';
import { wantDmx } from './state.js';

export function useDmxFeed(active = true) {
  useEffect(() => (active ? wantDmx() : undefined), [active]);
}
