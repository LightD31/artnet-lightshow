'use strict';

// Flat config. Three source shapes live in this repo and they do not share a
// module system or set of globals, so each gets its own block:
//   - the Node server (CommonJS)
//   - the browser client (public-src, ESM + JSX; public/, classic scripts)
//   - the Companion module (ESM, its own package)
//
// The rule set is deliberately small: catch what actually bit us — unused
// bindings, accidental globals, unreachable code — without turning a working
// project into a lint backlog. See AUDIT.md L9.

const js = require('@eslint/js');

const NODE_GLOBALS = {
  require: 'readonly', module: 'writable', exports: 'writable',
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', __filename: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly',
  fetch: 'readonly', AbortSignal: 'readonly', Headers: 'readonly',
  globalThis: 'readonly', structuredClone: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly',
  fetch: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', FormData: 'readonly', Blob: 'readonly',
  console: 'readonly', performance: 'readonly', history: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  io: 'readonly',            // socket.io client, loaded via <script> on settings.html
  browser: 'readonly',       // WebExtension API
};

const COMMON_RULES = {
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrors: 'none',    // `catch (_)` is used deliberately throughout
  }],
  'no-undef': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-constant-condition': ['error', { checkLoops: false }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'companion-module/node_modules/**',
      'public/app.bundle.js',      // generated
      'cache/**',
      'tests/fixtures/**',
    ],
  },

  // ── Node server (CommonJS) ────────────────────────────────────────────────
  {
    files: ['server.js', 'src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: { ...js.configs.recommended.rules, ...COMMON_RULES },
  },

  // ── Browser client bundled by esbuild (ESM + JSX) ─────────────────────────
  {
    files: ['public-src/**/*.js', 'public-src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: BROWSER_GLOBALS,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...COMMON_RULES,
      // JSX pragmas are injected by esbuild's automatic runtime, so the
      // imported component identifiers look unused to the parser.
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^(_|[A-Z])',
        caughtErrors: 'none',
      }],
    },
  },

  // ── Plain browser scripts served as-is ────────────────────────────────────
  {
    files: ['public/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: { ...js.configs.recommended.rules, ...COMMON_RULES },
  },

  // ── Browser extension ─────────────────────────────────────────────────────
  {
    files: ['browser-extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: { ...js.configs.recommended.rules, ...COMMON_RULES },
  },

  // ── Companion module (ESM, tab-indented, its own prettier config) ─────────
  {
    files: ['companion-module/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...NODE_GLOBALS, ...BROWSER_GLOBALS },
    },
    rules: { ...js.configs.recommended.rules, ...COMMON_RULES },
  },
];
