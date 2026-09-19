import { TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import type { DynamoAdapter } from '../../src/dynamoStore';
import { createWorkerHandler, type WorkerHttpResponse } from '../../src/handler';
import { V1Devices } from '../../src/v1/devices';
import { WorkerAuth } from '../../src/workerAuth';
import { ConditionalCommandHarness } from '../sdkHarness';

/**
 * The real worker handler on the in-memory Dynamo harness, for the `/v1` scenario tests. Only the SDK boundary
 * is synthetic; the handler, auth store, router, device store and attempt log are the production modules.
 * `onTransaction` lets a test act as a concurrent client: the hook runs right before a transaction commits,
 * which is where a revocation issued from another device would land while a request is in flight.
 */
export const V1_HOST = 'worker.example.test';
export const V1_START = '2026-09-18T12:00:00.000Z';

export type V1Request = { body?: unknown; authorization?: string; query?: string };
export type TransactionHook = (items: TransactWriteItem[]) => Promise<void>;

export function v1Fixture(start = V1_START) {
  const db = new ConditionalCommandHarness(); let now = start;
  let beforeTransaction: TransactionHook | null = null;
  const dynamo: DynamoAdapter = { send: async command => {
    if (command instanceof TransactWriteItemsCommand && beforeTransaction) await beforeTransaction(command.input.TransactItems ?? []);
    return db.send(command);
  } };
  const options = { dynamo, tableName: 'fictional-table', workspaceId: 'ws', clock: { now: () => now } };
  const auth = new WorkerAuth(options);
  const handle = createWorkerHandler({ auth, host: V1_HOST });
  const devices = new V1Devices(auth.store);
  const request = (method: 'GET' | 'POST', path: string, input: V1Request = {}): Promise<WorkerHttpResponse> => handle({
    version: '2.0', rawPath: path, rawQueryString: input.query ?? '',
    headers: { host: V1_HOST, 'x-forwarded-proto': 'https', ...(input.authorization === undefined ? {} : { authorization: input.authorization }) },
    ...(input.body === undefined ? {} : { body: typeof input.body === 'string' ? input.body : JSON.stringify(input.body) }),
    isBase64Encoded: false, requestContext: { domainName: V1_HOST, http: { method, sourceIp: 'fictional-device' } } });
  const json = (response: WorkerHttpResponse): unknown => JSON.parse(response.body);
  /** Mint and redeem one device the way the operator tool and a fresh client would, returning its bearer header. */
  const pairDevice = async (label = 'David MacBook') => {
    const minted = await devices.mintPairCode({ label, expiresInSeconds: 600 });
    const response = await request('POST', '/v1/pair/redeem', { body: { code: minted.code } });
    if (response.statusCode !== 200) throw new Error(`pairing failed in fixture: ${response.statusCode}`);
    const redeemed = json(response) as { deviceToken: string; deviceId: string };
    return { ...redeemed, bearer: `Bearer ${redeemed.deviceToken}` };
  };
  return { db, auth, store: auth.store, devices, handle, request, json, pairDevice, advance: (value: string) => { now = value; }, now: () => now,
    onTransaction: (hook: TransactionHook | null) => { beforeTransaction = hook; } };
}
