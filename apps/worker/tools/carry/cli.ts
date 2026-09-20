import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { repositoryContext, withTransaction, workspaceScope, type QueryResultRowLike, type SessionQueryable } from '@fss/domain/db';
import { ageCipher, aesGcmCipher, openArtifact, type ArtifactCipher, type CarryReceipt, type RunCommand } from './artifact.ts';
import { loadDynamoQuery, loadS3SuppressionJournal } from './awsClients.ts';
import { pagedOldTableReader } from './dynamoPort.ts';
import { exportReport, runCarryExport } from './export.ts';
import { importReport, runCarryImport } from './import.ts';
import { shredCarryArtifact } from './shred.ts';

/**
 * The carry's command line (lane G11).
 *
 * Four subcommands, one per numbered step of `docs/greenfield/carry-runbook.md`:
 * `export`, `verify`, `import`, `shred`. Each one prints counts and digests and
 * nothing else; no firm name, handle or address ever reaches stdout, and no
 * environment variable's value is printed anywhere, including in an error.
 *
 * `parseCarryCommand` is separated from `main` so the whole of the argument surface
 * is testable without a database, a network or a file.
 */

export const CARRY_SUBCOMMANDS = ['export', 'verify', 'import', 'shred'] as const;
export type CarrySubcommand = (typeof CARRY_SUBCOMMANDS)[number];

export interface ParsedCarryCommand {
  readonly subcommand: CarrySubcommand;
  readonly options: Readonly<Record<string, string>>;
}

export type ParseRefusal = 'subcommand_missing' | 'subcommand_unknown' | 'option_malformed' | 'option_missing';

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedCarryCommand }
  | { readonly ok: false; readonly reason: ParseRefusal; readonly detail: string };

/** Which `--name value` options each subcommand requires. */
export const REQUIRED_OPTIONS: Readonly<Record<CarrySubcommand, readonly string[]>> = Object.freeze({
  export: ['watermark', 'out', 'receipt', 'table', 'old-workspace', 'region', 'recipient', 'artifact-id'],
  verify: ['artifact', 'receipt'],
  import: ['artifact', 'receipt', 'identity', 'workspace', 'database-url-env', 'journal-bucket', 'region'],
  shred: ['artifact', 'receipt', 'workspace', 'database-url-env'],
});

export function parseCarryCommand(argv: readonly string[]): ParseResult {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) return { ok: false, reason: 'subcommand_missing', detail: CARRY_SUBCOMMANDS.join(', ') };
  if (!(CARRY_SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    return { ok: false, reason: 'subcommand_unknown', detail: subcommand };
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined || value.startsWith('--')) {
      return { ok: false, reason: 'option_malformed', detail: flag ?? '' };
    }
    options[flag.slice(2)] = value;
  }
  for (const required of REQUIRED_OPTIONS[subcommand as CarrySubcommand]) {
    if (options[required] === undefined) return { ok: false, reason: 'option_missing', detail: required };
  }
  return { ok: true, value: { subcommand: subcommand as CarrySubcommand, options } };
}

/** Run `command` with `input` on stdin, collecting stdout. Used only by `ageCipher`. */
export const spawnCommand: RunCommand = async (command, args, input) =>
  await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', chunk => out.push(Buffer.from(chunk as Buffer)));
    child.stderr.on('data', chunk => err.push(Buffer.from(chunk as Buffer)));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out));
      // The command's own stderr may name a key path; only its exit code is reported.
      else reject(new Error(`${command} exited with ${String(code ?? -1)}`));
    });
    child.stdin.end(input);
  });

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * The cipher for a run.
 *
 * `--recipient` and `--identity` choose `age`, which is the production path.
 * `--local-key-file` is the rehearsal path on a machine with no `age`: it reads a
 * 32-byte key from a file, and that file is the operator's problem for exactly as
 * long as the rehearsal lasts. There is no third option and no key on a command line.
 */
async function cipherFor(options: Readonly<Record<string, string>>): Promise<ArtifactCipher> {
  const localKeyFile = options['local-key-file'];
  if (localKeyFile !== undefined) return aesGcmCipher(await readFile(localKeyFile));
  return ageCipher({
    command: options['age-command'] ?? 'age',
    recipient: options['recipient'] ?? '',
    identityFile: options['identity'] ?? '',
    run: spawnCommand,
  });
}

async function readReceipt(path: string): Promise<CarryReceipt> {
  return JSON.parse(await readFile(path, 'utf8')) as CarryReceipt;
}

/**
 * One PostgreSQL session for the import or the shred.
 *
 * The connection string is read from the environment variable *named* on the command
 * line and is never printed, never logged and never put in an error message. The
 * adapter is the same four lines as `apps/worker/src/bootstrap/main.ts`, because the
 * narrow `SessionQueryable` is what every domain command takes and there is no second
 * shape for a tool to use.
 */
