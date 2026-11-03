import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('runtime manifest admits exact deployed code only, not fixtures, declarations or symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sentry-source-manifest-'));
  try {
    const entries = [
      'apps/api/src/main.ts', 'packages/telemetry/src/node.ts',
      'apps/api/src/main.test.ts', 'apps/api/src/types.d.ts',
      'apps/api/src/fixtures/private.ts', 'packages/telemetry/node_modules/vendor/index.ts',
      'apps/api/src/private.payload.ts', 'apps/api/src/private.json',
    ];
    for (const entry of entries) {
      await mkdir(dirname(join(root, entry)), { recursive: true });
      await writeFile(join(root, entry), 'export {};');
    }
    await symlink(join(root, 'apps/api/src/main.ts'), join(root, 'apps/api/src/alias.ts'));
    execFileSync(process.execPath, [new URL('./writeSentrySourceManifest.mjs', import.meta.url).pathname, root]);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'packages/telemetry/source-files.json'), 'utf8')), [
      'apps/api/src/main.ts', 'packages/telemetry/src/node.ts',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
