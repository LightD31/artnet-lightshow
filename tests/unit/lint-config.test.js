// The lint run covers the project's sources, not the untracked agent
// workspace (.superpowers/), whose scripts are not modules of this repo.

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { ESLint } from 'eslint';

const root = path.join(import.meta.dirname, '..', '..');

test('eslint ignores the agent workspace and still lints the sources', async () => {
  const eslint = new ESLint({ cwd: root });
  assert.strictEqual(await eslint.isPathIgnored(path.join(root, '.superpowers/sdd/plan/workflow.js')), true);
  assert.strictEqual(await eslint.isPathIgnored(path.join(root, 'src/server/strobe.ts')), false);
});
