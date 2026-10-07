import { signal } from '@preact/signals';
import { post } from './setup-state.js';
import { toast } from './state.js';


export const rigSelectionSig = signal([]);

export function selectOnly(id) { rigSelectionSig.value = id === null || id === undefined ? [] : [id]; }

export function toggleSelected(id) {
  const now = rigSelectionSig.value;
  rigSelectionSig.value = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
}

export async function identify(body, seconds) {
  const res = await post('/api/identify', seconds === undefined ? body : { ...body, seconds });
  if (res.ok && !res.ids.length && seconds !== 0) toast.info('Nothing is patched there to identify');
  return res;
}

export const identifyFixtures = (ids, seconds) => identify({ fixtures: ids }, seconds);
export const stopIdentify = () => post('/api/identify/stop', {});
