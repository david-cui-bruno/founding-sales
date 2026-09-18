import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type AttributeValue, type GetItemCommandInput, type TransactWriteItemsCommandInput } from '@aws-sdk/client-dynamodb';
import type { DynamoAdapter, DynamoCommand, DynamoResult } from '../src/dynamoStore';
export const transaction = { $metadata: {} };
export function row(data: unknown, rev = 1): DynamoResult { return { Item: { pk: { S: 'ws' }, sk: { S: 'fixture' }, rev: { N: String(rev) }, data: { S: JSON.stringify(data) } }, $metadata: {} }; }
/** Scripted SDK boundary, not a DynamoDB emulator. Assertions inspect real requests.
 * No claim is made that this proves server-side transaction/race semantics. */
export class ScriptedDynamo implements DynamoAdapter {
  commands: DynamoCommand[] = [];
  transactions: TransactWriteItemsCommandInput[] = [];
  reads: GetItemCommandInput[] = [];
  constructor(private readonly responses: (Partial<DynamoResult> | Error | (() => Partial<DynamoResult>))[]) {}
  async send(command: DynamoCommand): Promise<DynamoResult> {
    this.commands.push(command);
    if (command instanceof GetItemCommand) this.reads.push(command.input);
    else if (command instanceof TransactWriteItemsCommand) this.transactions.push(command.input);
    else if (!(command instanceof QueryCommand)) throw new Error('unconfigured SDK command');
    const response = this.responses.shift();
    if (!response) throw new Error(`unconfigured SDK response: ${command.constructor.name}`);
    if (response instanceof Error) throw response;
    return { $metadata: {}, ...(typeof response === 'function' ? response() : response) };
  }
}

type Item = Record<string, AttributeValue>;
/** Offline interpreter for the exact conditional request subset this package emits.
 * Unlike success stubs it checks all conditions against the pre-transaction image,
 * rejects duplicate item targets/unused aliases and applies all-or-none. This is
 * still synthetic coverage, NOT live DynamoDB two-client acceptance. */
export class ConditionalCommandHarness implements DynamoAdapter {
  private readonly items: Record<string, Item> = {};
  transactions: TransactWriteItemsCommandInput[] = [];
  afterCommit?: () => void;
  beforeTransaction?: () => void;
  private identity(item: Item): string { return `${item.pk?.S}|${item.sk?.S}`; }
  /** Every stored item, for assertions that nothing of a kind was written anywhere in the store. */
  dump(): Item[] { return structuredClone(Object.values(this.items)); }
  inspect(sk: string): unknown {
    const item = Object.values(this.items).find(row => row.sk?.S === sk);
    return item?.data?.S ? JSON.parse(item.data.S) : undefined;
  }
  async send(command: DynamoCommand): Promise<DynamoResult> {
    if (command instanceof GetItemCommand) {
      if (command.input.ConsistentRead !== true) throw new Error('read_not_strong');
      const item = this.items[this.identity(command.input.Key!)];
      return { $metadata: {}, ...(item ? { Item: structuredClone(item) } : {}) };
    }
    if (command instanceof QueryCommand) {
      if (command.input.ConsistentRead !== true) throw new Error('read_not_strong');
      const values = command.input.ExpressionAttributeValues!;
      const condition = command.input.KeyConditionExpression ?? '';
      // Only the two key conditions this package emits: a prefix scan and an ascending sort-key range.
      const selects = (sk: string): boolean => condition.includes('begins_with(#sk, :prefix)') ? sk.startsWith(values[':prefix']?.S ?? '')
        : condition.includes('#sk BETWEEN :from AND :to') ? sk >= (values[':from']?.S ?? '') && sk <= (values[':to']?.S ?? '')
          : (() => { throw new Error(`unsupported_key_condition:${condition}`); })();
      // Limit and ExclusiveStartKey stay uninterpreted: callers that page wrap this harness and
      // slice the full ascending result themselves. Every caller must cap its own page.
      const items = Object.values(this.items).filter(item => item.pk?.S === values[':pk']?.S && selects(item.sk?.S ?? ''))
        .sort((a, b) => a.sk!.S! < b.sk!.S! ? -1 : a.sk!.S! > b.sk!.S! ? 1 : 0);
      return { $metadata: {}, Items: structuredClone(items) };
    }
    this.beforeTransaction?.();
    const transaction = command.input;
    this.transactions.push(transaction);
    const identities = new Set<string>();
    for (const write of transaction.TransactItems ?? []) {
      const op = write.Put ?? write.ConditionCheck;
      if (!op) throw new Error('unsupported_write');
      const target = write.Put?.Item ?? write.ConditionCheck?.Key;
      const identity = this.identity(target!);
      if (identities.has(identity)) throw new Error('duplicate_transaction_target');
      identities.add(identity);
      const existing = this.items[identity];
      const expression = op.ConditionExpression!;
      const names = op.ExpressionAttributeNames ?? {};
      const values = op.ExpressionAttributeValues ?? {};
      for (const alias of [...Object.keys(names), ...Object.keys(values)]) if (!expression.includes(alias)) throw new Error(`unused_alias:${alias}`);
      for (const term of expression.split(' AND ')) {
        const absent = /^attribute_not_exists\((#\w+)\)$/.exec(term);
        if (absent) {
          if (existing?.[names[absent[1]!]!]) throw new Error('TransactionCanceledException');
          continue;
        }
        const equal = /^(#\w+) = (:\w+)$/.exec(term);
        if (!equal) throw new Error(`unsupported_expression:${term}`);
        if (JSON.stringify(existing?.[names[equal[1]!]!]) !== JSON.stringify(values[equal[2]!])) throw new Error('TransactionCanceledException');
      }
    }
    for (const write of transaction.TransactItems ?? []) if (write.Put?.Item) this.items[this.identity(write.Put.Item)] = structuredClone(write.Put.Item);
    this.afterCommit?.();
    return { $metadata: {} };
  }
}
