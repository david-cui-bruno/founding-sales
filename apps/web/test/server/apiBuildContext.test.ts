import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const dockerfile = await readFile(new URL('Dockerfile.api', root), 'utf8');
const rules = (await readFile(new URL('Dockerfile.api.dockerignore', root), 'utf8'))
  .split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
const allowed = rules.filter(line => line.startsWith('!')).map(line => line.slice(1));
const browserInputs = [
  'tsconfig.base.json', 'apps/web/package.json', 'apps/web/tsconfig.json',
  'apps/web/src/client', 'apps/web/src/shared', 'apps/web/src/server',
  'apps/desktop/package.json', 'apps/desktop/src/renderer', 'scripts/buildBrowserAssets.mjs',
];

test('every API Docker COPY input is explicitly admitted by its Dockerfile-specific context', () => {
  const inputs = dockerfile.split('\n').filter(line => line.startsWith('COPY ') && !line.startsWith('COPY --from='))
    .flatMap(line => line.split(/\s+/u).slice(1, -1));
  for (const input of inputs) assert.ok(allowed.some(path => input === path || input.startsWith(`${path}/`)), `COPY input excluded by API context: ${input}`);
  for (const input of browserInputs) assert.ok(allowed.includes(input), `Missing browser context input: ${input}`);
});

test('browser additions remain exact input scopes instead of widening the deny-by-default context', () => {
  assert.equal(rules[0], '*');
  const browserAllowances = allowed.filter(path => /^(?:apps\/(?:web|desktop)(?:\/|$)|scripts(?:\/|$)|tsconfig)/u.test(path));
  assert.deepEqual(browserAllowances.sort(), [...browserInputs].sort());
  for (const path of allowed) assert.ok(!path.includes('*'), `Broad context allowance: ${path}`);
});

test('private environment, fixtures, tests and dependency exclusions override every allowance', () => {
  const lastAllowance = Math.max(...rules.map((rule, index) => rule.startsWith('!') ? index : -1));
  for (const rule of ['packages/domain/db/testing', '**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/test/**', '**/tests/**', '**/__tests__/**', '**/fixtures/**', '**/.env', '**/.env.*', '**/node_modules', '**/.DS_Store']) {
    assert.ok(rules.indexOf(rule) > lastAllowance, `Missing final context exclusion: ${rule}`);
  }
  const runtime = dockerfile.split('AS runtime')[1];
  assert.ok(runtime);
  assert.ok(runtime.includes('RUN rm apps/web/src/server/assets.ts apps/web/src/server/server.ts'));
  assert.ok(!runtime.includes('COPY apps/desktop'));
  assert.ok(!runtime.includes('COPY apps/web/src/client'));
});
