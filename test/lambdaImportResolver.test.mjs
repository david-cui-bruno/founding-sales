import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const resolver = require('../scripts/lambdaImportResolver.cjs');
const root = resolve('.');
it.each([
  ['node:fs', 'delegated-worker/src/index.ts', null],
  ['fs', 'delegated-worker/src/index.ts', null],
  ['vitest/config', 'delegated-worker/vitest.config.ts', '/vitest/'],
  ['zod', 'delegated-worker/src/index.ts', '/delegated-worker/node_modules/zod/'],
  ['@aws-sdk/client-dynamodb', 'delegated-worker/src/handler.ts', '/delegated-worker/node_modules/@aws-sdk/client-dynamodb/'],
  ['../src/dynamoStore.js', 'delegated-worker/test/sdkHarness.ts', '/delegated-worker/src/dynamoStore.ts'],
])('resolves %s from its own package without root substitutes', (source, importer, suffix) => {
  const result = resolver.resolve(source, resolve(root, 'cloud/lambdas', importer));
  expect(result.found).toBe(true);
  if (suffix === null) expect(result.path).toBe(null); else expect(result.path).toContain(suffix);
});
it.each(['missing-package', './missing.js', 'vitest/not-exported'])('does not bless missing imports: %s', source => {
  expect(resolver.resolve(source, resolve(root, 'cloud/lambdas/delegated-worker/src/index.ts'))).toEqual({ found: false });
});
it('loads the resolver from ESLint for nested packages while root settings remain unchanged', async () => {
  const { ESLint } = require('eslint'); const eslint = new ESLint({ ignore: false });
  const [result] = await eslint.lintText("import { defineConfig } from 'vitest/config'; export default defineConfig({});", { filePath: 'cloud/lambdas/delegated-worker/vitest.config.ts' });
  expect(result.messages).toEqual([]);
  const [missing] = await eslint.lintText("import x from 'definitely-missing-package'; export default x;", { filePath: 'cloud/lambdas/delegated-worker/src/missing.ts' });
  expect(missing.messages.some(message => message.ruleId === 'import/no-unresolved')).toBe(true);
  expect((await eslint.calculateConfigForFile('src/main.ts')).settings?.['import/resolver']).toEqual({ node: { extensions: ['.ts', '.cts', '.mts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] } });
});
