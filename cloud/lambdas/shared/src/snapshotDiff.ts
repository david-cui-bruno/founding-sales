/**
 * Generic snapshot diffing for batch adapters over the
 * callie-sourcing-snapshots table (pk `source_natural_key`, sk `snapshot_date`).
 *
 * Contract: read the latest snapshot for the key (Query, ScanIndexForward
 * false, Limit 1), compare content fingerprints, ALWAYS write today's row so
 * the next run diffs against the freshest state.
 *
 *   'new'       — no prior snapshot for this natural key
 *   'changed'   — prior snapshot exists with a different fingerprint
 *   'unchanged' — prior snapshot has the same fingerprint
 */
import { PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export type SnapshotDiffResult = "new" | "changed" | "unchanged";

export interface DiffSnapshotInput {
  dynamo: Pick<DynamoDBClient, "send">;
  table: string;
  /** e.g. "pvd-taxroll:12345" */
  naturalKey: string;
  /** sha256 hex of the normalized row content */
  contentFingerprint: string;
  /** ISO calendar date (YYYY-MM-DD) of this run's snapshot */
  snapshotDate: string;
}

export async function diffSnapshot(input: DiffSnapshotInput): Promise<SnapshotDiffResult> {
  const { dynamo, table, naturalKey, contentFingerprint, snapshotDate } = input;

  const latest = await dynamo.send(
    new QueryCommand({
      TableName: table,
      KeyConditionExpression: "source_natural_key = :pk",
      ExpressionAttributeValues: { ":pk": { S: naturalKey } },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );

  const prior = latest.Items?.[0];
  const priorFingerprint = prior?.content_fingerprint?.S ?? null;

  let result: SnapshotDiffResult;
  if (priorFingerprint === null) {
    result = "new";
  } else if (priorFingerprint === contentFingerprint) {
    result = "unchanged";
  } else {
    result = "changed";
  }

  // Always write today's row (idempotent overwrite for reruns on the same day).
  await dynamo.send(
    new PutItemCommand({
      TableName: table,
      Item: {
        source_natural_key: { S: naturalKey },
        snapshot_date: { S: snapshotDate },
        content_fingerprint: { S: contentFingerprint },
      },
    }),
  );

  return result;
}
