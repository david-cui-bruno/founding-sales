// ESLint 10 flat configuration for the whole tree: apps/, packages/, test/ops/ and the
// scripts at the repository root. `npm run lint` runs it.
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    // Generated output and nested checkouts. ESLint does not skip dot-directories.
    ignores: ['**/node_modules/**', '**/dist/**', '**/.*/', 'out/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'artifacts/**'],
  },
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
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
    files: ['**/*.{ts,mts,cts,tsx}'],
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
    // The renderer's React (1.0.12). The two rules that catch the mistakes a hook-based
    // view actually makes: a hook called conditionally, and an effect that reads state it
    // did not list. Nothing about formatting or about how a component should be written.
    files: ['apps/desktop/src/renderer/**/*.tsx', 'apps/desktop/src/renderer/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // Test files deliberately construct wrong shapes behind @ts-expect-error.
    files: ['**/test/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': false, 'ts-ignore': true, 'ts-nocheck': true }],
      'no-console': 'off',
    },
  },
];
