import { type SuppressionJournalRecord } from '@fss/domain/suppression/journal.ts';
import { parseSuppressionJournalRecord, type SuppressionJournalSource } from '@fss/domain/suppression/replay.ts';

/**
 * The object-locked S3 suppression journal, read (Appendix E step 2).
 *
 * The append side of this bucket has two implementations already —
 * `apps/api/src/journal` and `apps/worker/src/bootstrap/deployment.ts` — and neither
 * reads. A replay has to, so this is the read side, with the same three properties the
 * append side has:
 *
 * * the SDK is imported lazily behind a `const specifier` the compiler does not
 *   resolve, so nothing in `npm run gate:greenfield` loads it and no test reaches a
 *   network;
 * * nothing here holds, prints or logs a credential; the role the task runs as is what
 *   grants the read;
 * * a refusal names what was unavailable and never the bucket's contents.
 *
 * **The window is `LastModified`, not the record's own instant.** The drill replays
 * "from the restore point minus one hour", and what it means is every object the
 * bucket accepted in that window — an object whose `recordedAt` is older because the
 * command that wrote it began earlier is exactly the object a replay must not miss.
 * The record's instant is what the row is written with; the bucket's is what decides
 * whether it is read.
 */

export class JournalSourceError extends Error {
  constructor(
    readonly code: 'sdk_unavailable' | 'unreadable' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'JournalSourceError';
  }
}

interface S3ObjectSummary {
  readonly Key?: string;
  readonly LastModified?: Date;
}

interface ListOutput {
  readonly Contents?: readonly S3ObjectSummary[];
  readonly NextContinuationToken?: string;
  readonly IsTruncated?: boolean;
}

interface GetOutput {
  readonly Body?: { transformToString(): Promise<string> };
}

interface SdkClient {
  send(command: unknown): Promise<unknown>;
}

/** Everything under this prefix is a suppression event object (`journalObjectKey`). */
export const JOURNAL_PREFIX = 'suppressions/';

export async function loadS3JournalSource(options: {
  readonly bucket: string;
  readonly region: string;
}): Promise<SuppressionJournalSource> {
  const specifier = '@aws-sdk/client-s3';
  let sdk: {
    S3Client: new (configuration: { region: string }) => SdkClient;
    ListObjectsV2Command: new (input: Record<string, unknown>) => unknown;
    GetObjectCommand: new (input: Record<string, unknown>) => unknown;
  };
  try {
    sdk = (await import(specifier)) as typeof sdk;
  } catch {
    throw new JournalSourceError(
      'sdk_unavailable',
      `${specifier} is not installed in this image; the journal cannot be replayed from it`,
    );
  }
  const client = new sdk.S3Client({ region: options.region });

  return {
    read: async (from: string, to?: string | undefined): Promise<readonly SuppressionJournalRecord[]> => {
      const fromAt = Date.parse(from);
      const toAt = to === undefined ? Number.POSITIVE_INFINITY : Date.parse(to);
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const page = (await client.send(
          new sdk.ListObjectsV2Command({
            Bucket: options.bucket,
            Prefix: JOURNAL_PREFIX,
            ...(token === undefined ? {} : { ContinuationToken: token }),
          }),
        )) as ListOutput;
        for (const object of page.Contents ?? []) {
          const at = object.LastModified?.getTime();
          const key = object.Key;
          if (key === undefined || at === undefined) continue;
          if (at < fromAt || at > toAt) continue;
          keys.push(key);
        }
        token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (token !== undefined);

      const records: SuppressionJournalRecord[] = [];
      for (const key of keys) {
        const object = (await client.send(
          new sdk.GetObjectCommand({ Bucket: options.bucket, Key: key }),
        )) as GetOutput;
        const body = await object.Body?.transformToString();
        if (body === undefined) {
          throw new JournalSourceError('unreadable', 'a journal object had no body');
        }
        const parsed = parseSuppressionJournalRecord(body);
        if (!parsed.ok) {
          // A corrupt object is a refusal rather than a skip: the whole point of the
          // replay is that nothing in the window is lost, and "we could not read one of
          // them" is not a successful replay.
          throw new JournalSourceError('corrupt', `a journal object is not a suppression record: ${parsed.reason}`);
        }
        records.push(parsed.value);
      }
      return records;
    },
  };
}
