import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFileInboxCredentialProvider,
  InboxClient,
  InboxCredentialsUnavailableError,
  type InboxObjectStore,
} from '../../../src/main/sourcing/inboxClient';
import { validFrboEvent, validParcelEvent } from '../../fixtures/cloudSourceEvents';

const NOW = '2026-09-01T12:00:00.000Z';

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

  async listKeys(input: { prefix: string; startAfter: string | null }): Promise<string[]> {
    this.listCalls.push({ prefix: input.prefix, startAfter: input.startAfter });
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(input.prefix))
      .filter((key) => input.startAfter === null || key > input.startAfter)
      .sort();
  }

  async getObjectText(key: string): Promise<string> {
    const body = this.objects.get(key);
    if (body === undefined) throw new Error(`missing object: ${key}`);
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

      const keys = await client.listNewObjects('events/2026-08-30/boston-permits-01A.ndjson');

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

      expect(await client.listNewObjects(null)).toEqual([
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

      const batch = await client.fetchNdjson('events/2026-09-01/mixed.ndjson');

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

      const batch = await client.fetchNdjson('events/2026-09-01/dirty.ndjson');

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

      const batch = await client.fetchNdjson('events/2026-09-01/bad-payload.ndjson');

      expect(batch.events).toEqual([]);
      expect(batch.quarantined).toHaveLength(1);
      expect(batch.quarantined[0]?.reason).toContain('payload');
    });

    it('skips blank lines without quarantining them', async () => {
      const event = validFrboEvent();
      const { client } = buildClient({
        'events/2026-09-01/trailing.ndjson': `${JSON.stringify(event)}\n\n`,
      });

      const batch = await client.fetchNdjson('events/2026-09-01/trailing.ndjson');

      expect(batch.events).toEqual([event]);
      expect(batch.quarantined).toEqual([]);
    });
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
