// A stand-in for `uv sync` (tests/unit/python-setup.test.js): it records how
// it was run, prints what uv prints when its output is not a terminal, and
// makes the environment's interpreter — or does what FAKE_UV_PLAN says:
// "fail" (exit 2 with uv's error line), "slow" (wait to be cancelled).

import fs from 'node:fs';
import path from 'node:path';

const plan = process.env.FAKE_UV_PLAN || 'ok';
fs.writeFileSync(process.env.FAKE_UV_RECORD, JSON.stringify({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  venv: process.env.UV_PROJECT_ENVIRONMENT,
  preference: process.env.UV_PYTHON_PREFERENCE,
  noColor: process.env.NO_COLOR,
}));

const say = (line) => process.stderr.write(`${line}\n`);
say('Downloading cpython-3.12.11-linux-x86_64-gnu (download) (29.9MiB)');
say(' Downloading cpython-3.12.11-linux-x86_64-gnu (download)');
say('Using CPython 3.12.11');
say(`Creating virtual environment at: ${process.env.UV_PROJECT_ENVIRONMENT}`);
say('Resolved 183 packages in 3ms');

if (plan === 'fail') {
  say('error: Distribution `torch==2.14.0+cu128 @ registry+https://download.pytorch.org/whl/cu128` can\'t be installed because it doesn\'t have a wheel for the current platform');
  process.exit(2);
}
say('Downloading torch (241.3MiB)');
if (plan === 'slow') {
  setInterval(() => {}, 1000);
} else {
  say('Downloading deno (39.7MiB)');
  say(' Downloading deno');
  say(' Downloading torch');
  say('Prepared 120 packages in 1m 02s');
  const bin = process.platform === 'win32' ? path.join(process.env.UV_PROJECT_ENVIRONMENT, 'Scripts') : path.join(process.env.UV_PROJECT_ENVIRONMENT, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
  say('Installed 120 packages in 2.1s');
  say(' + deno==2.9.7');
  say(' + torch==2.14.0+cpu');
}
