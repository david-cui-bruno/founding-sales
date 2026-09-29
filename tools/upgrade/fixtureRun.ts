import { spawn } from 'node:child_process';
import type { BaseCheckout } from './baseCheckout.ts';
import { FIXTURE_JSON_PREFIX } from './fixtureProtocol.ts';
import { redactConnectionStrings } from './redact.ts';
import type { FixtureHandles, FixturePartReport } from './fixture.ts';

/**
 * Run the base checkout's loader and read its answer, then judge it.
 *
 * "Almost nothing loaded" has to be impossible to pass silently: a fixture that
 * skipped nineteen of its twenty-two parts would make every step after it vacuous, and
 * the steps would all still be green. So a skipped part fails the run, and there are
 * exactly two excuses.
 *
 * **The six objects no fixture can make**, below: three the API's own sign-in path
 * writes, three the step-10 workflows write after the upgrade rather than before it.
 *
 * **Whatever this upgrade adds.** A part that writes `funnel_facts` cannot run at
 * schema 21, because 0022 is the migration that creates that table — and no code, old
 * or new, can insert into a table that does not exist. That set is read out of the
 * catalogue after the apply (`snapshot.ts`, `columnNames`), not parsed out of the
 * migration files and not written down here, so a part that claims to be missing
 * something the upgrade does not add still fails.
 */

/** The only objects whose absence excuses a skipped part on its own. */
export const ALLOWED_MISSING_OBJECTS: readonly string[] = [
  // Written by the API's own sign-in path, not by any ordinary command.
  'sessions',
  'oidc_authorization_requests',
  'command_receipts',
  // Written by the workflows in step 10, after the upgrade, not before it.
  'deletion_requests',
  'departures',
  'retention_runs',
];

export interface FixtureResult {
  readonly handles: FixtureHandles;
  readonly parts: readonly FixturePartReport[];
  readonly emptyTables: ReadonlyMap<string, string>;
  /** Diagnostic output of the child, for a failure. */
  readonly output: string;
}

const NODE_FLAGS = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'];

/**
 * Is this skip excused? `added` is what the upgrade created, as `table` and
 * `table.column`. A skip with nothing nameable missing is never excused: it means a
 * command refused or an earlier part did not run, and those are failures.
 */
export function skipIsExcused(part: FixturePartReport, added: ReadonlySet<string>): boolean {
  if (part.missing.length === 0) return false;
  return part.missing.every(object => {
    const name = object.toLowerCase();
    if (added.has(name)) return true;
    const table = name.split('.')[0] ?? name;
    return ALLOWED_MISSING_OBJECTS.includes(table) || added.has(table);
  });
}

/** The parts whose skip nothing excuses. Non-empty means the run fails. */
export function unexcusedSkips(
  parts: readonly FixturePartReport[],
  added: ReadonlySet<string>,
): readonly FixturePartReport[] {
  return parts.filter(part => part.outcome === 'skipped' && !skipIsExcused(part, added));
}

export async function loadFixtureInBaseCheckout(
  base: BaseCheckout,
  input: { readonly databaseUrl: string; readonly schemaVersion: number },
): Promise<FixtureResult> {
  const { code, output } = await new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn('node', [...NODE_FLAGS, base.loader], {
      cwd: base.directory,
      env: {
        ...process.env,
        FSS_UPGRADE_DATABASE_URL: input.databaseUrl,
        FSS_UPGRADE_SCHEMA: String(input.schemaVersion),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    child.on('error', error => { resolve({ code: -1, output: `${text}\n${error.message}` }); });
    child.on('close', value => { resolve({ code: value, output: text }); });
  });

  // Redacted before it is kept: the evidence artifact is uploaded, and a `pg` error or
  // a stack frame can carry the URL the child was handed (GPT-6 review, P2-2).
  const safe = redactConnectionStrings(output);
  const line = safe.split('\n').find(candidate => candidate.startsWith(FIXTURE_JSON_PREFIX));
  if (code !== 0 || line === undefined) {
    throw new Error(
      `the fixture loader in ${base.directory} exited ${String(code)} without an answer:\n${safe.split('\n').slice(-30).join('\n')}`,
    );
  }
  const parsed = JSON.parse(line.slice(FIXTURE_JSON_PREFIX.length)) as {
    handles: FixtureHandles;
    parts: FixturePartReport[];
    emptyTables: [string, string][];
  };
  const parts = parsed.parts.map(part => ({ ...part, missing: part.missing ?? [] }));
  return {
    handles: parsed.handles,
    parts,
    emptyTables: new Map(parsed.emptyTables),
    output: safe,
  };
}
