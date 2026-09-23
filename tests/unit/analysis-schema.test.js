// The analysis document's schema is the one description of it that the Python
// analyser and the TypeScript show engine share. The analyser's tests validate
// its output against the schema (tests/python/test_schema.py and
// test_pipeline.py); these make sure the TypeScript side is generated from the
// same file, so neither can change without the other.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';

import { generate, readSchema, TYPES_FILE } from '../../scripts/gen-analysis-types.ts';

test('src/types/analysis.ts is generated from the current schema', () => {
  const expected = generate(readSchema());
  const actual = fs.readFileSync(TYPES_FILE, 'utf8');
  assert.ok(actual === expected, 'out of date — run `npm run gen:analysis-types` and commit the result');
});

test('every reference in the schema names a definition it has', () => {
  const schema = readSchema();
  const refs = JSON.stringify(schema).match(/"\$ref":"[^"]+"/g) || [];
  for (const ref of refs) {
    const name = ref.match(/#\/\$defs\/([^"]+)/)[1];
    assert.ok(schema.$defs[name], `${ref} points at a definition that does not exist`);
  }
  assert.ok(refs.length > 10);
});

test('the generated types describe the document the show engine reads', () => {
  const source = fs.readFileSync(TYPES_FILE, 'utf8');
  for (const name of ['AnalysisDocument', 'Section', 'MusicalEvent', 'Drop', 'Span', 'CurvePoint', 'Mood', 'Genre']) {
    assert.match(source, new RegExp(`export (interface|type) ${name}\\b`));
  }
  assert.match(source, /^\s+beats: number\[\];$/m, 'beats is required');
  assert.match(source, /^\s+level: "low" \| "mid" \| "high";$/m, 'enums become unions');
  assert.match(source, /^\s+sources\?: Record<string, number> \| null;$/m, 'maps and null');
});
