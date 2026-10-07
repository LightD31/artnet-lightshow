import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const outdir = path.join(import.meta.dirname, '..', 'public');

// The chunks are named by their content, so the service worker (sw.js) cannot
// list them: it reads their names from chunks/index.json, written here after
// every build, and keeps them with the rest of the shell.
const chunkList = {
  name: 'chunk-list',
  setup(build) {
    build.onEnd(() => {
      const dir = path.join(outdir, 'chunks');
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort().map((f) => `/chunks/${f}`);
      fs.writeFileSync(path.join(dir, 'index.json'), `${JSON.stringify(files, null, 1)}\n`);
    });
  },
};

const opts = {
  entryPoints: { 'app.bundle': path.join(import.meta.dirname, '..', 'public-src', 'main.jsx') },
  outdir,
  bundle: true,
  // ES modules, split: what only one view needs — three.js, for the Stage
  // view — is its own chunk, fetched the first time that view opens rather
  // than by every page load on every tablet.
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: ['es2020'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !watch,
  // Emitted for the minified build too. The bundle is served from the same
  // machine that runs the show, so the .map costs nothing until someone opens
  // devtools — and the moment it is worth having is a stack trace from a crash
  // mid-set, which without this reads as one column of a single minified line.
  sourcemap: true,
  logLevel: 'info',
  loader: { '.js': 'jsx' },
  plugins: [chunkList],
};

// Chunks are named by their content: clear out the last build's, or every
// build would leave its three.js behind.
fs.rmSync(path.join(outdir, 'chunks'), { recursive: true, force: true });

if (watch) {
  esbuild.context(opts).then((ctx) => ctx.watch());
} else {
  esbuild.build(opts).catch(() => process.exit(1));
}
