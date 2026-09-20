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

/**
 * Which `--name value` options each subcommand requires.
 *
 * The cipher's options are not here: which key opens the artifact is
 * `cipherChoice`'s decision, because it depends on the direction and on whether the
 * run is a rehearsal. Everything in these lists is a public identifier — a path, a
 * region, a table name, a workspace id, or the *name* of an environment variable.
 * Never a connection string, a password or a key: an argument list is visible in
 * `ps` and ends up in a shell history file.
 */
export const REQUIRED_OPTIONS: Readonly<Record<CarrySubcommand, readonly string[]>> = Object.freeze({
  export: ['watermark', 'out', 'receipt', 'table', 'old-workspace', 'region', 'artifact-id'],
  verify: ['artifact', 'receipt'],
  import: ['artifact', 'receipt', 'workspace', 'database-url-env', 'journal-bucket', 'region'],
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
    child.stdout.on('data', chunk => out.push(Buffer.from(chunk as Buffer)));
    // stderr is drained and discarded. It has to be drained — a full pipe would
    // deadlock the child — and it must not be kept, because `age`'s own messages
    // name key paths and this buffer would end up in an error a person pastes.
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${command} exited with ${String(code ?? -1)}`));
    });
    child.stdin.end(input);
  });

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

export type CipherChoice =
  | { readonly ok: true; readonly kind: 'age'; readonly recipient: string; readonly identityFile: string; readonly command: string }
  | { readonly ok: true; readonly kind: 'local'; readonly keyFile: string }
  | { readonly ok: false; readonly missing: 'recipient' | 'identity' };

/**
 * Which key opens or seals the artifact. Pure, so the whole decision is testable.
 *
 * `--recipient` seals and `--identity` opens; both choose `age`, which is the
 * production path. `--local-key-file` overrides both and is the rehearsal path on a
 * machine with no `age`: it names a file holding a 32-byte key, and that file is the
 * operator's problem for exactly as long as the rehearsal lasts. There is no third
 * option and no key on a command line.
 *
 * The direction is a parameter because the two halves need different options, and an
 * `age --decrypt --identity ''` would otherwise fail with the binary's own message
 * instead of with an instruction.
 */
export function cipherChoice(
  options: Readonly<Record<string, string>>,
  direction: 'seal' | 'open',
): CipherChoice {
  const keyFile = options['local-key-file'];
  if (keyFile !== undefined) return { ok: true, kind: 'local', keyFile };
  const needed = direction === 'seal' ? 'recipient' : 'identity';
  if (options[needed] === undefined) return { ok: false, missing: needed };
  return {
    ok: true,
    kind: 'age',
    recipient: options['recipient'] ?? '',
    identityFile: options['identity'] ?? '',
    command: options['age-command'] ?? 'age',
  };
}

async function cipherFor(
  options: Readonly<Record<string, string>>,
  direction: 'seal' | 'open',
): Promise<ArtifactCipher> {
  const choice = cipherChoice(options, direction);
  if (!choice.ok) {
    throw new Error(`--${choice.missing} is required to ${direction} an artifact, or --local-key-file for a rehearsal`);
  }
  if (choice.kind === 'local') return aesGcmCipher(await readFile(choice.keyFile));
  return ageCipher({
    command: choice.command,
    recipient: choice.recipient,
    identityFile: choice.identityFile,
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
        cipher: await cipherFor(options, 'seal'),
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
        cipher: await cipherFor(options, 'open'),
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
        cipher: await cipherFor(options, 'open'),
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
