#!/usr/bin/env node

import '../src/load-env.ts';

import { spawn } from 'node:child_process';
import { createPythonSetup, detectBuild, buildsFor, findUv, BUILDS } from '../src/server/python-setup.ts';
import { venvDir } from '../src/server/config-dir.ts';

const at = process.argv.indexOf('--build');
const asked = at >= 0 ? process.argv[at + 1] : null;
const allowed = buildsFor();
if (asked && !allowed.includes(asked)) {
  console.error(`--build must be one of: ${allowed.join(', ')}`);
  process.exit(2);
}

const uv = findUv();
if (!uv) {
  console.error('uv is not installed. Install it (https://docs.astral.sh/uv/getting-started/installation/) and run this again.');
  process.exit(1);
}
const detected = await detectBuild();
const build = asked || detected.build;
console.log(`Setting up the analysis environment in ${venvDir()}`);
console.log(`  torch build: ${BUILDS[build].label}${asked ? '' : ` (${detected.why})`}`);
console.log(`  uv: ${uv.command}\n`);

const setup = createPythonSetup({
  spawner: (command, args, options) => {
    const child = spawn(command, args, options);
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    return child;
  },
});
const job = setup.start(build);
while (job.ok === null) await new Promise((resolve) => setTimeout(resolve, 200));
if (job.ok) {
  console.log('\nDone. Fetch the models the show needs with: npm run preflight  (or from the page, Sources → Analysis models).');
} else {
  console.error(`\nIt failed: ${job.error}`);
  process.exit(1);
}
