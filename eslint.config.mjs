// ESLint 9 flat configuration for the scripts at the repository root. Tooling only:
// nothing in the product reads it.
//
// `npm run lint:root-scripts` runs it over an explicit file list with --no-ignore:
// eslint.greenfield.mjs, scripts/productionSmoke.mjs, scripts/releaseMutationCheck.mjs,
// scripts/releaseMutationRunner.mjs and scripts/mutations/*.mjs. The greenfield
// workspace (apps/, packages/, test/release/) has its own config, eslint.greenfield.mjs,
// run by `npm run lint:greenfield`; this one ignores those directories, so the two
// never lint the same file.
import js from '@eslint/js';
// The typescript-eslint packages publish only an `exports` map, which the node
// resolver of eslint-plugin-import cannot read.
import tsPlugin from '@typescript-eslint/eslint-plugin'; // eslint-disable-line import/no-unresolved
import tsParser from '@typescript-eslint/parser'; // eslint-disable-line import/no-unresolved
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

const sourceFiles = ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'];

export default [
  {
    ignores: [
      'apps/**',
      'packages/**',
      'test/release/**',
      // Generated output and nested checkouts. ESLint 9 does not skip dot-directories.
      '**/.*/',
      'out/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'artifacts/**',
    ],
  },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended'],
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    files: sourceFiles,
    languageOptions: {
      parser: tsParser,
      globals: { ...globals.node },
    },
  },
];
