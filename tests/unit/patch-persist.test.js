// The sync offset is dialled in 5 ms a detent. Each detent used to rewrite
// settings.json synchronously on the render thread; the save now waits for
// the hand to come off, while the value the show uses changes at once.

import test from 'node:test';
import assert from 'node:assert';
import { applyPatch, setPersist, flushPendingPersist } from '../../src/server/patch.ts';
import { state } from '../../src/server/state.ts';
import { conductor } from '../../src/server/conductor.ts';

test('a run of sync-offset nudges is saved once, with the last value', async () => {
  const saved = [];
  setPersist((patch) => saved.push(patch));
  const original = state.autoSyncOffsetMs;
  try {
    for (let ms = 5; ms <= 50; ms += 5) applyPatch({ autoSyncOffsetMs: ms });
    assert.strictEqual(state.autoSyncOffsetMs, 50, 'the show uses the new value at once');
    assert.strictEqual(saved.length, 0, 'nothing written while the encoder is still turning');

    await new Promise((r) => setTimeout(r, 900));
    assert.deepStrictEqual(saved, [{ auto: { syncOffsetMs: 50 } }]);
  } finally {
    applyPatch({ autoSyncOffsetMs: original });
    flushPendingPersist();
    setPersist(() => {});
  }
});

test('a nudge still waiting is saved on the way down', () => {
  const saved = [];
  setPersist((patch) => saved.push(patch));
  const original = state.autoSyncOffsetMs;
  try {
    applyPatch({ autoSyncOffsetMs: 125 });
    flushPendingPersist();
    assert.deepStrictEqual(saved, [{ auto: { syncOffsetMs: 125 } }]);
    flushPendingPersist();
    assert.strictEqual(saved.length, 1, 'nothing left to save the second time');
  } finally {
    applyPatch({ autoSyncOffsetMs: original });
    flushPendingPersist();
    setPersist(() => {});
  }
});

// Whether the clock follows the music is the operator's standing choice, kept
// across a restart, and written once per change rather than once per press.
test('the tempo mode is saved when it changes, and a refused one changes nothing', () => {
  const saved = [];
  setPersist((patch) => saved.push(patch));
  try {
    applyPatch({ tempoMode: 'manual' });
    applyPatch({ tempoMode: 'manual' });
    assert.deepStrictEqual(saved, [{ clock: { tempoMode: 'manual' } }]);
    assert.deepStrictEqual([state.tempoMode, conductor.tempoMode], ['manual', 'manual']);

    assert.throws(() => applyPatch({ tempoMode: 'sometimes' }), (err) => err.status === 400 && /tempoMode/.test(err.message));
    assert.deepStrictEqual([state.tempoMode, conductor.tempoMode], ['manual', 'manual']);

    applyPatch({ tempoMode: 'auto' });
    assert.deepStrictEqual(saved, [{ clock: { tempoMode: 'manual' } }, { clock: { tempoMode: 'auto' } }]);
    // 'auto' again follows the music (it ends a tempo held by hand): no change to store.
    applyPatch({ tempoMode: 'auto' });
    assert.strictEqual(saved.length, 2);
  } finally {
    applyPatch({ tempoMode: 'auto' });
    setPersist(() => {});
  }
});
