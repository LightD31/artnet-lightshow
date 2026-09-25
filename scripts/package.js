#!/usr/bin/env node
/**
 * Build the packaged app: a folder, and an archive of it, that runs on a
 * machine with nothing installed — no Node, no Python.
 *
 *   npm run package                   for this machine
 *   npm run package -- --no-archive   the folder only
 *
 * dist/ArtNet-Lightshow-<version>-<platform>-<arch>/
 *   ArtNet Lightshow.exe   Node (the one running this script), made a single
 *                          executable application whose script is
 *                          scripts/sea-main.cjs; `artnet-lightshow` on Linux
 *   app/                   server.js, src/, the built public/, the production
 *                          node_modules, the Python lockfile
 *   tools/uv(.exe)         uv, which sets the analysis environment up
 *                          (src/server/python-setup.ts), from PyPI, checked
 *   browser-extension/     the Deezer extension, to load into a browser
 *   portable               keep the data in data/, beside the app
 *   README.txt
 *
 * Built on the platform it is for: node_modules holds native modules (MIDI,
 * the rekordbox database) and npm installs the ones for the machine it runs
 * on — CI builds the Windows package on Windows. The app is not bundled: it
 * runs from its own files exactly as `npm start` does, so what the tests test
 * is what ships.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import postject from 'postject';
import * as ResEdit from 'resedit';

const ROOT = path.join(import.meta.dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// The uv the package carries, and the wheel each platform takes it from.
const UV_VERSION = '0.8.17';
const UV_WHEELS = {
  'win32-x64': 'win_amd64',
  'win32-arm64': 'win_arm64',
  'linux-x64': 'manylinux_2_17_x86_64',
  'linux-arm64': 'manylinux_2_17_aarch64',
};
// Node's own, from its SEA documentation: where the blob goes.
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const APP_FILES = ['server.js', 'package.json', 'package-lock.json', 'LICENSE', 'pyproject.toml', 'uv.lock', 'requirements.txt'];
const APP_DIRS = ['src', 'public'];
// What the server and the analysis run from scripts/ (model-manager.ts, tagger.py, smtc-source.ts).
const APP_SCRIPTS = ['download-models.py', 'setup-panns.py', 'smtc-nowplaying.ps1'];

const args = process.argv.slice(2);
const archive = !args.includes('--no-archive');
const outAt = args.indexOf('--out');
const DIST = path.resolve(outAt >= 0 ? args[outAt + 1] : path.join(ROOT, 'dist'));

const target = `${process.platform}-${process.arch}`;
const windows = process.platform === 'win32';
const name = `ArtNet-Lightshow-${PKG.version}-${target}`;
const OUT = path.join(DIST, name);
const APP = path.join(OUT, 'app');
const EXE = path.join(OUT, windows ? 'ArtNet Lightshow.exe' : 'artnet-lightshow');

function step(what) { console.log(`\n▸ ${what}`); }

function run(command, commandArgs, options = {}) {
  const r = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (r.status !== 0) throw new Error(`${path.basename(command)} ${commandArgs.join(' ')} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
}

/** npm, as the Node running this script runs it (npm.cmd needs a shell on Windows). */
function npm(npmArgs, options) {
  if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, ...npmArgs], options);
  else run(windows ? 'npm.cmd' : 'npm', npmArgs, { shell: windows, ...options });
}

async function fetchChecked(url, sha256, cacheFile) {
  if (fs.existsSync(cacheFile)) {
    const cached = fs.readFileSync(cacheFile);
    if (crypto.createHash('sha256').update(cached).digest('hex') === sha256) return cached;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash('sha256').update(data).digest('hex');
  if (got !== sha256) throw new Error(`${url}: sha256 ${got}, PyPI says ${sha256}`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, data);
  return data;
}

/** uv's binary, out of its PyPI wheel, the download checked against PyPI's digest. */
async function fetchUv() {
  const tag = UV_WHEELS[target];
  if (!tag) throw new Error(`no uv wheel for ${target}`);
  const meta = await (await fetch(`https://pypi.org/pypi/uv/${UV_VERSION}/json`)).json();
  const wheel = meta.urls.find((u) => u.filename.endsWith('.whl') && u.filename.includes(tag));
  if (!wheel) throw new Error(`uv ${UV_VERSION} has no ${tag} wheel`);
  const data = await fetchChecked(wheel.url, wheel.digests.sha256, path.join(DIST, '.cache', wheel.filename));
  const zip = await JSZip.loadAsync(data);
  const binary = Object.keys(zip.files).find((f) => /^uv-[^/]+\.data\/scripts\/uv(\.exe)?$/.test(f));
  if (!binary) throw new Error(`no uv binary in ${wheel.filename}`);
  return zip.file(binary).async('nodebuffer');
}

/** The Windows executable's icon and the name Explorer and the task manager show. */
function brandWindowsExe(file) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const icons = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'public', 'favicon.ico')));
  const group = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)[0];
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group ? group.id : 1, group ? group.lang : 1033,
    icons.icons.map((icon) => icon.data));
  const [major, minor, patch] = PKG.version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const info = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const lang = info.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
  info.setFileVersion(major, minor, patch, 0, lang.lang);
  info.setProductVersion(major, minor, patch, 0, lang.lang);
  info.setStringValues(lang, {
    ProductName: 'ArtNet Lightshow',
    FileDescription: 'ArtNet Lightshow',
    InternalName: 'ArtNet Lightshow',
    OriginalFilename: 'ArtNet Lightshow.exe',
    CompanyName: '',
    LegalCopyright: '',
    ProductVersion: PKG.version,
    FileVersion: PKG.version,
  });
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
}

