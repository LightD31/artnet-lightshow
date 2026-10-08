import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHex, toHex, paletteBodySchema, resolveGradient } from '../../src/shared/palette-model.ts';

const red = parseHex('#FF0000'), blue = parseHex('#0000FF');
const gradient = (extra = {}) => ({ name: 'main', space: 'rgb', wrap: false, stops: [{ at: 0, slot: 0 }, { at: 1, slot: 1 }], ...extra });

test('wire colours preserve every emitter through canonical round trips', () => {
  for (const hex of ['#123', '#123456', '#12345678', '#123456789A', '#123456789ABC']) {
    const colour = parseHex(hex);
    assert.deepEqual(parseHex(toHex(colour)), colour);
  }
  assert.equal(toHex({ r: 0, g: 0, b: 0, w: 0, a: 0, uv: 255 }), '#0000000000FF');
  assert.equal(toHex({ r: 0, g: 0, b: 0, w: 0, a: 255, uv: 0 }), '#00000000FF');
  assert.equal(toHex(parseHex('#ffffff000000')), '#FFFFFF');
  for (const bad of ['#12345', '#1234567', '#123456789ABCD', '#GG0000']) assert.throws(() => parseHex(bad));
});

test('old palette lists retain their colours and random slots', () => {
  const old = { colours: ['#aBc', '#12345678', { random: true }] };
  assert.deepEqual(paletteBodySchema.parse(old), { colours: ['#AABBCC', '#12345678', { random: true }] });
  assert.equal(resolveGradient(old, [red, blue]), null);
});

test('gradient validation rejects broken references and ambiguous stops', () => {
  const valid = { colours: ['#FF0000', '#0000FF'], gradients: [gradient()] };
  for (const patch of [
    { gradients: [gradient(), gradient()] },
    { gradients: [gradient({ stops: [{ at: 0, slot: 0 }, { at: 0, slot: 1 }] })] },
    { gradients: [gradient({ stops: [{ at: 0, slot: 0 }, { at: 1, slot: 2 }] })] },
    { gradients: [gradient({ stops: [{ at: 0, slot: 0, colour: '#FFFFFF' }, { at: 1, slot: 1 }] })] },
    { sets: [{ name: 'set', roles: ['missing'] }] },
    { gradient: 'missing' }, { gradientSet: 'missing' },
  ]) assert.throws(() => paletteBodySchema.parse({ ...valid, ...patch }));
});

test('RGB gradients interpolate all six emitters and clamp endpoints', () => {
  const a = parseHex('#000000000000'), b = parseHex('#FFFFFFFFFFFF');
  const ramp = resolveGradient({ gradients: [gradient()] }, [a, b]);
  assert.deepEqual(ramp.sample(-1), a);
  assert.deepEqual(ramp.sample(2), b);
  assert.deepEqual(ramp.sample(0.5), parseHex('#808080808080'));
});

test('wrapped gradients interpolate the seam and preserve step boundaries', () => {
  const stops = [{ at: 0.25, slot: 0 }, { at: 0.75, slot: 1 }];
  const rgb = resolveGradient({ gradients: [gradient({ wrap: true, stops })] }, [red, blue]);
  assert.deepEqual(rgb.sample(0), parseHex('#800080'));
  assert.deepEqual(rgb.sample(-0.75), red);
  assert.deepEqual(rgb.sample(1.75), blue);
  const step = resolveGradient({ gradients: [gradient({ space: 'step', wrap: true, stops })] }, [red, blue]);
  assert.deepEqual(step.sample(0.74), red);
  assert.deepEqual(step.sample(0.75), blue);
});

test('perceptual gradients retain emitter endpoints and avoid grey midpoints', () => {
  const ramp = resolveGradient({ gradients: [gradient({ space: 'oklch' })] }, [red, blue]);
  assert.deepEqual(ramp.sample(0), red);
  assert.deepEqual(ramp.sample(1), blue);
  assert.ok(ramp.sample(0.5).r > ramp.sample(0.5).g);
  assert.ok(ramp.sample(0.5).b > ramp.sample(0.5).g);
});

test('named gradient sets select a role without changing their slots', () => {
  const body = paletteBodySchema.parse({ colours: ['#FF0000', '#0000FF'],
    gradients: [gradient(), gradient({ name: 'reverse', stops: [{ at: 0, slot: 1 }, { at: 1, slot: 0 }] })],
    sets: [{ name: 'duet', roles: ['main', 'reverse'] }], gradientSet: 'duet', gradientRole: 1 });
  assert.deepEqual(resolveGradient(body, [red, blue]).sample(0), blue);
  assert.deepEqual(resolveGradient({ ...body, gradientRole: 0 }, [red, blue]).sample(0), red);
  assert.deepEqual(body.colours, ['#FF0000', '#0000FF']);
});

test('slot gradients follow resolved random colours without changing fixed stops', () => {
  const body = { gradients: [gradient({ stops: [{ at: 0, slot: 0 }, { at: 1, colour: '#0000000000FF' }] })] };
  assert.deepEqual(resolveGradient(body, [red]).sample(0), red);
  assert.deepEqual(resolveGradient(body, [blue]).sample(0), blue);
  assert.deepEqual(resolveGradient(body, [blue]).sample(1), parseHex('#0000000000FF'));
});
