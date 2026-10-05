// tests/unit/party-looks-golden.test.js
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { LOOKS, flatRig, placedRig, renderLookBytes } from '../../scripts/golden-party-looks.js';

const flat = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/party-looks-flat.json', import.meta.url), 'utf8'));
const placed = JSON.parse(fs.readFileSync(new URL('../fixtures/golden/party-looks-placed.json', import.meta.url), 'utf8'));

for (const id of LOOKS) {
  test(`${id} renders byte-identically on the flat rig`, () => assert.deepStrictEqual(renderLookBytes(id, flatRig()), flat[id]));
  test(`${id} renders byte-identically on the placed rig`, () => assert.deepStrictEqual(renderLookBytes(id, placedRig()), placed[id]));
}
