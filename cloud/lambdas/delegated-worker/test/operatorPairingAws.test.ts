import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DescribeTableCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { connectOperatorAws, operatorAwsDependencies } from '../src/operatorPairingAws';
import { parseOperatorArgs, runOperatorPairing, type PairingOptions } from '../src/operatorPairing';
const sdk = vi.hoisted(() => ({
  provider: vi.fn(), dbSend: vi.fn(), stsSend: vi.fn(), dbConstruct: vi.fn(), stsConstruct: vi.fn(),
  db: [] as { input: Record<string, unknown>; destroy: ReturnType<typeof vi.fn> }[],
  sts: [] as { input: Record<string, unknown>; destroy: ReturnType<typeof vi.fn> }[],
}));
vi.mock('@aws-sdk/client-dynamodb', async importOriginal => ({
  ...await importOriginal<typeof import('@aws-sdk/client-dynamodb')>(),
  DynamoDBClient: class {
    config = { credentials: sdk.provider }; send = sdk.dbSend; destroy = vi.fn();
    constructor(input: Record<string, unknown>) { sdk.dbConstruct(input); sdk.db.push({ input, destroy: this.destroy }); }
  },
}));
vi.mock('@aws-sdk/client-sts', async importOriginal => ({
  ...await importOriginal<typeof import('@aws-sdk/client-sts')>(),
  STSClient: class {
    send = sdk.stsSend; destroy = vi.fn();
    constructor(input: Record<string, unknown>) { sdk.stsConstruct(input); sdk.sts.push({ input, destroy: this.destroy }); }
  },
}));
const args = ['--account', '123456789012', '--region', 'us-east-1', '--table', 'worker-table',
  '--workspace', 'workspace-one', '--expires', '60', '--scopes', 'events:read', '--output', '/vault/code'];
