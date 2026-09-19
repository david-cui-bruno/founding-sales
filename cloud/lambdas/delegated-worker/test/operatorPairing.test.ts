import { beforeEach, describe, expect, it, vi } from 'vitest';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseOperatorArgs, reservePrivateOutput, runOperatorPairing, type OperatorCloud, type OperatorDependencies } from '../src/operatorPairing';
import { DynamoStore } from '../src/dynamoStore';
import { V1Devices } from '../src/v1/devices';
import { WorkerAuth } from '../src/workerAuth';
import { ConditionalCommandHarness } from './sdkHarness';

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

describe('credential rotation on an existing pairing (--rotate)', () => {
  const fullScopes = 'commands:write,events:read,google:grant,pairing:revoke';
  const rotateArgs = (pairingId: string, scopes = fullScopes) => ['--rotate', pairingId, '--account', '123456789012', '--region', 'us-east-1',
    '--table', 'worker-table', '--workspace', 'workspace-one', '--expires', '300', '--scopes', scopes, '--output', '/vault/code'];
  /** A real WorkerAuth over the conditional harness, so the tool's existence and revocation checks read real records. */
  async function pairedFixture(revoked = false) {
    const dynamo = new ConditionalCommandHarness();
    // The fixture clock sits well before the real clock the tool stamps expiry with, so the saved code is redeemable here.
    const auth = new WorkerAuth({ dynamo, tableName: tableArn, workspaceId: 'workspace-one', clock: { now: () => '2026-09-01T00:00:00.000Z' } });
    const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
    const grant = await auth.redeemPairing(issued.code, 'fixture');
    if (revoked) await auth.revokePairing(grant.pairingId);
    const order: string[] = [];
    const send = vi.fn(async (command: Parameters<typeof dynamo.send>[0]) => { order.push(command.constructor.name); return dynamo.send(command); });
    const cloud: OperatorCloud = {
      getCallerIdentity: vi.fn(async () => { order.push('sts'); return { Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/operator/session' }; }),
      describeTable: vi.fn(async () => { order.push('table'); return { TableName: 'worker-table', TableArn: tableArn, TableStatus: 'ACTIVE' }; }),
      dynamo: { send }, close: vi.fn(),
    };
    const deps: OperatorDependencies = {
      reserveOutput: vi.fn(async path => { order.push('reserve'); return reservePrivateOutput(path); }),
      connect: vi.fn(async () => { order.push('connect'); return cloud; }),
    };
    const bootstraps = () => dynamo.dump().filter(item => item.sk?.S?.startsWith('BOOTSTRAP#'));
    return { dynamo, auth, grant, cloud, deps, order, send, bootstraps };
  }
  it('parses --rotate with a pairing id and the full desktop scope set', () => {
    const pairingId = '11111111-1111-4111-8111-111111111111';
    expect(parseOperatorArgs(rotateArgs(pairingId))).toMatchObject({ rotate: pairingId, scopes: fullScopes.split(','), execute: false });
    expect(parseOperatorArgs(args)).toMatchObject({ rotate: null });
    expect(parseOperatorArgs([...rotateArgs(pairingId), '--execute'])).toMatchObject({ rotate: pairingId, execute: true });
  });
  it.each([
    ['not a uuid', ['--rotate', 'pairing-one']],
    ['a uuid in upper case', ['--rotate', '11111111-1111-4111-8111-11111111111A']],
    ['a reserved flag-like id', ['--rotate', '--execute']],
    ['a missing id', ['--rotate']],
    ['a repeated --rotate', ['--rotate', '11111111-1111-4111-8111-111111111111', '--rotate', '11111111-1111-4111-8111-111111111111']],
  ])('refuses %s without IO or echo', async (_label, rotate) => {
    const input = [...args, ...rotate, '--execute'];
    const f = fixture(), response = await runOperatorPairing(input, f.deps);
    expect(response.exitCode).toBe(2); expect(response.message).toBe('Invalid arguments. Use --help.');
    expect(f.deps.reserveOutput).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled();
  });
  const narrowed = ['events:read', 'commands:write', 'google:grant,pairing:revoke', 'events:read,google:grant', 'commands:write,pairing:revoke'];
  it.each(narrowed)('refuses a rotation scope set %s that drops commands:write or events:read, before any IO', async scopes => {
    const f = fixture(), response = await runOperatorPairing([...rotateArgs('11111111-1111-4111-8111-111111111111', scopes), '--execute'], f.deps);
    expect(response.exitCode).toBe(2); expect(response.message).toBe('Invalid arguments. Use --help.');
    expect(f.deps.reserveOutput).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('names the rotation flag in help and says a dry run verifies nothing', async () => {
    const help = await runOperatorPairing(['--help']);
    expect(help.exitCode).toBe(0); expect(help.message).toContain('--rotate PAIRING_ID'); expect(help.message).toContain('existing');
    const f = fixture(), dry = await runOperatorPairing(rotateArgs('11111111-1111-4111-8111-111111111111'), f.deps);
    expect(dry.exitCode).toBe(0); expect(dry.message).toContain('No IO performed'); expect(dry.message).toContain('No rotation issued');
    expect(dry.message).not.toContain('11111111');
    expect(f.deps.reserveOutput).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(disk.lstat).not.toHaveBeenCalled(); expect(disk.open).not.toHaveBeenCalled();
  });
  it('executes: checks identity and table, reads the pairing, writes one rotation bootstrap and saves only the code privately', async () => {
    const f = await pairedFixture();
    const response = await runOperatorPairing([...rotateArgs(f.grant.pairingId), '--execute'], f.deps);
    expect(response).toEqual({ exitCode: 0, message: expect.stringContaining('Rotation code saved to private output') });
    expect(response.message).not.toContain(f.grant.pairingId);
    expect(f.order.slice(0, 4)).toEqual(['reserve', 'connect', 'sts', 'table']);
    expect(f.order.slice(4)).toEqual(['GetItemCommand', 'TransactWriteItemsCommand']);
    const written = f.bootstraps();
    expect(written).toHaveLength(2);
    const before = Date.now();
    const rotation = written.map(item => JSON.parse(item.data!.S!) as { kind?: string; pairingId: string; scopes: string[]; expiresAt: number; consumed: boolean }).find(record => record.kind === 'rotation')!;
    // The tool stamps expiry from the real clock (the harness clock only serves the fixture's own pairing).
    expect(rotation).toEqual({ kind: 'rotation', pairingId: f.grant.pairingId, scopes: fullScopes.split(','), expiresAt: expect.any(Number), consumed: false });
    expect(rotation.expiresAt).toBeGreaterThan(before + 290_000); expect(rotation.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
    const codeLine = disk.write.mock.calls[0]![0] as string;
    expect(codeLine).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    const code = codeLine.trim();
    expect(f.dynamo.dump().some(item => item.sk?.S === `BOOTSTRAP#${createHash('sha256').update(code).digest('hex')}`)).toBe(true);
    expect(JSON.stringify(f.dynamo.dump())).not.toContain(code); expect(JSON.stringify(response)).not.toContain(code);
    // The current credential keeps working until the code is redeemed: nothing about the pairing changed here.
    expect(f.dynamo.inspect(`PAIRING#${f.grant.pairingId}`)).toEqual({ pairingId: f.grant.pairingId, generation: 0, revoked: false });
    expect((await f.auth.authenticate(`Bearer ${f.grant.credential}`, ['commands:write'])).generation).toBe(0);
    expect(disk.close).toHaveBeenCalledTimes(2); expect(f.cloud.close).toHaveBeenCalledOnce();
    // Redeeming the saved code rotates the credential in place.
    const rotated = await f.auth.redeemPairing(code, 'desktop');
    expect(rotated).toMatchObject({ pairingId: f.grant.pairingId, generation: 1, scopes: fullScopes.split(',') });
  });
  it.each(['unknown', 'revoked'] as const)('refuses a %s pairing after the identity checks, writes nothing and keeps the reserved output', async kind => {
    const f = await pairedFixture(kind === 'revoked');
    const pairingId = kind === 'unknown' ? '00000000-0000-4000-8000-000000000000' : f.grant.pairingId;
    const response = await runOperatorPairing([...rotateArgs(pairingId), '--execute'], f.deps);
    expect(response.exitCode).toBe(1);
    expect(response.message).toBe('Pairing unknown or revoked. No rotation issued. Reserved output retained.');
    expect(f.order.slice(0, 4)).toEqual(['reserve', 'connect', 'sts', 'table']);
    expect(f.order.slice(4)).toEqual(['GetItemCommand']);
    expect(f.bootstraps()).toHaveLength(1); expect(disk.write).not.toHaveBeenCalled();
    expect(disk.close).toHaveBeenCalledTimes(2); expect(f.cloud.close).toHaveBeenCalledOnce();
  });
  it('refuses the rotation before any write when the identity or table mismatches', async () => {
    const f = await pairedFixture();
    vi.mocked(f.cloud.getCallerIdentity).mockResolvedValue({ Account: '000000000000' });
    const response = await runOperatorPairing([...rotateArgs(f.grant.pairingId), '--execute'], f.deps);
    expect(response.message).toContain('Identity mismatch'); expect(response.message).toContain('No pairing issued');
    expect(f.send).not.toHaveBeenCalled(); expect(disk.write).not.toHaveBeenCalled();
  });
  it('reports a failed rotation write as uncertain, never as a refusal', async () => {
    const f = await pairedFixture();
    f.dynamo.beforeTransaction = () => { throw new Error(sensitive); };
    const response = await runOperatorPairing([...rotateArgs(f.grant.pairingId), '--execute'], f.deps);
    expect(response.exitCode).toBe(1); expect(response.message).toContain('uncertain'); expect(response.message).toContain('Do NOT blindly retry');
    expect(JSON.stringify(response)).not.toContain(sensitive); expect(disk.write).not.toHaveBeenCalled();
  });
});

describe('device code for the /v1 thin client (--mint-device-code)', () => {
  const mintArgs = ['--mint-device-code', '--account', '123456789012', '--region', 'us-east-1', '--table', 'worker-table',
    '--workspace', 'workspace-one', '--label', 'David MacBook', '--expires', '600', '--output', '/vault/code'];
  const replaced = (key: string, value: string) => { const input = [...mintArgs]; input[input.indexOf(key) + 1] = value; return input; };
  const without = (key: string) => { const input = [...mintArgs]; input.splice(input.indexOf(key), 2); return input; };
  /** A real store over the conditional harness, so the saved code is redeemed by the real device store. The fixture clock sits
   *  well before the real clock the tool stamps expiry with, so the code is unexpired here. */
  function deviceFixture() {
    const dynamo = new ConditionalCommandHarness();
    const store = new DynamoStore({ dynamo, tableName: tableArn, workspaceId: 'workspace-one', clock: { now: () => '2026-09-01T00:00:00.000Z' } });
    const order: string[] = [];
    const cloud: OperatorCloud = {
      getCallerIdentity: vi.fn(async () => { order.push('sts'); return { Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/operator/session' }; }),
      describeTable: vi.fn(async () => { order.push('table'); return { TableName: 'worker-table', TableArn: tableArn, TableStatus: 'ACTIVE' }; }),
      dynamo: { send: async command => { order.push(command.constructor.name); return dynamo.send(command); } }, close: vi.fn(),
    };
    const deps: OperatorDependencies = {
      reserveOutput: vi.fn(async path => { order.push('reserve'); return reservePrivateOutput(path); }),
      connect: vi.fn(async () => { order.push('connect'); return cloud; }),
    };
    return { dynamo, store, cloud, deps, order };
  }
  it('parses the device-code form: a label, a 60..900 second expiry, no scopes and no rotation', () => {
    expect(parseOperatorArgs(mintArgs)).toMatchObject({ mode: 'device_code', label: 'David MacBook', expires: 600, scopes: [], rotate: null, execute: false, workspace: 'workspace-one' });
    expect(parseOperatorArgs([...mintArgs, '--execute'])).toMatchObject({ mode: 'device_code', execute: true });
    expect(parseOperatorArgs(replaced('--expires', '60'))).toMatchObject({ expires: 60 });
    expect(parseOperatorArgs(replaced('--expires', '900'))).toMatchObject({ expires: 900 });
    expect(parseOperatorArgs(args)).toMatchObject({ mode: 'pairing', label: null });
  });
  it.each([
    ['--scopes beside a device code', [...mintArgs, '--scopes', 'events:read']],
    ['--rotate beside a device code', [...mintArgs, '--rotate', '11111111-1111-4111-8111-111111111111']],
    ['a repeated --mint-device-code', [...mintArgs, '--mint-device-code']],
    ['a missing label', without('--label')],
    ['a label over 80 characters', replaced('--label', 'x'.repeat(81))],
    ['a label with a control character', replaced('--label', 'tab\there')],
    ['a label that looks like a flag', replaced('--label', '--execute')],
    ['an expiry under 60', replaced('--expires', '59')],
    ['an expiry over 900', replaced('--expires', '901')],
    ['a missing expiry', without('--expires')],
    ['a label on a desktop pairing', [...args, '--label', 'David MacBook']],
  ])('refuses %s before any IO and without echo', async (_label, input) => {
    const f = fixture(), response = await runOperatorPairing([...input, '--execute'], f.deps);
    expect(response.exitCode).toBe(2); expect(response.message).toBe('Invalid arguments. Use --help.');
    expect(f.deps.reserveOutput).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('names the flag in help, and a dry run performs no IO and says no device code was issued', async () => {
    const help = await runOperatorPairing(['--help']);
    expect(help.exitCode).toBe(0); expect(help.message).toContain('--mint-device-code'); expect(help.message).toContain('--label TEXT'); expect(help.message).toContain('60..900');
    const f = fixture(), dry = await runOperatorPairing(mintArgs, f.deps);
    expect(dry.exitCode).toBe(0); expect(dry.message).toContain('No IO performed'); expect(dry.message).toContain('No device code issued');
    expect(dry.message).not.toContain('David MacBook');
    expect(f.deps.reserveOutput).not.toHaveBeenCalled(); expect(f.deps.connect).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(disk.lstat).not.toHaveBeenCalled(); expect(disk.open).not.toHaveBeenCalled();
  });
  it('mints one PAIRCODE# row holding only the hash and the label, saves the code privately, and that code redeems once for a device token', async () => {
    const f = deviceFixture();
    const response = await runOperatorPairing([...mintArgs, '--execute'], f.deps);
    expect(response).toEqual({ exitCode: 0, message: 'Device code saved to private output. No code printed.' });
    expect(f.order).toEqual(['reserve', 'connect', 'sts', 'table', 'TransactWriteItemsCommand']);
    expect(disk.write).toHaveBeenCalledOnce();
    const codeLine = disk.write.mock.calls[0]![0] as string; const code = codeLine.trim();
    expect(codeLine).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    const rows = f.dynamo.dump();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sk!.S).toBe(`PAIRCODE#${createHash('sha256').update(code).digest('hex')}`);
    expect(rows[0]!.pk!.S).toBe('WORKSPACE#workspace-one');
    expect(JSON.parse(rows[0]!.data!.S!)).toMatchObject({ label: 'David MacBook', consumedAt: null });
    expect(Number(rows[0]!.ttl!.N)).toBeGreaterThan(Date.now() / 1000);
    expect(JSON.stringify(rows)).not.toContain(code); expect(JSON.stringify(response)).not.toContain(code);
    expect(disk.close).toHaveBeenCalledTimes(2); expect(f.cloud.close).toHaveBeenCalledOnce();
    // The saved code is what a fresh thin client redeems, once.
    const devices = new V1Devices(f.store);
    const redeemed = await devices.redeem(code);
    expect(redeemed).toMatchObject({ workspaceId: 'workspace-one' });
    expect(await devices.authenticate(`Bearer ${redeemed.deviceToken}`)).toMatchObject({ label: 'David MacBook' });
    await expect(devices.redeem(code)).rejects.toMatchObject({ reason: 'code_consumed' });
  });
  it('refuses an identity mismatch in the device-code words before any write, and reports a failed write as uncertain', async () => {
    const mismatch = deviceFixture();
    vi.mocked(mismatch.cloud.getCallerIdentity).mockResolvedValue({ Account: '000000000000' });
    const refused = await runOperatorPairing([...mintArgs, '--execute'], mismatch.deps);
    expect(refused).toEqual({ exitCode: 1, message: 'Identity mismatch or table not active. No device code issued. Reserved output retained.' });
    expect(mismatch.dynamo.dump()).toHaveLength(0); expect(disk.write).not.toHaveBeenCalled();
    const failing = deviceFixture();
    failing.dynamo.beforeTransaction = () => { throw new Error(sensitive); };
    const uncertain = await runOperatorPairing([...mintArgs, '--execute'], failing.deps);
    expect(uncertain.exitCode).toBe(1); expect(uncertain.message).toContain('uncertain'); expect(uncertain.message).toContain('Do NOT blindly retry');
    expect(JSON.stringify(uncertain)).not.toContain(sensitive); expect(disk.write).not.toHaveBeenCalled();
  });

  const OLD_DEVICE = '00000000-0000-4000-8000-00000000000a';
  it('parses --replace-device as a lower-case v4 uuid beside --mint-device-code only', () => {
    expect(parseOperatorArgs(mintArgs)).toMatchObject({ mode: 'device_code', replaceDevice: null });
    expect(parseOperatorArgs([...mintArgs, '--replace-device', OLD_DEVICE])).toMatchObject({ mode: 'device_code', replaceDevice: OLD_DEVICE, label: 'David MacBook' });
    expect(parseOperatorArgs(args)).toMatchObject({ mode: 'pairing', replaceDevice: null });
    for (const input of [
      [...args, '--replace-device', OLD_DEVICE],
      [...mintArgs, '--replace-device', '11111111-1111-1111-1111-111111111111'],
      [...mintArgs, '--replace-device', OLD_DEVICE.toUpperCase()],
      [...mintArgs, '--replace-device', 'not-a-device'],
      [...mintArgs, '--replace-device', OLD_DEVICE, '--replace-device', OLD_DEVICE],
      [...mintArgs, '--replace-device'],
    ]) expect(() => parseOperatorArgs(input)).toThrow('invalid_arguments');
  });
  it('names --replace-device in help', async () => {
    const help = await runOperatorPairing(['--help']);
    expect(help.message).toContain('--replace-device DEVICE_ID');
  });
  it('refuses to mint a replacement for an unknown or already revoked device after the identity checks, writing nothing', async () => {
    const f = deviceFixture();
    const devices = new V1Devices(f.store);
    const revoked = await devices.redeem((await devices.mintPairCode({ label: 'Gone Mac', expiresInSeconds: 600 })).code);
    const plan = await devices.planRevoke(revoked.deviceId);
    if (!('item' in plan)) throw new Error(plan.refused);
    await f.store.transact([plan.item]);
    const before = f.dynamo.dump().length;
    for (const target of [OLD_DEVICE, revoked.deviceId]) {
      f.order.length = 0;
      const response = await runOperatorPairing([...mintArgs, '--replace-device', target, '--execute'], f.deps);
      expect(response).toEqual({ exitCode: 1, message: 'Device unknown or revoked. No device code issued. Reserved output retained.' });
      expect(f.order.slice(0, 4)).toEqual(['reserve', 'connect', 'sts', 'table']);
      expect(f.order.slice(4)).toEqual(['QueryCommand']);
    }
    expect(f.dynamo.dump()).toHaveLength(before); expect(disk.write).not.toHaveBeenCalled();
  });
  it('mints a code that names the device to replace; redeeming it creates the new device and revokes the old one in one transaction', async () => {
    const f = deviceFixture();
    const devices = new V1Devices(f.store);
    const old = await devices.redeem((await devices.mintPairCode({ label: 'Old Mac', expiresInSeconds: 600 })).code);
    expect(await devices.authenticate(`Bearer ${old.deviceToken}`)).toMatchObject({ deviceId: old.deviceId });
    const response = await runOperatorPairing([...mintArgs, '--replace-device', old.deviceId, '--execute'], f.deps);
    expect(response).toEqual({ exitCode: 0, message: 'Device code saved to private output. No code printed.' });
    expect(f.order).toEqual(['reserve', 'connect', 'sts', 'table', 'QueryCommand', 'TransactWriteItemsCommand']);
    const code = (disk.write.mock.calls[0]![0] as string).trim();
    const codeRow = f.dynamo.dump().find(item => item.sk!.S === `PAIRCODE#${createHash('sha256').update(code).digest('hex')}`)!;
    expect(JSON.parse(codeRow.data!.S!)).toMatchObject({ label: 'David MacBook', consumedAt: null, replaceDeviceId: old.deviceId });
    const transactions = f.dynamo.transactions.length;
    const fresh = await devices.redeem(code);
    expect(f.dynamo.transactions).toHaveLength(transactions + 1);
    const keys = f.dynamo.transactions.at(-1)!.TransactItems!.map(item => item.Put!.Item!.sk!.S!).sort();
    expect(keys.filter(key => key.startsWith('DEVICE#'))).toHaveLength(2);
    expect(keys.filter(key => key.startsWith('PAIRCODE#'))).toHaveLength(1);
    await expect(devices.authenticate(`Bearer ${old.deviceToken}`)).rejects.toThrow('unauthenticated');
    expect(await devices.authenticate(`Bearer ${fresh.deviceToken}`)).toMatchObject({ deviceId: fresh.deviceId, label: 'David MacBook' });
    // Both devices were created at the fixture's one instant, so the list's order between them is unspecified: check each by id.
    const listed = await devices.listDevices();
    expect(listed).toHaveLength(2);
    expect(listed.find(device => device.deviceId === old.deviceId)).toMatchObject({ revokedAt: '2026-09-01T00:00:00.000Z' });
    expect(listed.find(device => device.deviceId === fresh.deviceId)).toMatchObject({ label: 'David MacBook', revokedAt: null });
  });
});
