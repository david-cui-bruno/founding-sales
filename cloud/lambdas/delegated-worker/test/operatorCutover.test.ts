import { describe, expect, it, vi } from 'vitest';
import { CUTOVER_EXPORT_KIND, CUTOVER_EXPORT_VERSION } from '../../../../src/shared/contracts/cutoverExportContract';
import { parseOperatorArgs, runOperatorPairing, type OperatorCloud, type OperatorDependencies } from '../src/operatorPairing';
import { firmKey } from '../src/v1/firmsWrite';
import { PHONE_SETUP_KEY } from '../src/v1/phoneSetup';
import { ConditionalCommandHarness } from './sdkHarness';

/**
 * The operator tool's two cutover modes (slice S6). They mint nothing, write no file and return no secret; the
 * dry run reads the live table and prints the plan, the execute commits it. Both verify the caller's identity and
 * the table before reading anything, exactly as the pairing modes do.
 */

const cloudArgs = ['--account', '123456789012', '--region', 'us-east-1', '--table', 'worker-table', '--workspace', 'workspace-one'];
const tableArn = 'arn:aws:dynamodb:us-east-1:123456789012:table/worker-table';

function fixture(exportText?: string) {
  const db = new ConditionalCommandHarness();
  const cloud: OperatorCloud = {
    getCallerIdentity: vi.fn(async () => ({ Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/operator/session' })),
    describeTable: vi.fn(async () => ({ TableName: 'worker-table', TableArn: tableArn, TableStatus: 'ACTIVE' })),
    dynamo: db, close: vi.fn(),
  };
  const deps: OperatorDependencies = {
    reserveOutput: vi.fn(async () => { throw new Error('the cutover modes never reserve an output'); }),
    connect: vi.fn(async () => cloud),
    readExport: vi.fn(async () => { if (exportText === undefined) throw new Error('no export'); return exportText; }),
  };
  return { db, cloud, deps };
}
const emptyExport = JSON.stringify({ kind: CUTOVER_EXPORT_KIND, version: CUTOVER_EXPORT_VERSION, exportedAt: '2026-09-19T11:00:00.000Z',
  schemaVersion: 30, callbacks: [], neverCall: [], templates: [], phone: { status: 'cleared', confirmedAt: null, proofDigest: null },
  counts: { callbacks: 0, neverCall: 0, templates: 0 } });

describe('the operator tool cutover modes', () => {
  it('parses exactly one of --dry-run and --execute, and none of the pairing arguments', () => {
    expect(parseOperatorArgs([...cloudArgs, '--cutover-copy', '--dry-run'])).toEqual({
      account: '123456789012', region: 'us-east-1', table: 'worker-table', workspace: 'workspace-one',
      mode: 'cutover_copy', execute: false, file: null });
    expect(parseOperatorArgs([...cloudArgs, '--cutover-copy', '--execute'])).toMatchObject({ mode: 'cutover_copy', execute: true });
    expect(parseOperatorArgs([...cloudArgs, '--cutover-import', '/vault/export.json', '--dry-run']))
      .toMatchObject({ mode: 'cutover_import', execute: false, file: '/vault/export.json' });
    for (const input of [
      [...cloudArgs, '--cutover-copy'],
      [...cloudArgs, '--cutover-copy', '--dry-run', '--execute'],
      [...cloudArgs, '--cutover-copy', '--dry-run', '--output', '/vault/code'],
      [...cloudArgs, '--cutover-copy', '--dry-run', '--expires', '60'],
      [...cloudArgs, '--cutover-copy', '--cutover-import', '/vault/export.json', '--dry-run'],
      [...cloudArgs, '--cutover-import', 'relative/export.json', '--dry-run'],
      [...cloudArgs, '--cutover-copy', '--mint-device-code', '--dry-run'],
    ]) expect(() => parseOperatorArgs(input), input.join(' ')).toThrow('invalid_arguments');
    // --dry-run is only ever a cutover flag; a pairing invocation that carries it is refused.
    expect(() => parseOperatorArgs(['--account', '123456789012', '--region', 'us-east-1', '--table', 'worker-table',
      '--workspace', 'workspace-one', '--expires', '60', '--scopes', 'events:read', '--output', '/vault/code', '--dry-run'])).toThrow('invalid_arguments');
  });

  it('names both modes in the help, without inventing a new credential', async () => {
    const help = await runOperatorPairing(['--help']);
    expect(help.exitCode).toBe(0);
    expect(help.message).toContain('--cutover-copy --dry-run|--execute');
    expect(help.message).toContain('--cutover-import /absolute/path --dry-run|--execute');
    expect(help.message).toContain('never deletes anything');
  });

  it('prints the table and writes nothing on a copy dry run', async () => {
    const f = fixture();
    const response = await runOperatorPairing([...cloudArgs, '--cutover-copy', '--dry-run'], f.deps);
    expect(response.exitCode).toBe(0);
    expect(response.message).toContain('would-write');
    expect(response.message).toContain('Dry run only. Nothing was written.');
    expect(f.db.transactions).toEqual([]);
    expect(f.deps.reserveOutput).not.toHaveBeenCalled();
    expect(f.cloud.close).toHaveBeenCalled();
  });

  it('refuses a caller or a table that is not the named one, before any read of the workspace', async () => {
    const f = fixture();
    (f.cloud.describeTable as ReturnType<typeof vi.fn>).mockResolvedValue({ TableName: 'worker-table', TableArn: tableArn, TableStatus: 'CREATING' });
    const response = await runOperatorPairing([...cloudArgs, '--cutover-copy', '--execute'], f.deps);
    expect(response.exitCode).toBe(1);
    expect(response.message).toContain('Identity mismatch or table not active');
    expect(f.db.transactions).toEqual([]);
  });

  it('runs the import from the file the adapter read, and refuses a file that is not an export', async () => {
    const good = fixture(emptyExport);
    const response = await runOperatorPairing([...cloudArgs, '--cutover-import', '/vault/export.json', '--execute'], good.deps);
    expect(response.exitCode).toBe(0);
    expect(response.message).toContain('Cutover import executed');
    expect(good.db.inspect(PHONE_SETUP_KEY)).toMatchObject({ status: 'cleared' });

    const bad = fixture('{"kind":"something else"}');
    const refused = await runOperatorPairing([...cloudArgs, '--cutover-import', '/vault/export.json', '--dry-run'], bad.deps);
    expect(refused.exitCode).toBe(2);
    expect(refused.message).toContain('file_not_an_export');
    expect(bad.db.transactions).toEqual([]);
  });

  it('fails closed without an injected adapter, and never writes a firm record from a dry run', async () => {
    const response = await runOperatorPairing([...cloudArgs, '--cutover-copy', '--dry-run']);
    expect(response.exitCode).toBe(2);
    expect(response.message).toContain('No cutover copy performed');
    const f = fixture();
    await runOperatorPairing([...cloudArgs, '--cutover-copy', '--dry-run'], f.deps);
    expect(f.db.dump().some(item => String(item.sk?.S).startsWith(firmKey('')))).toBe(false);
  });
});
