import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let timelineDetails;
test.before(async () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '../../public-src/timeline-state.js'), 'utf8');
  ({ timelineDetails } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
});

test('timeline details identify the section and nearby lighting events', () => {
  const result = timelineDetails({
    duration: 20,
    segments: [{ start: 0, end: 10, role: 'verse' }],
    timeline: [
      { timeMs: 5050, action: 'patch', pattern: 'chase' },
      { timeMs: 5300, action: 'energy', id: 'blinder' },
      { timeMs: 7000, action: 'patch', colorA: 2 },
    ],
  }, 5200);
  assert.equal(result.section, 'verse');
  assert.equal(result.percent, 26);
  assert.deepEqual(result.events.map((event) => event.label), ['Pattern: chase', 'blinder burst']);
});

test('timeline details clip pointer positions and ignore distant events', () => {
  const result = timelineDetails({ duration: 10, segments: [], timeline: [{ timeMs: 1000, action: 'patch' }] }, -500);
  assert.equal(result.positionMs, 0);
  assert.equal(result.percent, 0);
  assert.deepEqual(result.events, []);
});
