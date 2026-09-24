import { signal } from '@preact/signals';
import { post } from './setup-state.js';
import { toast } from './state.js';

/**
 * What the Rig view's parts share: which fixtures are selected (the plan,
 * the patch table and the inspector all show and change it), and asking
 * fixtures to show themselves on the rig.
 */

/** The selected fixtures' ids, in the order they were picked. */
export const rigSelectionSig = signal([]);

export function selectOnly(id) { rigSelectionSig.value = id === null || id === undefined ? [] : [id]; }

export function toggleSelected(id) {
  const now = rigSelectionSig.value;
  rigSelectionSig.value = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
}

/**
 * Flash fixtures on the rig — a par blinks, a bar marks its first cell green
 * and its last red — for `seconds` (the server's default when omitted; 0
 * stops). Says so when nothing is patched where it was asked.
 */
export async function identify(body, seconds) {
  const res = await post('/api/identify', seconds === undefined ? body : { ...body, seconds });
  if (res.ok && !res.ids.length && seconds !== 0) toast.info('Nothing is patched there to identify');
  return res;
}

export const identifyFixtures = (ids, seconds) => identify({ fixtures: ids }, seconds);
export const stopIdentify = () => post('/api/identify/stop', {});
