import { beforeEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseOperatorArgs, reservePrivateOutput, runOperatorPairing, type OperatorCloud, type OperatorDependencies } from '../src/operatorPairing';

// In-memory filesystem only. These tests never access a filesystem or AWS.
const disk = vi.hoisted(() => ({ lstat: vi.fn(), open: vi.fn(), write: vi.fn(), sync: vi.fn(), close: vi.fn(), stat: vi.fn() }));
vi.mock('node:fs/promises', () => ({ lstat: disk.lstat, open: disk.open }));
const args = ['--account', '123456789012', '--region', 'us-east-1', '--table', 'worker-table',
  '--workspace', 'workspace-one', '--expires', '60', '--scopes', 'events:read', '--output', '/vault/code'];
const execute = [...args, '--execute'];
const tableArn = 'arn:aws:dynamodb:us-east-1:123456789012:table/worker-table';
const sensitive = 'DO_NOT_EXPOSE_PROVIDER_SECRET';
function fixture() {
  const order: string[] = [];
  const send = vi.fn(async (_command: unknown) => { void _command; order.push('issue'); return { $metadata: {} }; });
  const cloud: OperatorCloud = {
    getCallerIdentity: vi.fn(async () => { order.push('sts'); return { Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/operator/session' }; }),
    describeTable: vi.fn(async () => { order.push('table'); return { TableName: 'worker-table', TableArn: tableArn, TableStatus: 'ACTIVE' }; }),
    dynamo: { send }, close: vi.fn(),
  };
  const deps: OperatorDependencies = {
    reserveOutput: vi.fn(async path => { order.push('reserve'); return reservePrivateOutput(path); }),
    connect: vi.fn(async () => { order.push('connect'); return cloud; }),
  };
  return { cloud, deps, order, send };
}
function stat(mode: number, directory: boolean, symbolic = false) {
  return { mode, uid: process.getuid!(), nlink: 1, isDirectory: () => directory, isFile: () => !directory,
    isSymbolicLink: () => symbolic };
}
beforeEach(() => {
  vi.resetAllMocks();
  disk.lstat.mockImplementation(async (path: string) => stat(path === '/vault' ? 0o700 : 0o755, true));
  disk.stat.mockResolvedValue(stat(0o600, false));
  disk.open.mockImplementation(async (path: string) => path === '/vault'
    ? { sync: disk.sync, close: disk.close }
    : { stat: disk.stat, sync: disk.sync, close: disk.close, writeFile: disk.write });
});

describe('operator pairing pure CLI gate', () => {
  it.each([{ input: [] }, { input: ['--help'] }, { input: args }])('never performs IO for noargs/help/dry-run ($input)', async ({ input }) => {
    const f = fixture();
    expect((await runOperatorPairing(input, f.deps)).exitCode).toBe(0);
    expect(f.deps.reserveOutput).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled();
    expect(disk.lstat).not.toHaveBeenCalled(); expect(disk.open).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('fails closed without a live STS adapter even with execute', async () => {
    expect(await runOperatorPairing(execute)).toMatchObject({ exitCode: 2, message: expect.stringContaining('STS') });
    expect(disk.open).not.toHaveBeenCalled();
  });
  it.each([
    ['--account', '123'], ['--region', 'https://evil.test'], ['--table', 'arn:aws:dynamodb:wrong'],
    ['--workspace', ' space '], ['--workspace', 'workspace.dot'], ['--workspace', '--reserved'], ['--expires', '29'], ['--expires', '601'], ['--expires', '3e2'],
    ['--scopes', 'emergency:stop'], ['--scopes', 'events:read,events:read'], ['--scopes', ''],
    ['--output', 'relative'], ['--output', '/vault/../code'], ['--output', '/vault/link/'], ['--output', '/vault/\ncode'],
  ])('rejects invalid %s without IO', async (key, value) => {
    const invalid = [...execute]; invalid[invalid.indexOf(key) + 1] = value;
    const f = fixture(); expect((await runOperatorPairing(invalid, f.deps)).exitCode).toBe(2);
    expect(f.deps.reserveOutput).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled();
  });
  it.each(['--account', '--region', '--table', '--workspace', '--expires', '--scopes', '--output'])('requires %s explicitly', key => {
    const input = [...args]; input.splice(input.indexOf(key), 2);
    expect(() => parseOperatorArgs(input)).toThrow('invalid_arguments');
  });
  it('rejects duplicate, unknown, help-plus-execute, and secret arguments without echo', async () => {
    for (const input of [[...execute, '--execute'], [...execute, '--account', '123456789012'],
      ['--help', '--execute'], [...execute, '--code', sensitive], [...execute, sensitive]]) {
      const f = fixture(), response = await runOperatorPairing(input, f.deps);
      expect(response.exitCode).toBe(2); expect(JSON.stringify(response)).not.toContain(sensitive);
      expect(f.deps.connect).not.toHaveBeenCalled();
    }
  });
  it.each(['_workspace', '-workspace', 'workspace_one', 'a'.repeat(128)])('accepts Terraform workspace identifier %s', workspace => {
    const input = [...args]; input[input.indexOf('--workspace') + 1] = workspace;
    expect(parseOperatorArgs(input)).toMatchObject({ workspace });
  });
  it.each(['30', '600'])('accepts bounded expiry %s', expiry => {
    const input = [...args]; input[input.indexOf('--expires') + 1] = expiry;
    expect(parseOperatorArgs(input)).toMatchObject({ expires: Number(expiry), execute: false });
  });
});

describe('trusted execution preflight and private output', () => {
  it.each(['existing', 'symlink', 'unwritable'])('refuses %s destination before cloud connection', async kind => {
    disk.open.mockImplementation(async (path: string) => {
      if (path === '/vault') return { sync: disk.sync, close: disk.close };
      throw Object.assign(new Error(sensitive), { code: kind === 'unwritable' ? 'EACCES' : 'EEXIST' });
    });
    const f = fixture(), response = await runOperatorPairing(execute, f.deps);
    expect(response.exitCode).toBe(1); expect(JSON.stringify(response)).not.toContain(sensitive);
    expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(disk.open).toHaveBeenCalledWith('/vault/code', constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  });
  it.each(['public', 'symlink', 'unwritable', 'foreign'])('refuses %s parent before issuance', async kind => {
    disk.lstat.mockImplementation(async () => ({ ...stat(kind === 'public' ? 0o755 : kind === 'unwritable' ? 0o500 : 0o700, true, kind === 'symlink'),
      ...(kind === 'foreign' ? { uid: process.getuid!() + 1 } : {}) }));
    const f = fixture(); expect((await runOperatorPairing(execute, f.deps)).exitCode).toBe(1);
    expect(disk.open).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled();
  });
  it('rejects untrusted ancestors', async () => {
    disk.lstat.mockImplementation(async (path: string) => stat(path === '/vault' ? 0o700 : 0o777, true));
    const f = fixture(); expect((await runOperatorPairing(execute, f.deps)).exitCode).toBe(1);
    expect(f.deps.connect).not.toHaveBeenCalled();
  });
  it.each(['account', 'callerArn', 'tableAccount', 'tableRegion', 'tableName', 'inactive', 'missingArn'])('refuses %s mismatch before writes', async kind => {
    const f = fixture();
    if (kind === 'account') vi.mocked(f.cloud.getCallerIdentity).mockResolvedValue({ Account: '000000000000' });
    if (kind === 'callerArn') vi.mocked(f.cloud.getCallerIdentity).mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:sts::000000000000:assumed-role/operator/session' });
    const table = { TableName: 'worker-table', TableArn: tableArn, TableStatus: 'ACTIVE' };
    if (kind === 'tableAccount') table.TableArn = tableArn.replace('123456789012', '000000000000');
    if (kind === 'tableRegion') table.TableArn = tableArn.replace('us-east-1', 'us-west-2');
    if (kind === 'tableName') table.TableName = 'other-table';
    if (kind === 'inactive') table.TableStatus = 'DELETING';
    if (kind === 'missingArn') table.TableArn = '';
    vi.mocked(f.cloud.describeTable).mockResolvedValue(table);
    expect((await runOperatorPairing(execute, f.deps)).message).toContain('Identity mismatch');
    expect(f.send).not.toHaveBeenCalled(); expect(disk.write).not.toHaveBeenCalled();
  });
  it('sanitizes read failures and never issues', async () => {
    const f = fixture(); vi.mocked(f.cloud.getCallerIdentity).mockRejectedValue(new Error(sensitive));
    const response = await runOperatorPairing(execute, f.deps);
    expect(response.message).toContain('No pairing issued'); expect(JSON.stringify(response)).not.toContain(sensitive);
    expect(f.send).not.toHaveBeenCalled(); expect(f.cloud.close).toHaveBeenCalledOnce();
  });
  it('verifies output durability before connecting', async () => {
    disk.sync.mockRejectedValue(new Error(sensitive)); const f = fixture();
    expect((await runOperatorPairing(execute, f.deps)).exitCode).toBe(1);
    expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects parent fsync failure before cloud connection and closes both descriptors', async () => {
    disk.sync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(sensitive));
    const f = fixture(), response = await runOperatorPairing(execute, f.deps);
    expect(response.exitCode).toBe(1); expect(response.message).toContain('No pairing issued');
    expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(disk.write).not.toHaveBeenCalled(); expect(disk.close).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(response)).not.toContain(sensitive);
  });
  it.each(['before-issue', 'after-issue', 'client-after-issue'])('retains honest %s diagnosis when cleanup also fails', async phase => {
    const f = fixture();
    if (phase === 'before-issue') vi.mocked(f.cloud.getCallerIdentity).mockRejectedValue(new Error(sensitive));
    else f.send.mockRejectedValue(new Error(sensitive));
    if (phase === 'client-after-issue') vi.mocked(f.cloud.close).mockImplementation(() => { throw new Error(sensitive); });
    else disk.close.mockRejectedValueOnce(new Error(sensitive));
    const response = await runOperatorPairing(execute, f.deps);
    expect(response.exitCode).toBe(1);
    expect(response.message).toContain(phase === 'before-issue' ? 'No pairing issued' : 'uncertain');
    expect(f.send).toHaveBeenCalledTimes(phase === 'before-issue' ? 0 : 1);
    expect(disk.write).not.toHaveBeenCalled(); expect(disk.close).toHaveBeenCalledTimes(2);
    expect(f.cloud.close).toHaveBeenCalledOnce(); expect(JSON.stringify(response)).not.toContain(sensitive);
  });
  it('reports issuance exceptions as uncertain without retries or leaked errors', async () => {
    const f = fixture(); f.send.mockRejectedValue(new Error(sensitive));
    const response = await runOperatorPairing(execute, f.deps);
    expect(response.message).toContain('uncertain'); expect(response.message).toContain('Do NOT blindly retry');
    expect(JSON.stringify(response)).not.toContain(sensitive); expect(f.send).toHaveBeenCalledOnce();
    expect(disk.write).not.toHaveBeenCalled(); expect(f.cloud.close).toHaveBeenCalledOnce();
  });
  it.each(['write', 'sync', 'parent-sync'])('reports %s failure after issuance honestly without retry', async kind => {
    if (kind === 'write') disk.write.mockRejectedValue(new Error(sensitive));
    else {
      disk.sync.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
      if (kind === 'parent-sync') disk.sync.mockResolvedValueOnce(undefined);
      disk.sync.mockRejectedValue(new Error(sensitive));
    }
    const f = fixture(), response = await runOperatorPairing(execute, f.deps);
    expect(response.exitCode).toBe(1); expect(response.message).toContain('uncertain');
    expect(JSON.stringify(response)).not.toContain(sensitive); expect(f.send).toHaveBeenCalledOnce();
  });
  it.each(['file', 'directory', 'client'])('reports %s cleanup failure after durable save without reissuing', async kind => {
    const f = fixture();
    if (kind === 'client') vi.mocked(f.cloud.close).mockImplementation(() => { throw new Error(sensitive); });
    else if (kind === 'file') disk.close.mockRejectedValueOnce(new Error(sensitive));
    else disk.close.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(sensitive));
    const response = await runOperatorPairing(execute, f.deps);
    expect(response.exitCode).toBe(1); expect(response.message).toContain('Code saved');
    expect(response.message).toContain('Do NOT retry issuance');
    expect(JSON.stringify(response)).not.toContain(sensitive);
    expect(f.send).toHaveBeenCalledOnce(); expect(disk.write).toHaveBeenCalledOnce();
    expect(disk.close).toHaveBeenCalledTimes(2); expect(f.cloud.close).toHaveBeenCalledOnce();
  });
  it('uses WorkerAuth once, stores only code in private final output and only its hash in DynamoDB', async () => {
    const f = fixture(), response = await runOperatorPairing(execute, f.deps);
    expect(response.exitCode).toBe(0); expect(f.order).toEqual(['reserve', 'connect', 'sts', 'table', 'issue']);
    expect(f.deps.connect).toHaveBeenCalledWith(expect.objectContaining({ execute: true }), { maxAttempts: 1 });
    expect(f.send).toHaveBeenCalledOnce(); expect(disk.write).toHaveBeenCalledOnce();
    const codeLine = disk.write.mock.calls[0]![0] as string;
    expect(codeLine).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    const code = codeLine.trim(), transaction = JSON.stringify(f.send.mock.calls);
    expect(transaction).toContain(createHash('sha256').update(code).digest('hex'));
    expect(transaction).toContain(tableArn); expect(transaction).not.toContain(code);
    expect(JSON.stringify(response)).not.toContain(code); expect(disk.sync).toHaveBeenCalledTimes(4);
    expect(disk.close).toHaveBeenCalledTimes(2); expect(f.cloud.close).toHaveBeenCalledOnce();
    // Only a directory descriptor and the exclusive final file, never secret temp files.
    expect(disk.open.mock.calls.map(call => call[0])).toEqual(['/vault', '/vault/code']);
  });
});
