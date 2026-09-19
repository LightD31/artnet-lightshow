'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fakeCanvas(width = 100, height = 50) {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_target, property) {
      if (property === 'createLinearGradient') return () => ({ addColorStop() {} });
      return (...args) => { calls.push({ property, args }); };
    },
    set(_target, property, value) { calls.push({ property, value }); return true; },
  });
  return {
    clientWidth: width, clientHeight: height, width: 0, height: 0, calls,
    getContext: () => ctx,
  };
}

let createTimelineRenderer;
test.before(async () => {
  global.window = { devicePixelRatio: 1 };
  global.document = { createElement: () => fakeCanvas() };
  const source = fs.readFileSync(path.join(__dirname, '../../public-src/timeline-renderer.js'), 'utf8');
  ({ createTimelineRenderer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
});

test('the renderer caches static chart work and redraws only a moving playhead', () => {
  const canvas = fakeCanvas();
  const background = fakeCanvas();
  const render = createTimelineRenderer(canvas, background);
  const data = { duration: 10 };

  assert.equal(render(data, 1000, { width: 100, height: 50, dpr: 1 }), true);
  const staticWork = background.calls.length;
  assert.equal(render(data, 1001, { width: 100, height: 50, dpr: 1 }), false, 'same physical pixel is free');
  assert.equal(background.calls.length, staticWork);
  assert.equal(render(data, 2000, { width: 100, height: 50, dpr: 1 }), true);
  assert.equal(background.calls.length, staticWork, 'playhead does not repaint the chart');
  assert.ok(canvas.calls.some((call) => call.property === 'drawImage'));
  render(data, 2000, { width: 200, height: 50, dpr: 1 });
  assert.ok(background.calls.length > staticWork, 'resize invalidates the static layer');
});

test('a changed timeline object invalidates the static layer', () => {
  const canvas = fakeCanvas();
  const background = fakeCanvas();
  const render = createTimelineRenderer(canvas, background);
  render({ duration: 10 }, 0, { width: 100, height: 50, dpr: 1 });
  const before = background.calls.length;
  render({ duration: 10 }, 0, { width: 100, height: 50, dpr: 1 });
  assert.ok(background.calls.length > before);
});
