import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DynamoStore, withDynamoReadErrors } from '../../../src/dynamoStore';
import { claimJob, dayBuildJobId, jobKey, jobRecordSchema } from '../../../src/queue/jobs';
import { flightKey, flightRecordSchema, sendKey, sendRecordSchema } from '../../../src/v1/send';

/**
 * The two fences that rest on real condition semantics, against DynamoDB Local (FSS target design section 7 and
 * reviewer 3's finding: the in-memory harness is not DynamoDB, and its author says so). This file is skipped unless
 * `DYNAMODB_LOCAL_ENDPOINT` names a running instance, which is the pre-cutover job, not the fast gate:
 *
 *   DYNAMODB_LOCAL_ENDPOINT=http://127.0.0.1:8000 npx vitest run test/scenarios/dynamoLocal
 *
 * Two concurrent writers race for one `SEND#` claim and one `JOB#` lease. Exactly one may win each. Nothing here
 * reaches a mailbox, a provider or an AWS account: the endpoint is local and the credentials are fictional.
 */

const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT;
const TABLE = `callie-fence-${randomUUID().slice(0, 8)}`;

describe.skipIf(!endpoint)('DynamoDB Local: the send claim and the job lease under two concurrent writers', () => {
  let client: DynamoDBClient;
  let store: DynamoStore;

  beforeAll(async () => {
    client = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'fictional', secretAccessKey: 'fictional' } });
    await client.send(new CreateTableCommand({ TableName: TABLE, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] }));
    await client.send(new DescribeTableCommand({ TableName: TABLE }));
    store = new DynamoStore({ dynamo: withDynamoReadErrors(client), tableName: TABLE, workspaceId: 'ws-fence',
      clock: { now: () => new Date().toISOString() } });
  }, 30000);

  afterAll(async () => {
    if (!endpoint) return;
    await client.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => undefined);
    client.destroy();
  });

  it('lets exactly one of two writers claim the same SEND# and the same FLIGHT#', async () => {
    const firmId = `account-${randomUUID()}`;
    const stepId = 'step-0';
    const now = store.now();
    const claim = (jobId: string) => store.transact([
      store.put(sendKey(firmId, stepId), sendRecordSchema.parse({ version: 1, firmId, stepId, state: 'dispatching', contextRevision: 1,
        jobId, messageId: `<${jobId}@callie.invalid>`, providerMessageId: null, providerThreadId: null,
        frozen: { from: 'founder@usecallie.invalid', to: 'contact@firm.invalid', subject: 'Hello', body: 'Body' },
        templateId: 'T4', claimedAt: now, sentAt: null, reconciledAt: null, noRetry: false, reason: null }), null),
      store.put(flightKey(firmId), flightRecordSchema.parse({ version: 1, firmId, jobId, since: now }), null)]);
    const results = await Promise.allSettled([claim('job-a'), claim('job-b')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const stored = await store.get<unknown>(sendKey(firmId, stepId));
    const record = sendRecordSchema.parse(stored!.data);
    expect(['job-a', 'job-b']).toContain(record.jobId);
    expect(stored!.rev).toBe(1);
  }, 30000);

  it('lets exactly one of two runners take the lease on the same JOB#', async () => {
    const jobId = dayBuildJobId(new Date().toISOString().slice(0, 10));
    const results = await Promise.all([claimJob(store, { jobId, kind: 'day.build' }), claimJob(store, { jobId, kind: 'day.build' })]);
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    const stored = await store.get<unknown>(jobKey(jobId));
    expect(jobRecordSchema.parse(stored!.data)).toMatchObject({ state: 'running', attempt: 1 });

    // A second claim while the lease is live is refused; nothing about the record changes.
    const again = await claimJob(store, { jobId, kind: 'day.build' });
    expect(again).toEqual({ claimed: false, reason: 'in_flight' });
    expect((await store.get<unknown>(jobKey(jobId)))!.rev).toBe(stored!.rev);
  }, 30000);
});
