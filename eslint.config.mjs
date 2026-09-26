// ESLint 9 flat configuration for the whole tree: apps/, packages/, test/release/ and the
// scripts at the repository root. `npm run lint` runs it.
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  {
    // Generated output and nested checkouts. ESLint 9 does not skip dot-directories.
    ignores: ['**/node_modules/**', '**/dist/**', '**/.*/', 'out/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'artifacts/**'],
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.node },
    },
  },
  {
    // Developer tools and the root scripts are plain ESM.
    files: ['**/*.mjs'],
    languageOptions: {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.node },
    },
  },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['**/*.{ts,mts,cts}'],
    rules: {
      // Strict TypeScript; `any` is never the conservative option.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // Test files deliberately construct wrong shapes behind @ts-expect-error.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': false, 'ts-ignore': true, 'ts-nocheck': true }],
      'no-console': 'off',
    },
  },
];
