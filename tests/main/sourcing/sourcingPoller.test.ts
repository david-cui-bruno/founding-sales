import { describe, expect, it, vi } from 'vitest';

import type { InboxBatch } from '../../../src/main/sourcing/inboxClient';
import {
  SourcingPoller,
  type SourcingPollerDomainGate,
} from '../../../src/main/sourcing/sourcingPoller';
import { validFrboEvent, validParcelEvent } from '../../fixtures/cloudSourceEvents';
import type { CloudSourceEvent } from '../../../src/shared/contracts/cloudSourceEventContract';

const NOW = '2026-09-01T12:00:00.000Z';

type FakeInbox = {
  listNewObjects: ReturnType<typeof vi.fn>;
  fetchNdjson: ReturnType<typeof vi.fn>;
};

function batch(key: string, events: CloudSourceEvent[], quarantined = 0): InboxBatch {
  return {
    key,
    events,
    quarantined: Array.from({ length: quarantined }, (_value, index) => ({
      key,
      lineNumber: index + 1,
      reason: 'synthetic',
      rawLine: '{}',
      quarantinedAt: NOW,
    })),
  };
}

function fakeDomainGate(initialCursor: string | null = null): {
  gate: SourcingPollerDomainGate;
  imported: string[];
  cursorWrites: Array<string | null>;
  cursor: () => string | null;
  failNextImport: (error: Error) => void;
} {
  let cursor = initialCursor;
  let polledAt: string | null = null;
  const imported: string[] = [];
  const cursorWrites: Array<string | null> = [];
  let nextImportError: Error | undefined;

  const gate: SourcingPollerDomainGate = {
    withDomain: async (operation) => operation({
      getSourcingCursor: () => ({ lastKey: cursor, polledAt }),
      recordSourcingPoll: ({ lastKey }: { lastKey: string | null }) => {
        cursor = lastKey;
        polledAt = NOW;
        cursorWrites.push(lastKey);
      },
      importCloudSourceEvent: ({ command }: {
        command: { source: { id: string } };
      }) => {
        if (nextImportError !== undefined) {
          const error = nextImportError;
          nextImportError = undefined;
          throw error;
        }
        imported.push(command.source.id);
        return {
          disposition: 'created',
          personId: 'person-1',
          prospectId: 'prospect-1',
          sourceEventId: command.source.id,
          identityReviewReason: null as string | null,
          contextReviewReasons: [] as string[],
          organizationIds: [] as string[],
          propertyIds: [] as string[],
        };
      },
    } as never),
  };

  return {
    gate,
    imported,
    cursorWrites,
    cursor: () => cursor,
    failNextImport: (error) => {
      nextImportError = error;
    },
  };
}

