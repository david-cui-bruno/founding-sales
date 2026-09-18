import { GetItemCommand, QueryCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { createProductionHandler, createWorkerHandler } from '../src/handler';
import { DynamoReadUnavailable, DynamoStore, withDynamoReadErrors, type DynamoAdapter, type DynamoCommand } from '../src/dynamoStore';
import { WorkerAuth } from '../src/workerAuth';
import { row } from './sdkHarness';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
/** GET /events with a two-event stream: initial token/pairing, a re-auth pair plus the head read,
 * then a re-auth pair plus exactly one range query. Not one read per event any more. */
const EVENTS_READS = 8;

const pairingId = '00000000-0000-4000-8000-000000000001';
const credential = 'a'.repeat(43);
const token = { pairingId, generation: 0, kind: 'device', scopes: ['events:read'] };
const pairing = { pairingId, generation: 0, revoked: false };
const secretText = 'sensitive SDK URL https://private.invalid/?token=private-token table=private-table';
const options = { workspaceId: 'fictional-workspace', tableName: 'fictional-table', clock: { now: () => '2026-09-13T00:00:00.000Z' } };
const request = () => ({ version: '2.0', rawPath: '/events', rawQueryString: '',
  headers: { host: 'worker.example.test', 'x-forwarded-proto': 'https', authorization: `Bearer ${credential}` },
  requestContext: { domainName: 'worker.example.test', http: { method: 'GET', sourceIp: 'fixture' } } });
const event = (sequence: number) => ({ sequence, published: true, event: { id: `event-${sequence}`, workspaceId: options.workspaceId,
  accountId: 'fictional-account', authorityGeneration: 0, aggregateVersion: sequence, kind: 'research.created',
  payload: { account: { id: 'fictional-account', name: 'Fictional PM', domain: null, version: 1 }, createdAt: options.clock.now() } } });
const eventKey = (sequence: number) => `EVENT#${String(sequence).padStart(16, '0')}`;
function sdkFixture(override?: (key: string, call: number) => ReturnType<typeof row> | undefined) {
  const commands: DynamoCommand[] = [];
  const dynamo: DynamoAdapter = { send: async command => {
    commands.push(command);
    // The event stream is read as one consistent ascending range query; everything else is a point read.
    if (command instanceof QueryCommand) {
      expect(command.input.ConsistentRead).toBe(true);
      const bounds = command.input.ExpressionAttributeValues!;
      const from = Number(bounds[':from']!.S!.slice('EVENT#'.length)), to = Number(bounds[':to']!.S!.slice('EVENT#'.length));
      const items: Record<string, AttributeValue>[] = [];
      for (let sequence = from; sequence <= to; sequence++) {
        const key = eventKey(sequence);
        const item = (override?.(key, commands.length) ?? row(event(sequence))).Item;
        // An absent row simply does not come back from a range read; it is never a blank placeholder.
        if (item) items.push({ ...item, sk: { S: key } });
      }
      return { $metadata: {}, Items: items };
    }
    expect(command).toBeInstanceOf(GetItemCommand);
    const read = command as GetItemCommand;
    expect(read.input.ConsistentRead).toBe(true);
    const key = read.input.Key!.sk!.S!;
    const replacement = override?.(key, commands.length);
    if (replacement) return replacement;
    if (key.startsWith('TOKEN#')) return row(token);
    if (key.startsWith('PAIRING#')) return row(pairing);
    if (key === 'EVENT_HEAD') return row({ sequence: 2 });
    return row(event(Number(key.slice('EVENT#'.length))));
  } };
  return { dynamo, commands };
}
function http(dynamo: DynamoAdapter, production = false) {
  return production ? createProductionHandler({ DELEGATED_WORKER_ENABLED: 'true', DELEGATED_WORKER_TABLE: options.tableName,
    DELEGATED_WORKSPACE_ID: options.workspaceId, DELEGATED_WORKER_HOST: request().headers.host, AWS_REGION: 'us-east-1' }, { dynamo })
    : createWorkerHandler({ auth: new WorkerAuth({ ...options, dynamo }), host: request().headers.host });
}

describe('raw Dynamo read dependency classification', () => {
  it.each([new GetItemCommand({ TableName: options.tableName, Key: {} }), new QueryCommand({ TableName: options.tableName })])(
    'tags read rejection without retaining SDK details', async command => {
      const adapter = withDynamoReadErrors({ send: async () => { throw new Error(secretText); } });
      const error = await adapter.send(command).catch(error => error);
      expect(error).toBeInstanceOf(DynamoReadUnavailable);
      expect(error.message).toBe('worker_unavailable');
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain(secretText);
    });
  it('does not inspect rejection strings and preserves write/CAS error identity', async () => {
    const original = new Error('worker_unauthorized');
    const adapter = withDynamoReadErrors({ send: async () => { throw original; } });
    await expect(adapter.send(new GetItemCommand({ TableName: options.tableName, Key: {} }))).rejects.toBeInstanceOf(DynamoReadUnavailable);
    await expect(adapter.send(new TransactWriteItemsCommand({ TransactItems: [] }))).rejects.toBe(original);
  });
  it('propagates typed failures through store reads and authentication', async () => {
    const sdk: DynamoAdapter = { send: async () => { throw secretText; } };
    const dynamo = withDynamoReadErrors(sdk);
    const store = new DynamoStore({ ...options, dynamo });
    await expect(store.get('EVENT_HEAD')).rejects.toBeInstanceOf(DynamoReadUnavailable);
    await expect(store.list('EVENT#')).rejects.toBeInstanceOf(DynamoReadUnavailable);
    await expect(new WorkerAuth({ ...options, dynamo: sdk }).authenticate(`Bearer ${credential}`, ['events:read'])).rejects.toBeInstanceOf(DynamoReadUnavailable);
  });
  it('preserves a successful SDK not-found response rather than inventing an outage', async () => {
    const missing = { $metadata: {} };
    const dynamo = withDynamoReadErrors({ send: async () => missing });
    expect(await dynamo.send(new GetItemCommand({ TableName: options.tableName, Key: {} }))).toBe(missing);
    await expect(new DynamoStore({ ...options, dynamo }).get('EVENT_HEAD')).resolves.toBeNull();
  });
});

describe.each([false, true])('actual GET /events dependency failure (production=%s)', production => {
  // Initial token/pairing, then fresh token/pairing before the head read and before the one range query.
  it.each(Array.from({ length: EVENTS_READS }, (_, i) => i + 1))('returns redacted 503 when read %i fails, never a partial page', async failureAt => {
    const f = sdkFixture((_key, call) => { if (call === failureAt) throw new Error(secretText); return undefined; });
    const result = await http(f.dynamo, production)(request());
    expect(result.statusCode).toBe(503);
    expect(JSON.parse(result.body)).toEqual({ error: 'worker_unavailable' });
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(result.body).not.toContain(credential);
    expect(result.body).not.toContain(secretText);
    expect(f.commands).toHaveLength(failureAt);
  });
  it('returns the unchanged event page on healthy reads', async () => {
    const f = sdkFixture();
    const result = await http(f.dynamo, production)(request());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ events: [event(1).event, event(2).event], complete: true });
    expect(f.commands).toHaveLength(EVENTS_READS);
    expect(f.commands.filter(command => command instanceof QueryCommand)).toHaveLength(1);
  });
});

