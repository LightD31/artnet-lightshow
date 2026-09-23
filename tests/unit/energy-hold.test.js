import test from 'node:test';
import assert from 'node:assert';
import { EnergyHold, HOLD_TIMEOUT_MS } from '../../src/server/energy-hold.ts';

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
