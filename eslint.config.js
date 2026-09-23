// Flat config. Four source shapes live in this repo and they do not share a
// module system, a syntax or a set of globals, so each gets its own block:
//   - the Node server (TypeScript, and the ES-module JavaScript around it)
//   - the browser client (public-src, ESM + JSX; public/, classic scripts)
//   - the Companion module (ESM, its own package)
//
// The rule set is deliberately small: catch what actually bit us — unused
// bindings, accidental globals, unreachable code — without turning a working
// project into a lint backlog.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const NODE_GLOBALS = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly',
  fetch: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly', Headers: 'readonly',
  Request: 'readonly', Response: 'readonly', ReadableStream: 'readonly', FormData: 'readonly', Blob: 'readonly',
  DOMException: 'readonly',
  globalThis: 'readonly', structuredClone: 'readonly', performance: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly',
  fetch: 'readonly', AbortController: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', FormData: 'readonly', Blob: 'readonly',
  console: 'readonly', performance: 'readonly', history: 'readonly',
  getComputedStyle: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  io: 'readonly',            // socket.io client, loaded via <script> on settings.html
  Toast: 'readonly',         // public/toast.js, loaded via <script> on both pages
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

export default [
  {
    ignores: [
      'node_modules/**',
      'companion-module/node_modules/**',
      'public/app.bundle.js',      // generated
      'cache/**',
      'tests/fixtures/**',
      '.venv/**',
    ],
  },

  // ── Node server (ES modules) ──────────────────────────────────────────────
  {
    files: ['server.js', 'eslint.config.js', 'src/**/*.js', 'scripts/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: { ...js.configs.recommended.rules, ...COMMON_RULES },
  },

  // ── Node server, TypeScript ───────────────────────────────────────────────
  // Parsed by typescript-eslint; the same small rule set, less the two rules
  // the type checker already enforces better (undefined names, and unused
  // bindings, which have a TypeScript-aware twin that knows about types).
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...js.configs.recommended.rules,
      ...COMMON_RULES,
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': COMMON_RULES['no-unused-vars'],
    },
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

      // The bundle runs in a browser, so anything it pulls out of src/ has to
      // be free of server state, transports and Node built-ins. src/shared/ is
      // the half that promises that; src/server/ and src/show/ do not, and one
      // `import './state.js'` added to a file down there would break the client
      // build with nothing to say why. Move the pure part of a module into
      // src/shared/ rather than widening this rule.
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/src/server/**', '**/src/show/**'],
          message: 'The browser bundle may only import from src/shared/ — see eslint.config.js.',
        }],
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
