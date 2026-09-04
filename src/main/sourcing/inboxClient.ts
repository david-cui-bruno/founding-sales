/**
 * Sourcing inbox client — the pure S3 polling layer (plan Task 1).
 *
 * Lists `events/` objects after a lexicographic cursor (keys embed the date
 * plus a ULID, so key order is emission order) and fetches ndjson batches,
 * validating every line against the local CloudSourceEvent mirror. Invalid
 * lines are quarantined with a reason, never fatal: one bad adapter line must
 * not block the founder's inbox.
 *
 * Main-process only. The S3 client is injected behind `InboxObjectStore` so
 * tests use an in-memory fake, and credentials come from an injected async
 * provider. The real Keychain-backed provider ships with Task 3; until then
 * `createFileInboxCredentialProvider` reads the one-time import file written
 * by `aws iam create-access-key`.
 */
import { readFile } from 'node:fs/promises';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

import {
  validateCloudSourceEvent,
  type CloudSourceEvent,
} from '../../shared/contracts/cloudSourceEventContract';
import type { Clock } from '../domain/support/clock';
import { runWithAbortDeadline } from '../runtime/abortDeadline';

export const INBOX_BUCKET = 'callie-sourcing-inbox-326255650484';
export const INBOX_EVENTS_PREFIX = 'events/';
export const INBOX_AWS_REGION = 'us-east-1';

export type InboxCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * Async credential source. Returns null when no key has been provisioned yet;
 * callers surface that as a setup task instead of an S3 error. Task 3 wires
 * the Keychain-backed provider (service `com.callie.sourcing-inbox`, account
 * `app-inbox`).
 */
export type InboxCredentialProvider = () => Promise<InboxCredentials | null>;

export class InboxCredentialsUnavailableError extends Error {
  constructor() {
    super('No sourcing-inbox credentials are provisioned.');
    this.name = 'InboxCredentialsUnavailableError';
  }
}

/** Minimal object-store surface the client needs; S3 or an in-memory fake. */
export type InboxObjectStore = {
  listKeys(input: {
    prefix: string;
    startAfter: string | null;
    signal: AbortSignal;
  }): Promise<string[]>;
  getObjectText(input: { key: string; signal: AbortSignal }): Promise<string>;
};

export type QuarantinedLine = {
  key: string;
  lineNumber: number;
  reason: string;
  rawLine: string;
  quarantinedAt: string;
};

export type InboxBatch = {
  key: string;
  events: CloudSourceEvent[];
  quarantined: QuarantinedLine[];
};

export class InboxClient {
  private readonly store: InboxObjectStore;
  private readonly clock: Clock;

  constructor(input: { store: InboxObjectStore; clock: Clock }) {
    this.store = input.store;
    this.clock = input.clock;
  }

  /**
   * Keys under `events/` strictly after `sinceKey` in lexicographic order.
   * Pass null to read from the beginning of the inbox.
   */
  async listNewObjects(
    sinceKey: string | null,
    signal: AbortSignal,
  ): Promise<string[]> {
    const keys = await runWithAbortDeadline({
      code: 'S3_LIST_TIMEOUT',
      timeoutMs: 30_000,
      parentSignal: signal,
      operation: (listSignal) => this.store.listKeys({
        prefix: INBOX_EVENTS_PREFIX,
        startAfter: sinceKey,
        signal: listSignal,
      }),
    });
    return [...keys].sort();
  }

