// ESLint 9 flat configuration for the greenfield workspace only (apps/*, packages/*).
//
// The old trees keep eslint.config.mjs; that config ignores apps/ and packages/, and
// scripts/lintTracked.mjs skips them, so the two gates never lint the same file.
// `npm run lint:greenfield` runs this one: eslint --config eslint.greenfield.mjs apps packages.
import js from '@eslint/js';
// The typescript-eslint packages publish only an `exports` map, which the node
// resolver cannot read; the same disable the old config carries.
import tsPlugin from '@typescript-eslint/eslint-plugin'; // eslint-disable-line import/no-unresolved
import tsParser from '@typescript-eslint/parser'; // eslint-disable-line import/no-unresolved
import globals from 'globals';

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**'],
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.node },
    },
  },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['**/*.{ts,mts,cts}'],
    rules: {
      // The greenfield code is strict TypeScript; `any` is never the conservative option.
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