describe('authentication, validation and incomplete reads remain fail closed', () => {
  it.each(['', 'Bearer invalid', 'Basic private-token'])('rejects malformed credentials before SDK access: %s', async authorization => {
    const f = sdkFixture(() => { throw new Error(secretText); });
    const input = request(); input.headers.authorization = authorization;
    const result = await http(f.dynamo)(input);
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: 'worker_unauthorized' });
    expect(f.commands).toHaveLength(0);
  });
  it.each([1, 2])('denies missing credential/pairing read %i', async missingAt => {
    const f = sdkFixture((_key, call) => call === missingAt ? { $metadata: {} } : undefined);
    expect((await http(f.dynamo)(request())).statusCode).toBe(401);
    expect(f.commands).toHaveLength(missingAt);
  });
  it.each([row({ ...token, scopes: [] }), row({ ...token, generation: 1 }), row({ private: secretText })])('denies incomplete or mismatched token data', async tokenRow => {
    const f = sdkFixture(key => key.startsWith('TOKEN#') ? tokenRow : undefined);
    const result = await http(f.dynamo)(request());
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: 'worker_unauthorized' });
  });
  it('preserves scope denial and does not read the stream', async () => {
    const f = sdkFixture(key => key.startsWith('TOKEN#') ? row({ ...token, scopes: ['commands:write'] }) : undefined);
    const result = await http(f.dynamo)(request());
    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: 'worker_scope_denied' });
    expect(f.commands).toHaveLength(2);
  });
  it('preserves fresh revocation denial between initial auth and stream access', async () => {
    const f = sdkFixture((key, call) => key.startsWith('PAIRING#') && call === 4 ? row({ ...pairing, revoked: true }) : undefined);
    const result = await http(f.dynamo)(request());
    expect(result.statusCode).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: 'worker_unauthorized' });
    expect(f.commands).toHaveLength(4);
  });
  it.each(['cursor=invalid-private-cursor', `cursor=${'b'.repeat(64)}:1`, 'token=private-token', 'cursor=one&cursor=two'])('keeps invalid query as 400: %s', async rawQueryString => {
    const f = sdkFixture(); const input = request(); input.rawQueryString = rawQueryString;
    const result = await http(f.dynamo)(input);
    expect(result.statusCode).toBe(400);
    expect(result.body).not.toContain(rawQueryString);
    expect(f.commands.length).toBeLessThanOrEqual(2);
  });
  it.each(['missing', 'unpublished'])('does not advance past a %s lower event', async state => {
    const f = sdkFixture(key => key === 'EVENT#0000000000000001' ? state === 'missing'
      ? { $metadata: {} } : row({ ...event(1), published: false }) : undefined);
    const result = await http(f.dynamo)(request());
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ events: [], nextCursor: null, complete: false });
    expect(f.commands).toHaveLength(EVENTS_READS);
  });
  it('rejects corrupt stored envelopes without exposing their data', async () => {
    const f = sdkFixture(key => key === 'EVENT_HEAD' ? { $metadata: {}, Item: { rev: { N: '1' }, data: { S: secretText } } } : undefined);
    const result = await http(f.dynamo)(request());
    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'worker_request_rejected' });
  });
});
