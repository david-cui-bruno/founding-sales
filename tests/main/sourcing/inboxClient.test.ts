import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const s3 = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: class {
      readonly send = s3.send;
    },
  };
});

import {
  createFileInboxCredentialProvider,
  createFileSystemInboxObjectStore,
  createS3InboxObjectStore,
  InboxClient,
  InboxCredentialsUnavailableError,
  type InboxObjectStore,
} from '../../../src/main/sourcing/inboxClient';
import { RemoteOperationTimeoutError } from '../../../src/main/runtime/abortDeadline';
import { validFrboEvent, validParcelEvent } from '../../fixtures/cloudSourceEvents';

const NOW = '2026-09-01T12:00:00.000Z';
const SIGNAL = new AbortController().signal;

function ndjson(lines: unknown[]): string {
  return lines.map((line) => (
    typeof line === 'string' ? line : JSON.stringify(line)
  )).join('\n');
}

class FakeStore implements InboxObjectStore {
  readonly objects: Map<string, string>;
  readonly listCalls: Array<{ prefix: string; startAfter: string | null }> = [];

  constructor(objects: Record<string, string>) {
    this.objects = new Map(Object.entries(objects));
  }

  async listKeys(input: {
    prefix: string;
    startAfter: string | null;
    signal: AbortSignal;
  }): Promise<string[]> {
    input.signal.throwIfAborted();
    this.listCalls.push({ prefix: input.prefix, startAfter: input.startAfter });
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(input.prefix))
      .filter((key) => input.startAfter === null || key > input.startAfter)
      .sort();
    input.signal.throwIfAborted();
    return keys;
  }

  async getObjectText(input: { key: string; signal: AbortSignal }): Promise<string> {
    input.signal.throwIfAborted();
    const body = this.objects.get(input.key);
    if (body === undefined) throw new Error(`missing object: ${input.key}`);
    input.signal.throwIfAborted();
    return body;
  }
}

function buildClient(objects: Record<string, string>): {
  client: InboxClient;
  store: FakeStore;
} {
  const store = new FakeStore(objects);
  const client = new InboxClient({ store, clock: { now: () => NOW } });
  return { client, store };
}