  /**
   * Fetch one ndjson object and validate each line. Blank lines are skipped;
   * unparseable or contract-violating lines land in `quarantined` with the
   * reason and the raw line preserved for later inspection.
   */
  async fetchNdjson(key: string, signal: AbortSignal): Promise<InboxBatch> {
    const body = await runWithAbortDeadline({
      code: 'S3_FETCH_TIMEOUT',
      timeoutMs: 60_000,
      parentSignal: signal,
      operation: (fetchSignal) => this.store.getObjectText({ key, signal: fetchSignal }),
    });
    const events: CloudSourceEvent[] = [];
    const quarantined: QuarantinedLine[] = [];

    body.split('\n').forEach((line, index) => {
      if (line.trim().length === 0) return;
      const lineNumber = index + 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        quarantined.push(this.quarantine(
          key,
          lineNumber,
          line,
          `JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
        ));
        return;
      }

      const result = validateCloudSourceEvent(parsed);
      if (result.success === false) {
        quarantined.push(this.quarantine(key, lineNumber, line, result.error));
        return;
      }
      events.push(result.data);
    });

    return { key, events, quarantined };
  }

  private quarantine(
    key: string,
    lineNumber: number,
    rawLine: string,
    reason: string,
  ): QuarantinedLine {
    return {
      key,
      lineNumber,
      reason,
      rawLine,
      quarantinedAt: this.clock.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// Credential provider: one-time import file (Keychain wiring is Task 3)
// ---------------------------------------------------------------------------

const accessKeyFileSchema = z
  .object({
    AccessKey: z
      .object({
        AccessKeyId: z.string().min(1),
        SecretAccessKey: z.string().min(1),
      })
      // `aws iam create-access-key` also emits UserName/Status/CreateDate;
      // tolerate any sibling fields, they are not secrets we consume.
      .loose(),
  })
  .loose();

/**
 * Reads `~/.callie-sourcing-app-inbox-key.json` (the verbatim output of
 * `aws iam create-access-key`). Returns null when the file is missing or
 * malformed so callers can fall back to the not-provisioned flow.
 */
export function createFileInboxCredentialProvider(
  path: string,
): InboxCredentialProvider {
  return async () => {
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }
    const result = accessKeyFileSchema.safeParse(parsed);
    if (!result.success) return null;
    return {
      accessKeyId: result.data.AccessKey.AccessKeyId,
      secretAccessKey: result.data.AccessKey.SecretAccessKey,
    };
  };
}

// ---------------------------------------------------------------------------
// Real S3-backed store
// ---------------------------------------------------------------------------

/**
 * TEST-ONLY filesystem `InboxObjectStore` for the packaged E2E fixture path
 * (main.ts: CALLIE_SOURCING_FIXTURE_DIR). Object keys map to files under the
 * root directory (`events/2026-09-01/a.ndjson` -> `<root>/events/...`), and
 * listing walks the `events/` tree recursively in lexicographic order with
 * the same strictly-after cursor semantics as S3 ListObjectsV2.
 */
export function createFileSystemInboxObjectStore(
  rootDirectory: string,
): InboxObjectStore {
  return {
    async listKeys({ prefix, startAfter, signal }) {
      signal.throwIfAborted();
      const { readdir } = await import('node:fs/promises');
      const { join, relative, sep } = await import('node:path');
      const base = join(rootDirectory, prefix);
      let keys: string[] = [];
      try {
        const entries = await readdir(base, {
          recursive: true,
          withFileTypes: true,
        });
        signal.throwIfAborted();
        keys = entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson'))
          .map((entry) => {
            const absolute = join(entry.parentPath, entry.name);
            return prefix + relative(base, absolute).split(sep).join('/');
          });
      } catch {
        signal.throwIfAborted();
        return [];
      }
      signal.throwIfAborted();
      keys.sort();
      return startAfter === null
        ? keys
        : keys.filter((key) => key > startAfter);
    },
    async getObjectText({ key, signal }) {
      signal.throwIfAborted();
      const { join } = await import('node:path');
      const body = await readFile(join(rootDirectory, key), 'utf8');
      signal.throwIfAborted();
      return body;
    },
  };
}

/**
 * Production `InboxObjectStore` over `@aws-sdk/client-s3`. Constructed lazily
 * per call site (main process only); throws
 * `InboxCredentialsUnavailableError` when the provider has no key yet.
 */
export async function createS3InboxObjectStore(input: {
  credentialProvider: InboxCredentialProvider;
  bucket?: string;
  region?: string;
}): Promise<InboxObjectStore> {
  const credentials = await input.credentialProvider();
  if (credentials === null) {
    throw new InboxCredentialsUnavailableError();
  }
  const bucket = input.bucket ?? INBOX_BUCKET;
  const client = new S3Client({
    region: input.region ?? INBOX_AWS_REGION,
    credentials,
  });

  return {
    async listKeys({ prefix, startAfter, signal }) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          StartAfter: startAfter ?? undefined,
          ContinuationToken: continuationToken,
        }), { abortSignal: signal });
        signal.throwIfAborted();
        for (const object of page.Contents ?? []) {
          if (object.Key !== undefined) keys.push(object.Key);
        }
        continuationToken = page.IsTruncated === true
          ? page.NextContinuationToken
          : undefined;
      } while (continuationToken !== undefined);
      return keys;
    },

    async getObjectText({ key, signal }) {
      const response = await client.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }), { abortSignal: signal });
      signal.throwIfAborted();
      if (response.Body === undefined) {
        throw new Error(`S3 object has no body: ${key}`);
      }
      const body = await response.Body.transformToString('utf8');
      signal.throwIfAborted();
      return body;
    },
  };
}