const README = `ArtNet Lightshow ${PKG.version}

Start it: ${windows ? 'double-click "ArtNet Lightshow.exe"' : 'run ./artnet-lightshow'}. It opens the app in your
browser (http://localhost:3000); closing its ${windows ? 'window' : 'terminal'} stops it, blacking the rig out first.
A fresh install opens the setup, which walks through the outputs, the fixtures and the music.

The automatic show analyses the music with Python, which is not needed for
anything else: set it up from the app, under Sources -> Analysis environment
(one button; it downloads a few gigabytes), then fetch the models under
Sources -> Analysis models.

Your settings, show, analysis cache, logs and the analysis environment are kept
in the "data" folder beside this file, because of the file called "portable".
Delete "portable" to keep them in your user folder instead${windows ? ' (%LOCALAPPDATA%\\ArtNet Lightshow)' : ' (~/.local/share/artnet-lightshow)'}.

browser-extension/ is the Deezer extension: load it into Chrome or Edge from
the extensions page (Developer mode -> Load unpacked).

The full manual: https://github.com/LightD31/artnet-lightshow#readme
`;

async function main() {
  if (!UV_WHEELS[target]) throw new Error(`packaging is for Windows and Linux (x64, arm64); this is ${target}`);
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('package with Node 22 or newer (24 LTS is what it is made for)');
  console.log(`Packaging ArtNet Lightshow ${PKG.version} for ${target}, with Node ${process.version}, into ${OUT}`);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(APP, { recursive: true });

  step('Building the page');
  run(process.execPath, [path.join(ROOT, 'scripts', 'build-client.js')]);

  step('Copying the app');
  const skip = (src) => !/(^|[\\/])__pycache__([\\/]|$)|\.pyc$|\.map$/.test(src);
  for (const file of APP_FILES) fs.copyFileSync(path.join(ROOT, file), path.join(APP, file));
  for (const dir of APP_DIRS) fs.cpSync(path.join(ROOT, dir), path.join(APP, dir), { recursive: true, filter: skip });
  fs.mkdirSync(path.join(APP, 'scripts'));
  for (const file of APP_SCRIPTS) fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(APP, 'scripts', file));
  fs.cpSync(path.join(ROOT, 'browser-extension'), path.join(OUT, 'browser-extension'), { recursive: true });

  step('Installing the production dependencies');
  npm(['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: APP });

  step(`Fetching uv ${UV_VERSION}`);
  const uv = path.join(OUT, 'tools', windows ? 'uv.exe' : 'uv');
  fs.mkdirSync(path.dirname(uv), { recursive: true });
  fs.writeFileSync(uv, await fetchUv(), { mode: 0o755 });

  step('Making the executable');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lightshow-sea-'));
  try {
    const blob = path.join(work, 'sea.blob');
    const config = path.join(work, 'sea-config.json');
    fs.writeFileSync(config, JSON.stringify({
      main: path.join(ROOT, 'scripts', 'sea-main.cjs'),
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    }));
    run(process.execPath, ['--experimental-sea-config', config]);
    fs.copyFileSync(process.execPath, EXE);
    fs.chmodSync(EXE, 0o755);
    await postject.inject(EXE, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: SEA_FUSE });
    // After the blob, not before: postject's PE rewriter finds the relocations
    // of a file whose resources resedit has already grown out of bounds, and
    // resedit keeps the blob's resource as it is.
    if (windows) brandWindowsExe(EXE);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  fs.writeFileSync(path.join(OUT, 'portable'),
    'This file keeps the data (settings, show, cache, logs) in the "data" folder beside the app.\n'
    + 'Delete it to keep them in your user folder instead.\n');
  fs.writeFileSync(path.join(OUT, 'README.txt'), windows ? README.replace(/\n/g, '\r\n') : README);

  if (archive) {
    step('Archiving');
    const file = path.join(DIST, `${name}${windows ? '.zip' : '.tar.gz'}`);
    fs.rmSync(file, { force: true });
    // Windows 10 and later carry bsdtar, which writes a zip for a .zip name —
    // named by its path, since the GNU tar that comes with Git cannot.
    if (windows) run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', file, '-C', DIST, name]);
    else run('tar', ['-czf', file, '-C', DIST, name]);
    console.log(`\n${file} (${Math.round(fs.statSync(file).size / 1e6)} MB)`);
  }
  console.log(`\nDone: ${OUT}`);
}

main().catch((err) => {
  console.error(`\npackaging failed: ${err.message}`);
  process.exit(1);
});
