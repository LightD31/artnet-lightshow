import test from 'node:test';
import assert from 'node:assert';
import { EnergyHold, HOLD_TIMEOUT_MS } from '../../src/server/energy-hold.ts';
import { VoiceManager } from '../../src/server/voices.ts';

test('an energy hold releases on the matching token', () => {
  const events = [];
  const hold = new EnergyHold((effect) => events.push(effect));
  hold.press('socket-a', 'one', 'blinder');
  hold.release('socket-a', 'wrong');
  assert.deepStrictEqual(events, ['blinder']);
  hold.release('socket-a', 'one');
  assert.deepStrictEqual(events, ['blinder', null]);
});

test('disconnect and replacement cannot leave a hold latched', () => {
  const events = [];
  const hold = new EnergyHold((effect) => events.push(effect));
  hold.press('socket-a', 'one', 'blinder');
  hold.press('socket-b', 'two', 'glow');
  assert.deepStrictEqual(events, ['blinder', null, 'glow']);
  hold.disconnect('socket-b');
  assert.deepStrictEqual(events, ['blinder', null, 'glow', null]);
});

test('a hold expires when the release packet is lost', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const hold = new EnergyHold((effect) => events.push(effect));
  hold.press('socket-a', 'one', 'blinder');
  t.mock.timers.tick(HOLD_TIMEOUT_MS - 1);
  assert.deepStrictEqual(events, ['blinder']);
  t.mock.timers.tick(1);
  assert.deepStrictEqual(events, ['blinder', null]);
});

test("energy holds report only the voice above the latch", () => {
  const hold = new EnergyHold(() => {}, new VoiceManager({ now: () => performance.now(), onChange() {}, acknowledged: () => true }));
  const m = hold.voices;
  const start = (spec, extra = {}) => m.start({ spec, targets: 'shared', mode: 'latched', tier: 'voice', source: 'pad', ...extra });
  assert.strictEqual(hold.over(), null);
  const blinder = start({ kind: 'energy.blinder' });
  assert.strictEqual(hold.over(), 'blinder', 'a pad playing an energy kind');
  // A latch launched after it plays over it: the latch is energyOverride's, nothing is over it.
  hold.latch('kill');
  assert.deepStrictEqual([hold.over(), hold.latched()], [null, 'kill']);
  const uv = start({ kind: 'energy.uvWash' }, { source: 'api' });
  assert.strictEqual(hold.over(), 'uv-wash', 'the latest launch over the latch');
  // The energy hold hides the latch and shows, launched last.
  hold.press('socket-a', 'one', 'glow');
  assert.strictEqual(hold.over(), 'glow');
  hold.release('socket-a', 'one');
  assert.strictEqual(hold.over(), 'uv-wash');
  m.stop(uv.id);
  m.stop(blinder.id);
  hold.latch(null);
  // Other kinds, and the manual strobe even in the palette strobe's colours, are no energy effect.
  start({ kind: 'ldj.FadeCycle' });
  start({ kind: 'strobe', palette: null, params: { clock: 'beat', flashesPerSecond: 5, continueBetween: true } }, { source: 'strobe', tier: 'strobe' });
  assert.strictEqual(hold.over(), null);
  // The palette strobe's preset from a pad is; and the strobe tier outranks a later voice.
  start({ kind: 'strobe', palette: null, params: { clock: 'beat', flashesPerSecond: 5, continueBetween: true } }, { tier: 'strobe' });
  start({ kind: 'energy.kill' });
  assert.strictEqual(hold.over(), 'palette-strobe');
});
