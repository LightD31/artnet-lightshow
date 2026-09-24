// The live page's end of protocol v2 (public-src/store.js) and its faders'
// drafts (public-src/draft.js): state held one signal per key and kept by
// versioned patches, and a slider that sends once a frame and does not snap
// back under the hand.

import test from 'node:test';
import assert from 'node:assert';
import { effect } from '@preact/signals';

import { createStore } from '../../public-src/store.js';
import { createFrameThrottle, createDraft, SETTLE_MS } from '../../public-src/draft.js';

test('a snapshot, then patches in order; a gap is reported and a stale patch ignored', () => {
  const store = createStore();
  assert.strictEqual(store.applyPatch({ d: 'look', v: 1, set: { masterDimmer: 1 } }), 'gap', 'nothing before a snapshot');
  store.applySnapshot({ versions: { look: 4, rig: 2 }, state: { masterDimmer: 255, pattern: 'chase', fixtures: [] } });
  assert.strictEqual(store.field('masterDimmer').value, 255);

  assert.strictEqual(store.applyPatch({ d: 'look', v: 5, set: { masterDimmer: 100 } }), 'ok');
  assert.strictEqual(store.field('masterDimmer').value, 100);
  assert.strictEqual(store.applyPatch({ d: 'look', v: 5, set: { masterDimmer: 7 } }), 'stale');
  assert.strictEqual(store.field('masterDimmer').value, 100, 'a replayed patch changes nothing');
  assert.strictEqual(store.applyPatch({ d: 'look', v: 7, set: { masterDimmer: 7 } }), 'gap', 'one went missing');
  assert.strictEqual(store.applyPatch({ d: 'sources', v: 1, set: { spotify: { ok: 1 } } }), 'ok', 'a domain first seen starts at 1');
  assert.strictEqual(store.applyPatch({ d: 'rig', v: 3, set: {}, del: ['fixtures'] }), 'ok');
  assert.strictEqual(store.field('fixtures').value, undefined);
  assert.deepStrictEqual(Object.keys(store.all.value).sort(), ['masterDimmer', 'pattern', 'spotify']);
  assert.deepStrictEqual(store.versions(), { look: 5, rig: 3, sources: 1 });
});

test('a component reading one key is woken by that key and nothing else', () => {
  const store = createStore();
  store.applySnapshot({ versions: { look: 0, sources: 0 }, state: { masterDimmer: 255, spotify: { t: 0 } } });
  let wakes = 0;
  const stop = effect(() => { store.field('masterDimmer').value; wakes++; });
  assert.strictEqual(wakes, 1);
  store.applyPatch({ d: 'sources', v: 1, set: { spotify: { t: 1 } } });
  store.applyPatch({ d: 'sources', v: 2, set: { spotify: { t: 2 } } });
  assert.strictEqual(wakes, 1, 'Spotify ticking over does not touch the master');
  store.applyPatch({ d: 'look', v: 1, set: { masterDimmer: 10 } });
  assert.strictEqual(wakes, 2);
  store.applyPatch({ d: 'look', v: 2, set: { masterDimmer: 10 } });
  assert.strictEqual(wakes, 2, 'the same value again is not a change');
  stop();

  let all = 0;
  const stopAll = effect(() => { store.all.value; all++; });
  store.applyPatch({ d: 'look', v: 3, set: { pattern: 'fade' } });
  assert.strictEqual(all, 2, 'the whole-state view sees a new key');
  assert.strictEqual(store.all.value.pattern, 'fade');
  stopAll();
});

test('a moving fader sends the latest value once a frame, not every input', () => {
  const sent = [];
  const frames = [];
  const throttle = createFrameThrottle((v) => sent.push(v), (fn) => frames.push(fn));
  throttle.push(1);
  throttle.push(2);
  throttle.push(3);
  assert.deepStrictEqual(sent, [], 'nothing until the frame');
  assert.strictEqual(frames.length, 1, 'one frame asked for');
  frames.shift()();
  assert.deepStrictEqual(sent, [3], 'the latest');
  throttle.push(4);
  throttle.flush();
  assert.deepStrictEqual(sent, [3, 4], 'let go: at once');
  frames.shift()();
  assert.deepStrictEqual(sent, [3, 4], 'and not again when the frame comes');
});

test('the draft is shown while the hand is on it, and gives way once the server agrees', () => {
  let t = 0;
  const sent = [];
  const frames = [];
  const draft = createDraft({ send: (v) => sent.push(v), schedule: (fn) => frames.push(fn), now: () => t });
  assert.strictEqual(draft.value(50), 50, 'no draft: the server\'s value');
  draft.input(80);
  draft.observe(40);                 // an echo from before the drag
  assert.strictEqual(draft.value(40), 80, 'no snap back mid-drag');
  frames.shift()();
  assert.deepStrictEqual(sent, [80]);
  draft.input(90);
  draft.commit(90);
  assert.deepStrictEqual(sent, [80, 90], 'the release value always goes');
  frames.splice(0).forEach((fn) => fn());
  assert.deepStrictEqual(sent, [80, 90], 'and is not sent twice');
  draft.observe(80);                 // an older echo still in flight
  assert.strictEqual(draft.value(80), 90, 'not flicking back to the last value but one');
  draft.observe(90);
  assert.strictEqual(draft.value(90), 90);
  assert.strictEqual(draft.settling, false, 'the server agreed: the draft is gone');

  // A released value the server never confirms (it refused it) gives way in time.
  draft.input(10);
  draft.commit(10);
  assert.strictEqual(draft.value(90), 10);
  t += SETTLE_MS + 1;
  assert.strictEqual(draft.value(90), 90);
});
