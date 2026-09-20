// ESLint 9 flat configuration. Tooling only: nothing in the application reads it.
//
// It reproduces the retired .eslintrc.json: eslint:recommended, typescript-eslint
// recommended, eslint-plugin-import recommended + electron + typescript, the
// TypeScript parser with browser and Node globals for every file, and the same
// per-file overrides. `npm run lint` runs `eslint .`; CI runs
// scripts/lintTracked.mjs, which passes every tracked source file explicitly
// with --no-ignore, so the global ignores below never hide a tracked file.
import js from '@eslint/js';
// The typescript-eslint packages publish only an `exports` map, which the node
// resolver configured below cannot read (same as vitest/config in vitest.config.mts).
import tsPlugin from '@typescript-eslint/eslint-plugin'; // eslint-disable-line import/no-unresolved
import tsParser from '@typescript-eslint/parser'; // eslint-disable-line import/no-unresolved
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

// The extensions scripts/lintTracked.mjs hands to ESLint. Listing them is what
// makes `eslint .` pick up TypeScript under ESLint 9.
const sourceFiles = ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'];

// Reviewed literal `require()` allowlists for the CommonJS compatibility
// scripts (pinned by test/lintTracked.test.mjs).
const literalRequires = allow => ({
  '@typescript-eslint/no-require-imports': ['error', { allow }],
});

export default [
  {
    ignores: [
      // Lambda packages lint through `npm run lint:tracked` (--no-ignore) with
      // their own resolver below, never through `eslint .`.
      'cloud/lambdas/**',
      // The greenfield workspace has its own flat config, eslint.greenfield.mjs,
      // run by `npm run lint:greenfield`. This config never sees those files.
      'apps/**',
      'packages/**',
      // Generated output, packaged apps and nested checkouts. ESLint 8 skipped
      // dot-directories (.vite, .worktrees, .build) by default; ESLint 9 does not.
      '**/.*/',
      'out/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'artifacts/**',
      'build/generated/**',
      'native/safe-log-fs/build/**',
    ],
  },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended'],
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.electron,
  importPlugin.flatConfigs.typescript,
  {
    files: sourceFiles,
    languageOptions: {
      // One parser for JavaScript and TypeScript alike, as before. ecmaVersion
      // 2018 and sourceType module come from import/recommended.
      parser: tsParser,
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ['src/main/research/companyPageText.ts'],
    settings: { 'import/core-modules': ['cheerio/slim'] },
  },
  {
    files: ['scripts/releaseArtifactCore.cjs'],
    rules: literalRequires([
      '^node:crypto$',
      '^node:fs$',
      '^node:path$',
      '^@electron/asar$',
      '^\\./releaseMarkerContract\\.cjs$',
    ]),
  },
  {
    files: ['cloud/lambdas/**/*.{js,mjs,cjs,ts,mts,cts,tsx}'],
    // Resolved by eslint-plugin-import relative to the Lambda package directory.
    settings: { 'import/resolver': '../../../scripts/lambdaImportResolver.cjs' },
  },
  {
    files: ['scripts/probeEncryptedSqlite.cjs'],
    rules: literalRequires([
      '^node:fs$',
      '^node:path$',
      '^electron$',
      '^better-sqlite3-multiple-ciphers$',
      '^better-sqlite3-multiple-ciphers/package\\.json$',
      '^kysely$',
    ]),
  },
  {
    files: ['scripts/probeEncryptedSqliteNative.cjs'],
    rules: literalRequires([
      '^better-sqlite3-multiple-ciphers$',
      '^node:fs$',
      '^node:os$',
      '^node:path$',
    ]),
  },
  {
    files: ['scripts/lambdaImportResolver.cjs'],
    rules: literalRequires(['^node:module$', '^node:path$', '^typescript$']),
  },
];