async function openSession(databaseUrlEnvironmentVariable: string): Promise<{
  readonly session: SessionQueryable;
  close(): Promise<void>;
}> {
  const url = process.env[databaseUrlEnvironmentVariable];
  if (url === undefined || url.length === 0) {
    throw new Error(`the environment variable ${databaseUrlEnvironmentVariable} is not set`);
  }
  const client = new pg.Client({ connectionString: url, application_name: 'fss-carry' });
  await client.connect();
  return {
    session: {
      async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
        const result = await client.query(text, values === undefined ? undefined : [...values]);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    },
    close: async () => {
      await client.end();
    },
  };
}

export const CARRY_EXIT_CODES = Object.freeze({ ok: 0, refused: 20, failed: 21, usage: 64 });

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseCarryCommand(argv);
  if (!parsed.ok) {
    console.error(`carry: ${parsed.reason} (${parsed.detail})`);
    return CARRY_EXIT_CODES.usage;
  }
  const { subcommand, options } = parsed.value;

  switch (subcommand) {
    case 'export': {
      const reader = pagedOldTableReader({
        description: 'old_dynamodb_table',
        query: await loadDynamoQuery({
          region: options['region'] ?? '',
          tableName: options['table'] ?? '',
          workspaceId: options['old-workspace'] ?? '',
        }),
      });
      const result = await runCarryExport({
        reader,
        watermarkFlag: await readFile(options['watermark'] ?? '', 'utf8').catch(() => null),
        cipher: await cipherFor(options),
        now: new Date(),
        artifactId: options['artifact-id'] ?? '',
      });
      if (!result.ok) {
        console.error(`carry export refused: ${result.reason} ${JSON.stringify(result.detail)}`);
        return CARRY_EXIT_CODES.refused;
      }
      await writeFile(options['out'] ?? '', result.value.sealed, { mode: 0o600 });
      await writeFile(options['receipt'] ?? '', `${JSON.stringify(result.value.receipt, null, 2)}\n`, { mode: 0o600 });
      write(exportReport(result.value));
      return CARRY_EXIT_CODES.ok;
    }

    case 'verify': {
      const receipt = await readReceipt(options['receipt'] ?? '');
      const opened = await openArtifact({
        sealed: await readFile(options['artifact'] ?? ''),
        receipt,
        cipher: await cipherFor(options),
      });
      if (!opened.ok) {
        console.error(`carry verify refused: ${opened.reason}`);
        return CARRY_EXIT_CODES.refused;
      }
      write(`artifact  ${receipt.artifactId}`);
      write(`watermark ${receipt.watermarkAt}`);
      write(`counts    ${JSON.stringify(opened.value.manifest.kinds)}`);
      return CARRY_EXIT_CODES.ok;
    }

    case 'import': {
      const receipt = await readReceipt(options['receipt'] ?? '');
      const opened = await openArtifact({
        sealed: await readFile(options['artifact'] ?? ''),
        receipt,
        cipher: await cipherFor(options),
      });
      if (!opened.ok) {
        console.error(`carry import refused: ${opened.reason}`);
        return CARRY_EXIT_CODES.refused;
      }
      // 10.2 has no exception for an import: the journal is durable before the row.
      const journal = await loadS3SuppressionJournal({
        region: options['region'] ?? '',
        bucket: options['journal-bucket'] ?? '',
      });
      const database = await openSession(options['database-url-env'] ?? '');
      try {
        const context = repositoryContext(
          workspaceScope(options['workspace'] ?? '', { kind: 'system', component: 'migration' }),
          database.session,
        );
        const result = await withTransaction(database.session, async () =>
          runCarryImport(context, { manifest: opened.value.manifest, records: opened.value.records, journal }),
        );
        if (!result.ok) {
          console.error(`carry import refused: ${result.reason} ${JSON.stringify(result.detail)}`);
          return CARRY_EXIT_CODES.refused;
        }
        write(importReport(result.value));
        return CARRY_EXIT_CODES.ok;
      } finally {
        await database.close();
      }
    }

    case 'shred': {
      const receipt = await readReceipt(options['receipt'] ?? '');
      const database = await openSession(options['database-url-env'] ?? '');
      try {
        const context = repositoryContext(
          workspaceScope(options['workspace'] ?? '', { kind: 'system', component: 'migration' }),
          database.session,
        );
        const result = await withTransaction(database.session, async () =>
          shredCarryArtifact(context, { path: options['artifact'] ?? '', receipt }),
        );
        if (!result.ok) {
          console.error(`carry shred refused: ${result.reason}`);
          return CARRY_EXIT_CODES.refused;
        }
        write(`shredded  ${result.value.artifactId}`);
        write(`bytes     ${String(result.value.bytesOverwritten)}`);
        return CARRY_EXIT_CODES.ok;
      } finally {
        await database.close();
      }
    }
  }
}
