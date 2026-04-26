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
  sourcemap: watch,
  logLevel: 'info',
  loader: { '.js': 'jsx' },
};

if (watch) {
  esbuild.context(opts).then((ctx) => ctx.watch());
} else {
  esbuild.build(opts).catch(() => process.exit(1));
}
