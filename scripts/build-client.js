'use strict';

const path = require('path');
const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: [path.join(__dirname, '..', 'public-src', 'main.jsx')],
  outfile: path.join(__dirname, '..', 'public', 'app.bundle.js'),
  bundle: true,
  format: 'iife',
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
};

if (watch) {
  esbuild.context(opts).then((ctx) => ctx.watch());
} else {
  esbuild.build(opts).catch(() => process.exit(1));
}
