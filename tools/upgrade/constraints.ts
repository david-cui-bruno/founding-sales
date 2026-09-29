import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The constraint cases, at M, run by the file that owns them.
 *
 * `packages/domain/test/db/constraints.test.ts` ends with the gate that makes the rest
 * of it honest: it asks the database for every CHECK, UNIQUE, foreign key, primary key,
 * constraint trigger and partial unique index it has, and fails when one has no failing
 * insert. That gate is the reason this step exists — a migration that adds a constraint
 * without a case has to fail the upgrade test, not just the workspace test run.
 *
 * So the file is run, as itself, by Vitest, against the cluster this test already
 * started (`FSS_TEST_POSTGRES_URL`). It is not run against the *same database*: the
 * file's own `globalSetup` migrates a template of its own and every case rolls itself
 * back, so pointing it at the fixture database would only mean the cases fought the
 * fixture's rows for unique slugs. What is asserted is the schema, and the schema is
 * the one the same migrations produce.
 *
 * Running it from the target tree (`--tree`) rather than from this one is what lets the
 * step say something about migration 0023 while this tree is still at 22.
 */

export interface ConstraintRunResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly output: string;
}

export async function runConstraintCases(tree: string, clusterUrl: string): Promise<ConstraintRunResult> {
  const domain = join(tree, 'packages', 'domain');
  const vitest = join(tree, 'node_modules', '.bin', 'vitest');
  if (!existsSync(vitest)) {
    return {
      ok: false,
      detail: `no vitest in ${tree}; run \`npm ci\` in that tree first`,
      output: '',
    };
  }
  return await new Promise<ConstraintRunResult>(resolve => {
    const child = spawn(vitest, ['run', 'test/db/constraints.test.ts'], {
      cwd: domain,
      // NO_COLOR so the summary line that goes into the evidence artifact is text.
      env: { ...process.env, FSS_TEST_POSTGRES_URL: clusterUrl, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.on('error', error => {
      resolve({ ok: false, detail: error.message, output });
    });
    child.on('close', code => {
      const summary = /Tests\s+(.+)$/mu.exec(output)?.[1]?.trim() ?? '';
      resolve({
        ok: code === 0,
        detail: summary === '' ? `vitest exited ${String(code)}` : `${summary} (exit ${String(code)})`,
        output,
      });
    });
  });
}