function buildPoller(input: {
  gate: SourcingPollerDomainGate;
  inbox?: FakeInbox;
  credentials?: 'keychain' | 'file' | 'none';
  createInboxFailure?: Error;
}): { poller: SourcingPoller; inbox: FakeInbox; logged: string[] } {
  const inbox: FakeInbox = input.inbox ?? {
    listNewObjects: vi.fn(async () => []),
    fetchNdjson: vi.fn(async () => batch('unused', [])),
  };
  const logged: string[] = [];
  const credentialState = input.credentials ?? 'keychain';
  const poller = new SourcingPoller({
    domainGate: input.gate,
    loadCredentials: async () => ({
      credentials: credentialState === 'none'
        ? null
        : { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
      source: credentialState,
    }),
    createInboxClient: async () => {
      if (input.createInboxFailure !== undefined) throw input.createInboxFailure;
      return inbox;
    },
    clock: { now: () => NOW },
    log: (message) => logged.push(message),
  });
  return { poller, inbox, logged };
}

describe('SourcingPoller', () => {
  it('idles with credentialState none and never lists the inbox', async () => {
    const { gate } = fakeDomainGate();
    const { poller, inbox } = buildPoller({ gate, credentials: 'none' });

    await poller.pollNow();
    const status = await poller.getStatus();

    expect(status).toEqual({
      lastPolledAt: null,
      lastKey: null,
      backlogCount: null,
      counters: { imported: 0, needsIdentity: 0, scoreUpdates: 0, quarantined: 0 },
      credentialState: 'none',
    });
    expect(inbox.listNewObjects).not.toHaveBeenCalled();
  });

  it('processes new objects, dispatches by variant, and persists the cursor per file', async () => {
    const domain = fakeDomainGate('events/2026-08-31/z.ndjson');
    const parcel = validParcelEvent();
    const frbo = validFrboEvent();
    const scored: CloudSourceEvent = {
      ...validParcelEvent(),
      idempotency_key: 'c'.repeat(64),
      scores: {
        fit: 10, timing: 10,
        reasons: [{ signal: 'x', contribution: 1 }],
      },
      scores_version: 1,
    };
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async () => [
        'events/2026-09-01/a.ndjson',
        'events/2026-09-01/b.ndjson',
      ]),
      fetchNdjson: vi.fn(async (key: string) => (
        key === 'events/2026-09-01/a.ndjson'
          ? batch(key, [parcel, frbo], 1)
          : batch(key, [scored])
      )),
    };
    const { poller } = buildPoller({ gate: domain.gate, inbox });

    await poller.pollNow();
    const status = await poller.getStatus();

    expect(inbox.listNewObjects).toHaveBeenCalledWith('events/2026-08-31/z.ndjson');
    expect(domain.imported).toEqual([`cloud:${parcel.idempotency_key}`]);
    expect(domain.cursorWrites).toEqual([
      'events/2026-09-01/a.ndjson',
      'events/2026-09-01/b.ndjson',
    ]);
    expect(status).toEqual({
      lastPolledAt: NOW,
      lastKey: 'events/2026-09-01/b.ndjson',
      backlogCount: 0,
      counters: { imported: 1, needsIdentity: 1, scoreUpdates: 1, quarantined: 1 },
      credentialState: 'keychain',
    });
  });

  it('keeps the cursor unchanged when a file fails mid-processing', async () => {
    const domain = fakeDomainGate();
    const first = validParcelEvent();
    const second: CloudSourceEvent = {
      ...validParcelEvent(),
      idempotency_key: 'd'.repeat(64),
    };
    domain.failNextImport(new Error('intake exploded'));
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async () => ['events/2026-09-01/a.ndjson']),
      fetchNdjson: vi.fn(async (key: string) => batch(key, [first, second])),
    };
    const { poller, logged } = buildPoller({ gate: domain.gate, inbox });

    await poller.pollNow();
    const status = await poller.getStatus();

    expect(domain.cursorWrites).toEqual([]);
    expect(domain.cursor()).toBeNull();
    expect(status.lastKey).toBeNull();
    expect(status.counters.imported).toBe(0);
    expect(poller.getHealth().consecutiveFailures).toBe(1);
    expect(logged.join('\n')).toContain('intake exploded');
  });

  it('retries the failed file on the next tick and recovers', async () => {
    const domain = fakeDomainGate();
    const event = validParcelEvent();
    domain.failNextImport(new Error('transient'));
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async () => ['events/2026-09-01/a.ndjson']),
      fetchNdjson: vi.fn(async (key: string) => batch(key, [event])),
    };
    const { poller } = buildPoller({ gate: domain.gate, inbox });

    await poller.pollNow();
    await poller.pollNow();

    expect(domain.imported).toEqual([`cloud:${event.idempotency_key}`]);
    expect(domain.cursor()).toBe('events/2026-09-01/a.ndjson');
    expect(poller.getHealth().consecutiveFailures).toBe(0);
  });

  it('never throws when the inbox client cannot be constructed', async () => {
    const domain = fakeDomainGate();
    const { poller, logged } = buildPoller({
      gate: domain.gate,
      createInboxFailure: new Error('S3 unreachable'),
    });

    await expect(poller.pollNow()).resolves.toBeUndefined();
    expect(poller.getHealth().consecutiveFailures).toBe(1);
    expect(logged.join('\n')).toContain('S3 unreachable');
  });

  it('coalesces overlapping pollNow calls into one run', async () => {
    const domain = fakeDomainGate();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async () => {
        await blocked;
        return [];
      }),
      fetchNdjson: vi.fn(async () => batch('unused', [])),
    };
    const { poller } = buildPoller({ gate: domain.gate, inbox });

    const firstPoll = poller.pollNow();
    const secondPoll = poller.pollNow();
    release?.();
    await Promise.all([firstPoll, secondPoll]);

    expect(inbox.listNewObjects).toHaveBeenCalledTimes(1);
  });

  it('polls on start and on the injected timer, and stop disarms it', async () => {
    const domain = fakeDomainGate();
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async () => []),
      fetchNdjson: vi.fn(async () => batch('unused', [])),
    };
    const { poller } = buildPoller({ gate: domain.gate, inbox });
    let tick: (() => void) | undefined;
    const timer = {
      schedule: vi.fn((callback: () => void) => {
        tick = callback;
        return () => {
          tick = undefined;
        };
      }),
    };

    await poller.start(timer);
    expect(inbox.listNewObjects).toHaveBeenCalledTimes(1);

    tick?.();
    await poller.idle();
    expect(inbox.listNewObjects).toHaveBeenCalledTimes(2);

    poller.stop();
    expect(tick).toBeUndefined();
  });
});