const options = parseOperatorArgs([...args, '--execute']) as PairingOptions;
const arn = 'arn:aws:dynamodb:us-east-1:123456789012:table/worker-table';
const sensitive = 'PROVIDER_SECRET_MUST_NOT_ESCAPE';
const policy = { maxAttempts: 1 } as const;
function deps() {
  const save = vi.fn(async (_code: string) => { void _code; }), close = vi.fn(async () => {});
  return { reserveOutput: vi.fn(async (_path: string) => { void _path; return { save, close }; }), connect: connectOperatorAws, save, close };
}
beforeEach(() => {
  vi.resetAllMocks(); sdk.db.length = 0; sdk.sts.length = 0;
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'fictional-access');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fictional-secret');
  vi.stubEnv('AWS_SESSION_TOKEN', 'fictional-token');
  sdk.provider.mockImplementation(() => { throw new Error(sensitive); });
  sdk.stsSend.mockResolvedValue({ Account: options.account, Arn: `arn:aws:sts::${options.account}:assumed-role/operator/session` });
  sdk.dbSend.mockImplementation(async command => command instanceof DescribeTableCommand
    ? { Table: { TableName: options.table, TableArn: arn, TableStatus: 'ACTIVE' } } : { $metadata: {} });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('AWS operator adapter with mocked SDK only', () => {
  it('composes without constructing clients or resolving credentials', () => {
    expect(operatorAwsDependencies.connect).toBe(connectOperatorAws);
    expect(sdk.dbConstruct).not.toHaveBeenCalled(); expect(sdk.stsConstruct).not.toHaveBeenCalled();
    expect(sdk.provider).not.toHaveBeenCalled();
  });
  it('captures and shares one frozen ENV snapshot without invoking a provider', async () => {
    const cloud = await connectOperatorAws(options, policy);
    expect(sdk.provider).not.toHaveBeenCalled(); expect(sdk.db).toHaveLength(1); expect(sdk.sts).toHaveLength(1);
    const credentials = sdk.db[0]!.input.credentials as () => Promise<Record<string, string>>;
    expect(typeof credentials).toBe('function');
    expect(credentials).toBe(sdk.sts[0]!.input.credentials);
    const snapshot = await credentials();
    expect(await credentials()).toBe(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot).toEqual({ accessKeyId: 'fictional-access', secretAccessKey: 'fictional-secret', sessionToken: 'fictional-token' });
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'rotated'); vi.stubEnv('AWS_SESSION_TOKEN', 'rotated');
    await cloud.getCallerIdentity(); await cloud.describeTable();
    expect(await credentials()).toBe(snapshot);
    expect(snapshot).toMatchObject({ accessKeyId: 'fictional-access', sessionToken: 'fictional-token' });
    expect(sdk.provider).not.toHaveBeenCalled(); cloud.close(); cloud.close();
    expect(sdk.db[0]!.destroy).toHaveBeenCalledOnce(); expect(sdk.sts[0]!.destroy).toHaveBeenCalledOnce();
  });
  it('accepts explicit long-lived ENV credentials without a session token', async () => {
    vi.stubEnv('AWS_SESSION_TOKEN', undefined);
    const cloud = await connectOperatorAws(options, policy);
    expect(await (sdk.db[0]!.input.credentials as () => Promise<unknown>)()).toEqual({ accessKeyId: 'fictional-access', secretAccessKey: 'fictional-secret' });
    cloud.close();
  });
  it.each([true, false])('ignores hostile profile, nested STS and credential files with complete ENV=%s', async complete => {
    vi.stubEnv('AWS_PROFILE', 'hostile-fictional-profile');
    vi.stubEnv('AWS_ENDPOINT_URL_STS', 'https://evil.invalid');
    vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', '/fictional/hostile-credentials');
    vi.stubEnv('AWS_CONFIG_FILE', '/fictional/hostile-config');
    if (complete) {
      const cloud = await connectOperatorAws(options, policy);
      expect(sdk.sts[0]!.input.endpoint).toBe('https://sts.us-east-1.amazonaws.com'); cloud.close();
    } else {
      vi.stubEnv('AWS_ACCESS_KEY_ID', undefined); vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
      await expect(connectOperatorAws(options, policy)).rejects.toThrow(/^operator_cloud_unavailable$/);
      expect(sdk.dbConstruct).not.toHaveBeenCalled(); expect(sdk.stsConstruct).not.toHaveBeenCalled();
    }
    expect(sdk.provider).not.toHaveBeenCalled();
  });
  it.each([
    ['us-east-1', 'aws', 'amazonaws.com'], ['eu-west-2', 'aws', 'amazonaws.com'],
    ['cn-north-1', 'aws-cn', 'amazonaws.com.cn'], ['cn-northwest-1', 'aws-cn', 'amazonaws.com.cn'],
    ['us-gov-west-1', 'aws-us-gov', 'amazonaws.com'],
  ])('pins endpoints and full selected table ARN for %s', async (region, partition, suffix) => {
    for (const key of ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_DYNAMODB', 'AWS_ENDPOINT_URL_STS']) vi.stubEnv(key, 'https://evil.invalid');
    vi.stubEnv('AWS_REGION', 'wrong'); vi.stubEnv('AWS_MAX_ATTEMPTS', '99');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const cloud = await connectOperatorAws({ ...options, region }, policy);
    await cloud.getCallerIdentity(); await cloud.describeTable();
    const transaction = new TransactWriteItemsCommand({ TransactItems: [] }); await cloud.dynamo.send(transaction);
    for (const client of [...sdk.db, ...sdk.sts]) {
      expect(client.input).toMatchObject({ region, maxAttempts: 1, useFipsEndpoint: false, useDualstackEndpoint: false });
      expect(client.input).not.toHaveProperty('logger');
    }
    expect(sdk.db.map(client => client.input.endpoint)).toEqual(Array(1).fill(`https://dynamodb.${region}.${suffix}`));
    expect(sdk.sts[0]!.input.endpoint).toBe(`https://sts.${region}.${suffix}`);
    expect(sdk.stsSend.mock.calls[0]![0]).toBeInstanceOf(GetCallerIdentityCommand);
    expect(sdk.stsSend.mock.calls[0]![0].input).toEqual({});
    expect(sdk.dbSend.mock.calls[0]![0]).toBeInstanceOf(DescribeTableCommand);
    expect(sdk.dbSend.mock.calls[0]![0].input).toEqual({ TableName: `arn:${partition}:dynamodb:${region}:${options.account}:table/${options.table}` });
    expect(sdk.dbSend.mock.calls[1]![0]).toBe(transaction);
    expect(timeout).toHaveBeenCalledOnce(); expect(timeout).toHaveBeenCalledWith(30_000);
    const signal = sdk.stsSend.mock.calls[0]![1].abortSignal; expect(signal).toBeInstanceOf(AbortSignal);
    for (const call of sdk.dbSend.mock.calls) expect(call[1].abortSignal).toBe(signal);
    cloud.close();
  });
  it.each(['us-iso-east-1', 'us-isob-east-1', 'eu-isoe-west-1', 'xx-east-1', 'us-east-1.evil.invalid', 'https://us-east-1', 'us-east-0'])('rejects unsupported region %s before constructing clients', async region => {
    await expect(connectOperatorAws({ ...options, region }, policy)).rejects.toThrow('operator_cloud_unavailable');
    expect(sdk.provider).not.toHaveBeenCalled(); expect(sdk.dbConstruct).not.toHaveBeenCalled();
  });
  it('rejects non-execution and retry overrides before constructing clients', async () => {
    await expect(connectOperatorAws({ ...options, execute: false }, policy)).rejects.toThrow('operator_cloud_unavailable');
    await expect(connectOperatorAws(options, { maxAttempts: 2 } as unknown as typeof policy)).rejects.toThrow('operator_cloud_unavailable');
    expect(sdk.provider).not.toHaveBeenCalled();
  });
  it.each(['stsConstructor', 'dbConstructor'])('cleans allocated clients and redacts %s failure', async failure => {
    if (failure === 'stsConstructor') sdk.stsConstruct.mockImplementation(() => { throw new Error(sensitive); });
    if (failure === 'dbConstructor') sdk.dbConstruct.mockImplementationOnce(() => { throw new Error(sensitive); });
    await expect(connectOperatorAws(options, policy)).rejects.toThrow(/^operator_cloud_unavailable$/);
    expect(sdk.db.every(client => client.destroy.mock.calls.length === 1)).toBe(true);
    expect(sdk.dbSend).not.toHaveBeenCalled(); expect(sdk.stsSend).not.toHaveBeenCalled();
  });
  it.each([
    [undefined, undefined, undefined], ['fictional', undefined, undefined], [undefined, 'fictional', undefined],
    ['', 'fictional', undefined], ['fictional', '', undefined], ['  ', 'fictional', undefined],
    ['fictional', '\t', undefined], ['fictional', 'fictional', ''], ['fictional', 'fictional', '  '],
  ])('rejects missing, partial or blank ENV credentials before clients (%s, %s, %s)', async (access, secret, token) => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', access); vi.stubEnv('AWS_SECRET_ACCESS_KEY', secret); vi.stubEnv('AWS_SESSION_TOKEN', token);
    await expect(connectOperatorAws(options, policy)).rejects.toThrow(/^operator_cloud_unavailable$/);
    expect(sdk.dbConstruct).not.toHaveBeenCalled(); expect(sdk.stsConstruct).not.toHaveBeenCalled();
    expect(sdk.provider).not.toHaveBeenCalled();
  });
  it.each(['sts', 'describe', 'write'])('closes clients on %s error without retry or provider leakage', async failure => {
    if (failure === 'sts') sdk.stsSend.mockRejectedValue(new Error(sensitive));
    if (failure === 'describe') sdk.dbSend.mockRejectedValue(new Error(sensitive));
    if (failure === 'write') sdk.dbSend.mockImplementation(async command => {
      if (command instanceof DescribeTableCommand) return { Table: { TableName: options.table, TableArn: arn, TableStatus: 'ACTIVE' } };
      throw new Error(sensitive);
    });
    const f = deps(), result = await runOperatorPairing([...args, '--execute'], f);
    expect(result.exitCode).toBe(1); expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(result.message).toContain(failure === 'write' ? 'uncertain' : 'No pairing issued');
    expect(sdk.stsSend).toHaveBeenCalledOnce();
    expect(sdk.dbSend).toHaveBeenCalledTimes(failure === 'sts' ? 0 : failure === 'describe' ? 1 : 2);
    expect(f.save).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
    expect(sdk.db.every(client => client.destroy.mock.calls.length === 1)).toBe(true);
    expect(sdk.sts[0]!.destroy).toHaveBeenCalledOnce();
  });
  it('continues cleanup if destroy fails and prevents subsequent sends', async () => {
    const cloud = await connectOperatorAws(options, policy);
    sdk.sts[0]!.destroy.mockImplementation(() => { throw new Error(sensitive); }); cloud.close();
    expect(sdk.db[0]!.destroy).toHaveBeenCalledOnce();
    await expect(cloud.getCallerIdentity()).rejects.toThrow(/^operator_cloud_unavailable$/);
    expect(sdk.stsSend).not.toHaveBeenCalled();
  });
  it('captures credentials only after successful output reservation', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', undefined); vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
    const f = deps();
    f.reserveOutput.mockImplementation(async () => {
      expect(sdk.dbConstruct).not.toHaveBeenCalled(); expect(sdk.stsConstruct).not.toHaveBeenCalled();
      vi.stubEnv('AWS_ACCESS_KEY_ID', 'reserved-fictional'); vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'reserved-secret');
      return { save: f.save, close: f.close };
    });
    expect((await runOperatorPairing([...args, '--execute'], f)).exitCode).toBe(0);
    expect(await (sdk.db[0]!.input.credentials as () => Promise<unknown>)()).toMatchObject({ accessKeyId: 'reserved-fictional' });
    expect(sdk.provider).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
  });
  it('redacts missing ENV failure through orchestration and closes reserved output', async () => {
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', undefined);
    const f = deps(), result = await runOperatorPairing([...args, '--execute'], f);
    expect(result.exitCode).toBe(1); expect(JSON.stringify(result)).not.toContain('fictional-access');
    expect(f.close).toHaveBeenCalledOnce(); expect(sdk.dbConstruct).not.toHaveBeenCalled();
    expect(sdk.stsConstruct).not.toHaveBeenCalled(); expect(sdk.provider).not.toHaveBeenCalled();
  });
  it('does not discover credentials after reservation failure', async () => {
    const f = deps(); f.reserveOutput.mockRejectedValue(new Error(sensitive));
    expect((await runOperatorPairing([...args, '--execute'], f)).exitCode).toBe(1);
    expect(sdk.provider).not.toHaveBeenCalled(); expect(sdk.dbConstruct).not.toHaveBeenCalled();
  });
  it.each([{ input: [] }, { input: ['--help'] }, { input: args }, { input: ['--execute', '--bad'] }])('performs no adapter IO for non-executing/invalid input $input', async ({ input }) => {
    const f = deps(); await runOperatorPairing(input, f);
    expect(f.reserveOutput).not.toHaveBeenCalled(); expect(sdk.provider).not.toHaveBeenCalled();
    expect(sdk.dbConstruct).not.toHaveBeenCalled(); expect(sdk.stsConstruct).not.toHaveBeenCalled();
  });
  it('retains runtime identity validation before issuance', async () => {
    sdk.stsSend.mockResolvedValue({ Account: '000000000000', Arn: sensitive });
    const f = deps(), result = await runOperatorPairing([...args, '--execute'], f);
    expect(result.message).toContain('Identity mismatch'); expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(sdk.dbSend).toHaveBeenCalledOnce(); expect(f.save).not.toHaveBeenCalled();
    expect(sdk.sts[0]!.destroy).toHaveBeenCalledOnce();
  });
  it('issues exactly once through WorkerAuth and closes both clients', async () => {
    const f = deps(); expect((await runOperatorPairing([...args, '--execute'], f)).exitCode).toBe(0);
    expect(sdk.provider).not.toHaveBeenCalled(); expect(sdk.dbSend).toHaveBeenCalledTimes(2);
    const command = sdk.dbSend.mock.calls[1]![0]; expect(command).toBeInstanceOf(TransactWriteItemsCommand);
    expect(command.input.TransactItems[0].Put.TableName).toBe(arn);
    expect(f.save).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
    expect(sdk.sts[0]!.destroy).toHaveBeenCalledOnce(); expect(sdk.db[0]!.destroy).toHaveBeenCalledOnce();
  });
});
