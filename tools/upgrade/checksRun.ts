import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactConnectionStrings } from './redact.ts';
import { CHECKS_JSON_PREFIX, type ChecksMode, type ChecksReport } from './checksProtocol.ts';
import type { FixtureHandles } from './fixture.ts';

/**
 * Run the post-upgrade checks inside a checkout and read its answer.
 *
 * The same arrangement as the fixture loader: a child process whose working directory
 * is the tree under test, handed the connection URL in the environment. Its diagnostic
 * output is redacted before it is kept, because the evidence artifact is uploaded.
 */

const NODE_FLAGS = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'];

export interface ChecksResult {
  readonly report: ChecksReport;
  readonly output: string;
}

export async function runChecksIn(
  tree: string,
  entry: string,
  input: {
    readonly databaseUrl: string;
    readonly mode: ChecksMode;
    readonly handles?: FixtureHandles | undefined;
  },
): Promise<ChecksResult> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    FSS_UPGRADE_DATABASE_URL: input.databaseUrl,
    FSS_UPGRADE_CHECKS_MODE: input.mode,
  };
  if (input.handles !== undefined) {
    const directory = mkdtempSync(join(tmpdir(), 'fss-upgrade-handles-'));
    const file = join(directory, 'handles.json');
    writeFileSync(file, JSON.stringify(input.handles), 'utf8');
    environment['FSS_UPGRADE_HANDLES_FILE'] = file;
  }

  const { code, output } = await new Promise<{ code: number | null; output: string }>(resolve => {
    const child = spawn('node', [...NODE_FLAGS, entry], {
      cwd: tree,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    child.on('error', error => { resolve({ code: -1, output: `${text}\n${error.message}` }); });
    child.on('close', value => { resolve({ code: value, output: text }); });
  });

  const safe = redactConnectionStrings(output);
  const line = safe.split('\n').find(candidate => candidate.startsWith(CHECKS_JSON_PREFIX));
  if (code !== 0 || line === undefined) {
    throw new Error(
      `the post-upgrade checks in ${tree} exited ${String(code)} without an answer:\n${safe.split('\n').slice(-30).join('\n')}`,
    );
  }
  return { report: JSON.parse(line.slice(CHECKS_JSON_PREFIX.length)) as ChecksReport, output: safe };
}