describe('InboxClient', () => {
  describe('listNewObjects', () => {
    it('lists events/ keys after the cursor in lexicographic order', async () => {
      const { client, store } = buildClient({
        'events/2026-08-30/boston-permits-01A.ndjson': '',
        'events/2026-08-31/boston-permits-01B.ndjson': '',
        'events/2026-09-01/mail-parse-01C.ndjson': '',
        'upstream/membership/2026-09-01.json': '{}',
      });

      const keys = await client.listNewObjects(
        'events/2026-08-30/boston-permits-01A.ndjson',
        SIGNAL,
      );

      expect(keys).toEqual([
        'events/2026-08-31/boston-permits-01B.ndjson',
        'events/2026-09-01/mail-parse-01C.ndjson',
      ]);
      expect(store.listCalls).toEqual([{
        prefix: 'events/',
        startAfter: 'events/2026-08-30/boston-permits-01A.ndjson',
      }]);
    });

    it('lists everything from the beginning when the cursor is null', async () => {
      const { client } = buildClient({
        'events/2026-08-30/a.ndjson': '',
        'events/2026-08-31/b.ndjson': '',
      });

      expect(await client.listNewObjects(null, SIGNAL)).toEqual([
        'events/2026-08-30/a.ndjson',
        'events/2026-08-31/b.ndjson',
      ]);
    });
  });

  describe('fetchNdjson', () => {
    it('parses and validates every line of a well-formed batch', async () => {
      const frbo = validFrboEvent();
      const parcel = validParcelEvent();
      const { client } = buildClient({
        'events/2026-09-01/mixed.ndjson': ndjson([frbo, parcel]),
      });

      const batch = await client.fetchNdjson('events/2026-09-01/mixed.ndjson', SIGNAL);

      expect(batch.events).toEqual([frbo, parcel]);
      expect(batch.quarantined).toEqual([]);
    });

    it('quarantines invalid lines without dropping valid ones', async () => {
      const good = validFrboEvent();
      const wrongShape = { ...validFrboEvent(), contract_version: 2 };
      const { client } = buildClient({
        'events/2026-09-01/dirty.ndjson': ndjson([
          good,
          'not json at all {',
          wrongShape,
        ]),
      });

      const batch = await client.fetchNdjson('events/2026-09-01/dirty.ndjson', SIGNAL);

      expect(batch.events).toEqual([good]);
      expect(batch.quarantined).toHaveLength(2);
      expect(batch.quarantined[0]).toMatchObject({
        key: 'events/2026-09-01/dirty.ndjson',
        lineNumber: 2,
        quarantinedAt: NOW,
      });
      expect(batch.quarantined[0]?.reason).toContain('JSON');
      expect(batch.quarantined[1]).toMatchObject({ lineNumber: 3 });
      expect(batch.quarantined[1]?.reason).toContain('envelope');
    });

    it('quarantines payloads that fail the channel schema', async () => {
      const badPayload = validFrboEvent();
      badPayload.payload = { unexpected: true };
      const { client } = buildClient({
        'events/2026-09-01/bad-payload.ndjson': ndjson([badPayload]),
      });

      const batch = await client.fetchNdjson('events/2026-09-01/bad-payload.ndjson', SIGNAL);

      expect(batch.events).toEqual([]);
      expect(batch.quarantined).toHaveLength(1);
      expect(batch.quarantined[0]?.reason).toContain('payload');
    });

    it('skips blank lines without quarantining them', async () => {
      const event = validFrboEvent();
      const { client } = buildClient({
        'events/2026-09-01/trailing.ndjson': `${JSON.stringify(event)}\n\n`,
      });

      const batch = await client.fetchNdjson('events/2026-09-01/trailing.ndjson', SIGNAL);

      expect(batch.events).toEqual([event]);
      expect(batch.quarantined).toEqual([]);
    });
  });
});

describe('InboxClient remote deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('bounds a never-resolving list and aborts the store signal after 60 seconds', async () => {
    let storeSignal: AbortSignal | undefined;
    const client = new InboxClient({
      store: {
        listKeys: async ({ signal }) => {
          storeSignal = signal;
          return new Promise<string[]>(() => undefined);
        },
        getObjectText: async () => '',
      },
      clock: { now: () => NOW },
    });
    const parent = new AbortController();
    const result = client.listNewObjects(null, parent.signal);
    const rejection = expect(result).rejects.toMatchObject({
      code: 'S3_LIST_TIMEOUT',
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
    expect(storeSignal).toBeDefined();
    expect(storeSignal).not.toBe(parent.signal);
    expect(storeSignal?.aborted).toBe(true);
  });

  it('bounds a never-resolving body fetch and ignores late body settlement', async () => {
    let storeSignal: AbortSignal | undefined;
    let resolveBody!: (body: string) => void;
    const body = new Promise<string>((resolve) => {
      resolveBody = resolve;
    });
    const client = new InboxClient({
      store: {
        listKeys: async () => [],
        getObjectText: async ({ signal }) => {
          storeSignal = signal;
          return body;
        },
      },
      clock: { now: () => NOW },
    });
    const result = client.fetchNdjson('events/hung.ndjson', SIGNAL);
    const rejection = expect(result).rejects.toMatchObject({
      code: 'S3_FETCH_TIMEOUT',
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await rejection;
    resolveBody(`${JSON.stringify(validParcelEvent())}\n`);
    await Promise.resolve();

    await expect(result).rejects.toBeInstanceOf(RemoteOperationTimeoutError);
    expect(storeSignal?.aborted).toBe(true);
  });
});

describe('S3 inbox object store cancellation', () => {
  afterEach(() => {
    s3.send.mockReset();
  });

  it('passes the exact list signal to every paginated S3 send', async () => {
    s3.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'events/a.ndjson' }],
        IsTruncated: true,
        NextContinuationToken: 'next',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'events/b.ndjson' }],
        IsTruncated: false,
      });
    const store = await createS3InboxObjectStore({
      credentialProvider: async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'secret' }),
    });
    const signal = new AbortController().signal;

    await expect(store.listKeys({
      prefix: 'events/',
      startAfter: null,
      signal,
    })).resolves.toEqual(['events/a.ndjson', 'events/b.ndjson']);

    expect(s3.send).toHaveBeenCalledTimes(2);
    expect(s3.send.mock.calls[0]?.[1]).toEqual({ abortSignal: signal });
    expect(s3.send.mock.calls[1]?.[1]).toEqual({ abortSignal: signal });
  });

  it('keeps body transformation inside the fetch signal budget', async () => {
    let resolveBody!: (body: string) => void;
    s3.send.mockResolvedValue({
      Body: {
        transformToString: () => new Promise<string>((resolve) => {
          resolveBody = resolve;
        }),
      },
    });
    const store = await createS3InboxObjectStore({
      credentialProvider: async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'secret' }),
    });
    const controller = new AbortController();
    const body = store.getObjectText({ key: 'events/a.ndjson', signal: controller.signal });
    await Promise.resolve();

    expect(s3.send.mock.calls[0]?.[1]).toEqual({ abortSignal: controller.signal });
    controller.abort(new Error('fetch budget expired'));
    resolveBody('{}');

    await expect(body).rejects.toThrow('fetch budget expired');
  });
});

