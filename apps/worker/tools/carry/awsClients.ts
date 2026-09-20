import type { SuppressionJournal, SuppressionJournalRecord } from '@fss/domain/suppression';
import { journalObjectKey, SuppressionJournalError } from '@fss/domain/suppression';
import type { DynamoQuery, DynamoQueryPage } from './dynamoPort.ts';
import type { OldItem } from './oldShapes.ts';

/**
 * The one production adapter: the only file in `apps/worker/tools/carry` that names
 * an AWS SDK (lane G11).
 *
 * Both imports are lazy, behind a `const specifier` the compiler does not resolve —
 * the pattern `packages/domain/jobs/metricsCloudWatch.ts` established for CloudWatch,
 * and for the same three reasons:
 *
 * * nothing in `npm run gate:greenfield` loads an SDK, and no test reaches a network;
 * * the worker image does not ship ten megabytes of SDK for an operator tool that
 *   never runs inside it — `Dockerfile.worker.dockerignore` excludes `tools/`
 *   entirely, and that is deliberate;
 * * the packages are therefore **not** dependencies of `@fss/worker`, and the lock
 *   file is untouched. The runbook installs them into the operator's checkout for
 *   the length of the carry and restores the lock file afterwards. See
 *   `docs/decisions/g11-dynamodb-client-seam.md`.
 *
 * Credentials come from the operator's role through the SDK's default provider
 * chain. Nothing here holds, reads, prints or logs one, and no function in this file
 * takes a key, a token or a secret as an argument.
 */

/** The narrow slice of an SDK client this tool uses: one `send`, one command. */
interface SdkClient {
  send(command: unknown): Promise<unknown>;
}

interface AttributeValue {
  readonly S?: string;
  readonly N?: string;
}

interface QueryOutput {
  readonly Items?: readonly Record<string, AttributeValue>[];
  readonly LastEvaluatedKey?: Record<string, AttributeValue>;
}

export class OldTableAdapterError extends Error {
  constructor(
    readonly code: 'sdk_unavailable' | 'item_corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'OldTableAdapterError';
  }
}

/**
 * One item as the old store wrote it: `pk`, `sk`, `workspaceId`, `rev` and `data`,
 * where `data` is a JSON string. `DynamoStore.decode` is the other side of this and
 * the two have to agree; a row that does not is a refusal, never a coerced guess.
 */
function decodeItem(item: Record<string, AttributeValue>): OldItem {
  const sk = item['sk']?.S;
  const workspaceId = item['workspaceId']?.S;
  const data = item['data']?.S;
  if (sk === undefined || data === undefined) {
    throw new OldTableAdapterError('item_corrupt', 'an old-table item has no sort key or no data');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new OldTableAdapterError('item_corrupt', 'an old-table item does not hold JSON');
  }
  return { sk, workspaceId: workspaceId ?? '', data: parsed };
}

export interface OldTableLocation {
  readonly region: string;
  /** The table name. A public identifier. */
  readonly tableName: string;
  /** The old workspace id, which is the partition key's suffix. */
  readonly workspaceId: string;
}

/**
 * A `DynamoQuery` over the real table, read-only.
 *
 * `ConsistentRead` is on: the export runs once, after the schedule is disabled, and
 * an eventually consistent read could miss the last write the old worker made before
 * it stopped — which is precisely the delta the watermark exists to bound.
 */
export async function loadDynamoQuery(location: OldTableLocation): Promise<DynamoQuery> {
  const specifier = '@aws-sdk/client-dynamodb';
  let sdk: {
    DynamoDBClient: new (configuration: { region: string }) => SdkClient;
    QueryCommand: new (input: Record<string, unknown>) => unknown;
  };
  try {
    sdk = (await import(specifier)) as typeof sdk;
  } catch {
    throw new OldTableAdapterError(
      'sdk_unavailable',
      `${specifier} is not installed; the carry runbook installs it for the length of the export`,
    );
  }
  const client = new sdk.DynamoDBClient({ region: location.region });
  return async request => {
    const output = (await client.send(
      new sdk.QueryCommand({
        TableName: location.tableName,
        ConsistentRead: true,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: {
          ':pk': { S: `WORKSPACE#${encodeURIComponent(location.workspaceId)}` },
          ':prefix': { S: request.prefix },
        },
        ...(request.exclusiveStartKey === null ? {} : { ExclusiveStartKey: request.exclusiveStartKey }),
      }),
    )) as QueryOutput;
    const page: DynamoQueryPage = {
      items: (output.Items ?? []).map(decodeItem),
      lastEvaluatedKey:
        output.LastEvaluatedKey === undefined || Object.keys(output.LastEvaluatedKey).length === 0
          ? null
          : output.LastEvaluatedKey,
    };
    return page;
  };
}

/**
 * The object-locked S3 suppression journal, for the import.
 *
 * A carried suppression is a suppression: 10.2's "written to the object-locked S3
 * journal before acknowledgement" has no exception for an import, and Appendix E
 * replays the journal after a restore — a carried opt-out missing from it would be
 * an opt-out a restore could lose. `IfNoneMatch: '*'` makes a replay idempotent and
 * a `412` a success, exactly as `apps/api/src/journal` does, because the object is
 * already durable and that is the only thing the caller needed to know.
 */
export async function loadS3SuppressionJournal(options: {
  readonly region: string;
  readonly bucket: string;
}): Promise<SuppressionJournal> {
  const specifier = '@aws-sdk/client-s3';
  let sdk: {
    S3Client: new (configuration: { region: string }) => SdkClient;
    PutObjectCommand: new (input: Record<string, unknown>) => unknown;
  };
  try {
    sdk = (await import(specifier)) as typeof sdk;
  } catch {
    throw new OldTableAdapterError(
      'sdk_unavailable',
      `${specifier} is not installed; the carry runbook installs it for the length of the import`,
    );
  }
  const client = new sdk.S3Client({ region: options.region });
  return {
    append: async (record: SuppressionJournalRecord): Promise<void> => {
      try {
        await client.send(
          new sdk.PutObjectCommand({
            Bucket: options.bucket,
            Key: journalObjectKey(record),
            ContentType: 'application/json',
            IfNoneMatch: '*',
            Body: JSON.stringify({
              schema: 'fss.suppression.v1',
              eventId: record.eventId,
              workspaceId: record.workspaceId,
              scope: record.scope,
              canonicalKey: record.canonicalKey,
              canonicalizerVersion: record.canonicalizerVersion,
              source: record.source,
              actorUserId: record.actorUserId,
              commandId: record.commandId,
              supersedesEventId: record.supersedesEventId,
              supersessionReason: record.supersessionReason,
              recordedAt: record.recordedAt,
            }),
          }),
        );
      } catch (error) {
        const name = error instanceof Error ? error.name : 'unknown';
        // A conditional put that lost the race found the object already durable.
        if (name === 'PreconditionFailed') return;
        // Redacted: the bucket and the key are operational detail and the caller
        // learns only that the journal did not accept the record.
        throw new SuppressionJournalError('JOURNAL_UNAVAILABLE', `the suppression journal did not accept the record: ${name}`);
      }
    },
  };
}
