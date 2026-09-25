// The packaged build's executable: Node itself, made a single executable
// application (scripts/package.js) whose own script is this one. It runs the
// app beside it, as `npm start` would:
//
//   ArtNet Lightshow.exe    this
//   app/                    server.js, src/, public/, node_modules/, the Python lockfile
//   tools/uv.exe            what sets the analysis environment up (python-setup.ts)
//   portable                there when unzipped: keep the data beside the app
//
// The supervisor forks the server as this same executable (a SEA runs its own
// script whatever it is given, src/supervisor.ts), so this runs twice — for
// the supervisor, then for the server — and the environment it sets the first
// time is what the second one inherits.
//
// CommonJS, and nothing but Node's own modules: that is all a single
// executable's main script can load. The app itself is ordinary files on disk,
// imported from here.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/**
 * Where the data goes — the configuration, the analysis cache and
 * environment, the logs: beside the app when it was unzipped as a portable
 * copy (there is a `portable` file), else the user's own application data,
 * where an installed copy can write. LIGHTSHOW_DATA_DIR overrides both.
 */
function dataDirFor({ root, platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.LIGHTSHOW_DATA_DIR && env.LIGHTSHOW_DATA_DIR.trim()) return env.LIGHTSHOW_DATA_DIR;
  if (exists(p.join(root, 'portable'))) return p.join(root, 'data');
  if (platform === 'win32') return p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'ArtNet Lightshow');
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'ArtNet Lightshow');
  return p.join(env.XDG_DATA_HOME || p.join(home, '.local', 'share'), 'artnet-lightshow');
}

function main() {
  const root = path.dirname(process.execPath);
  const app = path.join(root, 'app');

  if (process.argv.includes('--version')) {
    const { version } = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    console.log(`ArtNet Lightshow ${version} (Node ${process.version})`);
    return;
  }

  const data = dataDirFor({ root });
  process.env.LIGHTSHOW_DATA_DIR = data;
  process.env.LIGHTSHOW_PACKAGED = '1';
  fs.mkdirSync(data, { recursive: true });
  // The data folder is where this installation's .env lives (src/load-env.ts
  // reads the working directory's), whatever folder it was started from.
  process.chdir(data);
  if (process.env.LIGHTSHOW_SUPERVISED !== '1') process.title = 'ArtNet Lightshow';

  import(pathToFileURL(path.join(app, 'server.js')).href).catch((err) => {
    console.error(`\nArtNet Lightshow could not start: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
}

// Run as the executable; required by the tests, only the parts.
if (require('node:sea').isSea()) main();

module.exports = { dataDirFor };
