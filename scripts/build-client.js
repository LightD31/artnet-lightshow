import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const outdir = path.join(import.meta.dirname, '..', 'public');

// Write the chunk manifest so the service worker can cache content-hashed bundles.
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
  // Split view-only dependencies so every tablet does not download Three.js on initial load.
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  target: ['es2020'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
  loader: { '.js': 'jsx' },
  plugins: [chunkList],
};

fs.rmSync(path.join(outdir, 'chunks'), { recursive: true, force: true });

if (watch) {
  esbuild.context(opts).then((ctx) => ctx.watch());
} else {
  esbuild.build(opts).catch(() => process.exit(1));
}