describe('filesystem inbox object store cancellation', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('fails before filesystem list and read work when the signal is already aborted', async () => {
    directory = mkdtempSync(join(tmpdir(), 'callie-inbox-fs-test-'));
    const store = createFileSystemInboxObjectStore(directory);
    const controller = new AbortController();
    const reason = new Error('fixture poll cancelled');
    controller.abort(reason);

    await expect(store.listKeys({
      prefix: 'events/',
      startAfter: null,
      signal: controller.signal,
    })).rejects.toBe(reason);
    await expect(store.getObjectText({
      key: 'events/a.ndjson',
      signal: controller.signal,
    })).rejects.toBe(reason);
  });
});

describe('createFileInboxCredentialProvider', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function writeKeyFile(content: string): string {
    directory = mkdtempSync(join(tmpdir(), 'callie-inbox-key-test-'));
    const path = join(directory, 'key.json');
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  }

  it('reads the aws iam create-access-key JSON shape', async () => {
    const path = writeKeyFile(JSON.stringify({
      AccessKey: {
        UserName: 'callie-sourcing-app-inbox',
        AccessKeyId: 'AKIAEXAMPLEKEYID',
        Status: 'Active',
        SecretAccessKey: 'example-secret',
        CreateDate: '2026-09-01T00:00:00+00:00',
      },
    }));

    const provider = createFileInboxCredentialProvider(path);

    expect(await provider()).toEqual({
      accessKeyId: 'AKIAEXAMPLEKEYID',
      secretAccessKey: 'example-secret',
    });
  });

  it('returns null when the file is missing', async () => {
    const provider = createFileInboxCredentialProvider('/nonexistent/key.json');
    expect(await provider()).toBeNull();
  });

  it('returns null when the file is malformed', async () => {
    const path = writeKeyFile('{"AccessKey":{"AccessKeyId":""}}');
    const provider = createFileInboxCredentialProvider(path);
    expect(await provider()).toBeNull();
  });
});

describe('InboxCredentialsUnavailableError', () => {
  it('is a named error for the Task 3 poller to catch', () => {
    const error = new InboxCredentialsUnavailableError();
    expect(error.name).toBe('InboxCredentialsUnavailableError');
    expect(error).toBeInstanceOf(Error);
  });
});
