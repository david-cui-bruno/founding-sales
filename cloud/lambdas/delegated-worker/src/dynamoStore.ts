import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type GetItemCommandOutput, type QueryCommandOutput,
  type TransactWriteItemsCommandOutput, type TransactWriteItem, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { accountFingerprint } from '../../../../src/main/domain/accounts/accountEvidence';
import { accountIdSchema, accountInstantSchema } from '../../../../src/shared/contracts/accountContract';
import { workerEventSchema, type WorkerEvent, type EventPage } from '../../../../src/shared/contracts/delegationContract';
export { accountFingerprint as fingerprint };
export type DynamoCommand = GetItemCommand | QueryCommand | TransactWriteItemsCommand;
export type DynamoResult = GetItemCommandOutput & QueryCommandOutput & TransactWriteItemsCommandOutput;
export interface DynamoAdapter { send(command: DynamoCommand): Promise<DynamoResult>; }
export type RepositoryOptions = { dynamo: DynamoAdapter; tableName: string; workspaceId: string; clock: { now(): string }; publish?: (event: WorkerEvent) => Promise<void> };
export type Stored<T> = { data: T; rev: number };
export type Scalars = Record<string, string | number | boolean>;
const scalar = (value: string | number | boolean): AttributeValue => typeof value === 'string' ? { S: value } : typeof value === 'number' ? { N: String(value) } : { BOOL: value };
export const keyPart = (value: string): string => encodeURIComponent(accountIdSchema.parse(value));
export const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const outboxSchema = z.strictObject({ sequence: integer.positive(), published: z.boolean(), event: workerEventSchema });
export class DynamoStore {
  constructor(readonly options: RepositoryOptions) {
    accountIdSchema.parse(options.workspaceId); z.string().min(1).parse(options.tableName);
  }
  now(): string { return accountInstantSchema.parse(this.options.clock.now()); }
  workspace(value: string): void { if (value !== this.options.workspaceId) throw new Error('workspace_mismatch'); }
  key(sk: string) { return { pk: { S: `WORKSPACE#${keyPart(this.options.workspaceId)}` }, sk: { S: sk } }; }
  async get<T>(sk: string): Promise<Stored<T> | null> {
    const result = await this.options.dynamo.send(new GetItemCommand({ TableName: this.options.tableName, Key: this.key(sk), ConsistentRead: true }));
    if (!result.Item) return null;
    return this.decode<T>(result.Item);
  }
  private decode<T>(item: Record<string, AttributeValue>): Stored<T> {
    const rev = integer.positive().parse(Number(item.rev?.N));
    if (typeof item.data?.S !== 'string') throw new Error('corrupt_record');
    return { data: JSON.parse(item.data.S) as T, rev };
  }
  async list<T>(prefix: string): Promise<{ key: string; stored: Stored<T> }[]> {
    const rows: { key: string; stored: Stored<T> }[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const result = await this.options.dynamo.send(new QueryCommand({ TableName: this.options.tableName, ConsistentRead: true,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': this.key('').pk, ':prefix': { S: prefix } }, ExclusiveStartKey: start }));
      for (const item of result.Items ?? []) {
        if (!item.sk?.S) throw new Error('corrupt_record');
        rows.push({ key: item.sk.S, stored: this.decode<T>(item) });
      }
      start = result.LastEvaluatedKey;
    } while (start && Object.keys(start).length);
    return rows;
  }
  put(sk: string, data: unknown, expected: number | null, fields: Scalars = {}, fence: Scalars = {}): TransactWriteItem {
    const names: Record<string, string> = expected === null ? { '#pk': 'pk' } : { '#rev': 'rev', '#workspace': 'workspaceId' };
    const values: Record<string, AttributeValue> = expected === null ? {} : { ':rev': { N: String(expected) }, ':workspace': { S: this.options.workspaceId } };
    let condition = expected === null ? 'attribute_not_exists(#pk)' : '#rev = :rev AND #workspace = :workspace';
    Object.entries(fence).forEach(([name, value], i) => { names[`#f${i}`] = name; values[`:f${i}`] = scalar(value); condition += ` AND #f${i} = :f${i}`; });
    const item = { ...this.key(sk), workspaceId: { S: this.options.workspaceId }, rev: { N: String((expected ?? 0) + 1) },
      data: { S: JSON.stringify(data) }, ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, scalar(v)])) };
    // DynamoDB's 400 KiB item limit is a hard refusal, never silent evidence truncation.
    if (Buffer.byteLength(JSON.stringify(item)) > 390000) throw new Error('record_capacity_exceeded');
    return { Put: { TableName: this.options.tableName, Item: item, ConditionExpression: condition, ExpressionAttributeNames: names,
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}) } };
  }
  absent(sk: string): TransactWriteItem {
    return { ConditionCheck: { TableName: this.options.tableName, Key: this.key(sk), ConditionExpression: 'attribute_not_exists(#pk)', ExpressionAttributeNames: { '#pk': 'pk' } } };
  }
  check(sk: string, expected: number, fence: Scalars = {}): TransactWriteItem {
    const put = this.put(sk, {}, expected, {}, fence).Put!;
    return { ConditionCheck: { TableName: put.TableName, Key: this.key(sk), ConditionExpression: put.ConditionExpression,
      ExpressionAttributeNames: put.ExpressionAttributeNames, ExpressionAttributeValues: put.ExpressionAttributeValues } };
  }
  async transact(items: TransactWriteItem[]): Promise<void> {
    if (items.length < 1 || items.length > 100) throw new Error('transaction_capacity_exceeded');
    await this.options.dynamo.send(new TransactWriteItemsCommand({ TransactItems: items }));
  }
  async eventItems(event: WorkerEvent): Promise<{ sequence: number; items: TransactWriteItem[] }> {
    workerEventSchema.parse(event); this.workspace(event.workspaceId);
    const head = await this.get<{ sequence: number }>('EVENT_HEAD');
    const sequence = integer.parse(head ? head.data.sequence : 0) + 1;
    integer.parse(sequence);
    return { sequence, items: [this.put('EVENT_HEAD', { sequence }, head?.rev ?? null),
      this.put(this.eventKey(sequence), { sequence, event, published: !this.options.publish }, null)] };
  }
  eventKey(sequence: number): string { return `EVENT#${String(sequence).padStart(16, '0')}`; }
  /** Idempotent publication only. Never invokes a domain mutation or provider action. */
  async publish(sequence: number): Promise<void> {
    if (!this.options.publish) return;
    const record = await this.get<unknown>(this.eventKey(sequence));
    if (!record) throw new Error('event_missing');
    const outbox = outboxSchema.parse(record.data);
    if (outbox.published) return;
    await this.options.publish(outbox.event);
    await this.transact([this.put(this.eventKey(sequence), { ...outbox, published: true }, record.rev)]);
  }
  async retryPublications(): Promise<void> {
    const head = await this.get<{ sequence: number }>('EVENT_HEAD');
    const high = integer.parse(head ? head.data.sequence : 0);
    for (let sequence = 1; sequence <= high; sequence++) await this.publish(sequence);
  }
  async eventsAfter(cursor: string | null): Promise<EventPage> {
    let after = 0;
    if (cursor !== null) {
      const parts = /^([a-f0-9]{64}):(\d+)$/.exec(cursor);
      if (!parts || parts[1] !== accountFingerprint(this.options.workspaceId)) throw new Error('invalid_cursor');
      after = integer.parse(Number(parts[2]));
    }
    const head = await this.get<{ sequence: number }>('EVENT_HEAD');
    const high = integer.parse(head ? head.data.sequence : 0);
    if (after > high) throw new Error('invalid_cursor');
    const events: WorkerEvent[] = [];
    for (let seq = after + 1; seq <= high && events.length < 1000; seq++) {
      const record = await this.get<{ published: boolean }>(this.eventKey(seq));
      // A missing or unpublished lower event must never be skipped by a cursor.
      if (!record || record.data.published !== true) break;
      const outbox = outboxSchema.parse(record.data);
      if (outbox.sequence !== seq) throw new Error('event_gap');
      events.push(outbox.event); after = seq;
    }
    return { events, nextCursor: after === 0 ? null : `${accountFingerprint(this.options.workspaceId)}:${after}` };
  }
}
