import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InboxClient,
  type InboxBatch,
  type InboxObjectStore,
} from '../../../src/main/sourcing/inboxClient';
import {
  SourcingPoller,
  type SourcingPollerDomainGate,
} from '../../../src/main/sourcing/sourcingPoller';
import { validFrboEvent, validParcelEvent } from '../../fixtures/cloudSourceEvents';
import type { CloudSourceEvent } from '../../../src/shared/contracts/cloudSourceEventContract';
import type { CloudOutcomeRow } from '../../../src/main/domain/founderSalesDomain';
import {
  UpstreamSync,
  type UpstreamObjectStore,
} from '../../../src/main/sourcing/upstreamSync';

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
  scoreUpdates: string[];
  cursorWrites: Array<string | null>;
  ledgered: string[];
  ledger: Set<string>;
  cursor: () => string | null;
  failNextImport: (error: Error) => void;
  replayNextImport: () => void;
} {
  let cursor = initialCursor;
  let polledAt: string | null = null;
  const imported: string[] = [];
  const scoreUpdates: string[] = [];
  const cursorWrites: Array<string | null> = [];
  const ledgered: string[] = [];
  const ledger = new Set<string>();
  let nextImportError: Error | undefined;
  let nextImportReplays = false;

  const gate: SourcingPollerDomainGate = {
    withDomain: async (operation) => operation({
      getSourcingCursor: () => ({ lastKey: cursor, polledAt }),
      recordSourcingPoll: ({ lastKey }: { lastKey: string | null }) => {
        cursor = lastKey;
        polledAt = NOW;
        cursorWrites.push(lastKey);
      },
      getProcessedFileKeys: () => new Set(ledger),
      recordProcessedFile: ({ key }: { key: string }) => {
        ledger.add(key);
        ledgered.push(key);
      },
      pruneProcessedFileLedger: () => 0,
      applyCloudScoreUpdate: ({ receiptKey }: { receiptKey: string }) => {
        scoreUpdates.push(receiptKey);
        return true;
      },
      importCloudSourceEvent: ({ command }: {
        command: { source: { id: string } };
      }) => {
        if (nextImportError !== undefined) {
          const error = nextImportError;
          nextImportError = undefined;
          throw error;
        }
        const replayed = nextImportReplays;
        nextImportReplays = false;
        if (!replayed) {
          imported.push(command.source.id);
        }
        return {
          disposition: 'created',
          personId: 'person-1',
          prospectId: 'prospect-1',
          sourceEventId: command.source.id,
          identityReviewReason: null as string | null,
          contextReviewReasons: [] as string[],
          organizationIds: [] as string[],
          propertyIds: [] as string[],
          replayed,
        };
      },
    } as never),
  };

  return {
    gate,
    imported,
    scoreUpdates,
    cursorWrites,
    ledgered,
    ledger,
    cursor: () => cursor,
    failNextImport: (error) => {
      nextImportError = error;
    },
    replayNextImport: () => {
      nextImportReplays = true;
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

    expect(status).toEqual(expect.objectContaining({
      lastPolledAt: null,
      lastKey: null,
      backlogCount: null,
      counters: {
        imported: 0, replayed: 0, needsIdentity: 0, scoreUpdates: 0, quarantined: 0,
      },
      credentialState: 'none',
      hmacSaltState: 'none',
    }));
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

    // The ledger, not the cursor, defines progress: every poll lists the
    // whole inbox and skips ledgered keys.
    expect(inbox.listNewObjects).toHaveBeenCalledWith(null, expect.any(AbortSignal));
    // The parcel event imports a real person; the person-null frbo event
    // imports an "Unknown owner" placeholder (Task 5); the scored
    // re-emission persists through applyCloudScoreUpdate.
    expect(domain.imported).toEqual([
      `cloud:${parcel.idempotency_key}`,
      `cloud:${frbo.idempotency_key}`,
    ]);
    expect(domain.scoreUpdates).toEqual([`cloud:${scored.idempotency_key}`]);
    expect(domain.cursorWrites).toEqual([
      'events/2026-09-01/a.ndjson',
      'events/2026-09-01/b.ndjson',
    ]);
    expect(domain.ledgered).toEqual([
      'events/2026-09-01/a.ndjson',
      'events/2026-09-01/b.ndjson',
    ]);
    expect(status).toEqual(expect.objectContaining({
      lastPolledAt: NOW,
      lastKey: 'events/2026-09-01/b.ndjson',
      backlogCount: 0,
      counters: {
        imported: 1, replayed: 0, needsIdentity: 1, scoreUpdates: 1, quarantined: 1,
      },
      credentialState: 'keychain',
      hmacSaltState: 'none',
    }));
  });

  it('picks up a key that sorts before an already-processed key on the next poll', async () => {
    // The live incident: a repair copy (zz-repair-*) was consumed, then a
    // normal same-day file (mail-parse-*) arrived that sorts BEFORE it. A
    // lexicographic cursor loses that file forever; the ledger must not.
    const domain = fakeDomainGate();
    const repair = validParcelEvent();
    const late: CloudSourceEvent = {
      ...validParcelEvent(),
      idempotency_key: 'e'.repeat(64),
    };
    const repairKey = 'events/2026-09-01/zz-repair-c-scorer.ndjson';
    const lateKey = 'events/2026-09-01/mail-parse-late.ndjson';
    let inboxKeys = [repairKey];
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async () => [...inboxKeys].sort()),
      fetchNdjson: vi.fn(async (key: string) => (
        key === repairKey ? batch(key, [repair]) : batch(key, [late])
      )),
    };
    const { poller } = buildPoller({ gate: domain.gate, inbox });

    await poller.pollNow();
    expect(domain.ledgered).toEqual([repairKey]);

    inboxKeys = [repairKey, lateKey];
    await poller.pollNow();
    const status = await poller.getStatus();

    expect(domain.imported).toEqual([
      `cloud:${repair.idempotency_key}`,
      `cloud:${late.idempotency_key}`,
    ]);
    expect(domain.ledgered).toEqual([repairKey, lateKey]);
    // The already-ledgered repair file is never fetched again.
    expect(inbox.fetchNdjson).toHaveBeenCalledTimes(2);
    // The cursor keeps tracking the MAX processed key for the status row.
    expect(status.lastKey).toBe(repairKey);
    expect(status.counters.imported).toBe(2);
  });

  it('counts a replayed receipt as replayed, not imported', async () => {
    const domain = fakeDomainGate();
    const event = validParcelEvent();
    domain.replayNextImport();
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async () => ['events/2026-09-01/a.ndjson']),
      fetchNdjson: vi.fn(async (key: string) => batch(key, [event])),
    };
    const { poller } = buildPoller({ gate: domain.gate, inbox });

    await poller.pollNow();
    const status = await poller.getStatus();

    expect(status.counters.imported).toBe(0);
    expect(status.counters.replayed).toBe(1);
    // The replayed file still completes and lands in the ledger.
    expect(domain.ledgered).toEqual(['events/2026-09-01/a.ndjson']);
  });

  it('leaves a failed file unledgered while later files still process, then retries it', async () => {
    const domain = fakeDomainGate();
    const first = validParcelEvent();
    const second: CloudSourceEvent = {
      ...validParcelEvent(),
      idempotency_key: 'f'.repeat(64),
    };
    domain.failNextImport(new Error('transient intake failure'));
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async () => [
        'events/2026-09-01/a.ndjson',
        'events/2026-09-01/b.ndjson',
      ]),
      fetchNdjson: vi.fn(async (key: string) => (
        key === 'events/2026-09-01/a.ndjson'
          ? batch(key, [first])
          : batch(key, [second])
      )),
    };
    const { poller } = buildPoller({ gate: domain.gate, inbox });

    await poller.pollNow();

    // The failed file is NOT ledgered; the later file processed anyway.
    expect(domain.ledgered).toEqual(['events/2026-09-01/b.ndjson']);
    expect(domain.imported).toEqual([`cloud:${second.idempotency_key}`]);
    expect(poller.getExecutionState().consecutiveFailures).toBe(1);

    await poller.pollNow();

    // Next tick retries only the failed file.
    expect(domain.ledgered).toEqual([
      'events/2026-09-01/b.ndjson',
      'events/2026-09-01/a.ndjson',
    ]);
    expect(domain.imported).toEqual([
      `cloud:${second.idempotency_key}`,
      `cloud:${first.idempotency_key}`,
    ]);
    expect(poller.getExecutionState().consecutiveFailures).toBe(0);
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
    expect(poller.getExecutionState().consecutiveFailures).toBe(1);
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
    expect(poller.getExecutionState().consecutiveFailures).toBe(0);
  });

  it('never throws when the inbox client cannot be constructed', async () => {
    const domain = fakeDomainGate();
    const { poller, logged } = buildPoller({
      gate: domain.gate,
      createInboxFailure: new Error('S3 unreachable'),
    });

    await expect(poller.pollNow()).resolves.toBeUndefined();
    expect(poller.getExecutionState().consecutiveFailures).toBe(1);
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

  it('runs the upstream sync after draining the inbox and surfaces the salt state', async () => {
    const domain = fakeDomainGate();
    const run = vi.fn(async () => ({ membershipUploaded: true, outcomesFlushed: 1, suppressionsFlushed: 0 }));
    const store = { putObjectText: vi.fn(async () => undefined) };
    const poller = new SourcingPoller({
      domainGate: domain.gate,
      loadCredentials: async () => ({
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        source: 'keychain',
      }),
      createInboxClient: async () => ({
        listNewObjects: async () => [],
        fetchNdjson: async () => batch('unused', []),
      }),
      upstream: {
        sync: { run } as never,
        createStore: async () => store,
        saltState: async () => 'set',
        setSalt: async () => undefined,
      },
      clock: { now: () => NOW },
    });

    await poller.pollNow();
    const status = await poller.getStatus();

    expect(run).toHaveBeenCalledWith(store, expect.any(AbortSignal));
    expect(status.hmacSaltState).toBe('set');
    expect(poller.getExecutionState().consecutiveFailures).toBe(0);
  });

  it('records an upstream upload denial as an incomplete poll failure', async () => {
    const domain = fakeDomainGate();
    const logged: string[] = [];
    const poller = new SourcingPoller({
      domainGate: domain.gate,
      loadCredentials: async () => ({
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        source: 'keychain',
      }),
      createInboxClient: async () => ({
        listNewObjects: async () => [],
        fetchNdjson: async () => batch('unused', []),
      }),
      upstream: {
        sync: {
          run: async () => {
            throw new Error('AccessDenied');
          },
        } as never,
        createStore: async () => ({ putObjectText: async () => undefined }),
        saltState: async () => 'none',
        setSalt: async () => undefined,
      },
      clock: { now: () => NOW },
      log: (message) => logged.push(message),
    });

    await poller.pollNow();

    expect(poller.getExecutionState().consecutiveFailures).toBe(1);
    expect(poller.getExecutionState().lastFailureCode).toBe('POLL_FAILED');
    expect(poller.getExecutionState().lastCompletedAt).toBeNull();
    expect(logged.join('\n')).toContain('AccessDenied');
  });
});

describe('SourcingPoller remote deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('passes one exact poll-owned signal through list, fetch, and UpstreamSync.run', async () => {
    const domain = fakeDomainGate();
    const key = 'events/2026-09-01/a.ndjson';
    let listSignal: AbortSignal | undefined;
    let fetchSignal: AbortSignal | undefined;
    let upstreamSignal: AbortSignal | undefined;
    const store = { putObjectText: vi.fn(async () => undefined) };
    const run = vi.fn(async (_store: unknown, signal: AbortSignal) => {
      upstreamSignal = signal;
      return { membershipUploaded: false, outcomesFlushed: 0, suppressionsFlushed: 0 };
    });
    const poller = new SourcingPoller({
      domainGate: domain.gate,
      loadCredentials: async () => ({
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        source: 'keychain',
      }),
      createInboxClient: async () => ({
        listNewObjects: async (_sinceKey, signal) => {
          listSignal = signal;
          return [key];
        },
        fetchNdjson: async (_key, signal) => {
          fetchSignal = signal;
          return batch(key, []);
        },
      }),
      upstream: {
        sync: { run } as never,
        createStore: async () => store as never,
        saltState: async () => 'none',
        setSalt: async () => undefined,
      },
      clock: { now: () => NOW },
    });

    await poller.pollNow();

    expect(listSignal).toBeDefined();
    expect(fetchSignal).toBe(listSignal);
    expect(upstreamSignal).toBe(listSignal);
    expect(run).toHaveBeenCalledWith(store, listSignal);
    expect(listSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exposes deterministic running identity and completes only after upstream uploads settle', async () => {
    const domain = fakeDomainGate();
    let releaseUpload!: () => void;
    const upload = new Promise<void>((resolve) => { releaseUpload = resolve; });
    const poller = new SourcingPoller({
      domainGate: domain.gate,
      loadCredentials: async () => ({
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        source: 'keychain',
      }),
      createInboxClient: async () => ({
        listNewObjects: async () => [],
        fetchNdjson: async () => batch('unused', []),
      }),
      upstream: {
        sync: { run: async () => { await upload; } } as never,
        createStore: async () => ({ putObjectText: async () => undefined }),
        saltState: async () => 'none',
        setSalt: async () => undefined,
      },
      clock: { now: () => NOW },
      pollIds: { next: () => 'poll-deterministic' },
    });

    const running = poller.pollNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(poller.getExecutionState()).toEqual(expect.objectContaining({
      state: 'running', pollId: 'poll-deterministic', startedAt: NOW,
      lastCompletedAt: null,
    }));

    releaseUpload();
    await running;
    expect(poller.getExecutionState()).toEqual(expect.objectContaining({
      state: 'idle', pollId: null, startedAt: null, lastCompletedAt: NOW,
    }));
  });

  it('coalesces Retry onto a nonexpired poll', async () => {
    const domain = fakeDomainGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async () => { await blocked; return []; }),
      fetchNdjson: vi.fn(async () => batch('unused', [])),
    };
    const { poller } = buildPoller({ gate: domain.gate, inbox });

    const scheduled = poller.pollNow();
    const retried = poller.retry();
    release();
    await Promise.all([scheduled, retried]);

    expect(inbox.listNewObjects).toHaveBeenCalledTimes(1);
  });

  it('waits for expired-owner cleanup before starting exactly one replacement', async () => {
    const domain = fakeDomainGate();
    let nowMs = Date.parse(NOW);
    let releaseCleanup!: () => void;
    let resolveSecond!: (keys: string[]) => void;
    let attempts = 0;
    const events: string[] = [];
    const pollIds = ['poll-old', 'poll-new'];
    const poller = new SourcingPoller({
      domainGate: domain.gate,
      loadCredentials: async () => ({
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        source: 'keychain',
      }),
      createInboxClient: async () => ({
        listNewObjects: async (_sinceKey, signal) => {
          attempts += 1;
          events.push(`start:${attempts}`);
          if (attempts === 2) {
            return new Promise<string[]>((resolve) => { resolveSecond = resolve; });
          }
          return new Promise<string[]>((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              events.push('abort:1');
              void new Promise<void>((resolve) => { releaseCleanup = resolve; }).then(() => {
                events.push('cleanup:1');
                reject(signal.reason);
              });
            }, { once: true });
          });
        },
        fetchNdjson: async () => batch('unused', []),
      }),
      clock: { now: () => new Date(nowMs).toISOString() },
      pollIds: { next: () => pollIds.shift() ?? 'unexpected' },
    });

    void poller.pollNow();
    await vi.advanceTimersByTimeAsync(0);
    nowMs += 14 * 60_000 + 1;
    const retry = poller.retry();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual(['start:1', 'abort:1']);
    expect(poller.getExecutionState()).toEqual(expect.objectContaining({
      state: 'running', pollId: 'poll-old',
    }));
    releaseCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['start:1', 'abort:1', 'cleanup:1', 'start:2']);
    expect(poller.getExecutionState().pollId).toBe('poll-new');

    resolveSecond([]);
    await retry;
    expect(poller.getExecutionState()).toEqual(expect.objectContaining({
      state: 'idle', pollId: null, lastCompletedAt: new Date(nowMs).toISOString(),
    }));
  });

  it('idle waits for the aborted underlying execution cleanup before shutdown may close SQLite', async () => {
    const domain = fakeDomainGate();
    let releaseCleanup!: () => void;
    const events: string[] = [];
    const poller = new SourcingPoller({
      domainGate: domain.gate,
      loadCredentials: async () => ({
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        source: 'keychain',
      }),
      createInboxClient: async () => ({
        listNewObjects: async (_sinceKey, signal) => new Promise<string[]>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            events.push('abort');
            void new Promise<void>((resolve) => { releaseCleanup = resolve; }).then(() => {
              events.push('cleanup');
              reject(signal.reason);
            });
          }, { once: true });
        }),
        fetchNdjson: async () => batch('unused', []),
      }),
      clock: { now: () => NOW },
    });

    void poller.pollNow();
    await vi.advanceTimersByTimeAsync(0);
    poller.stop();
    let idleSettled = false;
    const idle = poller.idle().then(() => { idleSettled = true; });
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual(['abort']);
    expect(idleSettled).toBe(false);
    releaseCleanup();
    await idle;
    expect(events).toEqual(['abort', 'cleanup']);
  });

  it('tracks successful backlog samples across success, failure, reset, and recovery', async () => {
    const domain = fakeDomainGate();
    let attempt = 0;
    const poller = new SourcingPoller({
      domainGate: domain.gate,
      loadCredentials: async () => ({
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        source: 'keychain',
      }),
      createInboxClient: async () => ({
        listNewObjects: async () => {
          attempt += 1;
          if (attempt === 3) throw new Error('intervening failure');
          if (attempt === 6) return [];
          return [`events/poll-${attempt}.ndjson`];
        },
        fetchNdjson: async (key) => batch(key, []),
      }),
      clock: { now: () => NOW },
    });

    await poller.pollNow();
    expect(poller.getHealth().reasons).not.toContain('BACKLOG_PERSISTED_ACROSS_POLLS');
    await poller.pollNow();
    expect(poller.getHealth().reasons).toContain('BACKLOG_PERSISTED_ACROSS_POLLS');
    await poller.pollNow();
    expect(poller.getHealth().reasons).not.toContain('BACKLOG_PERSISTED_ACROSS_POLLS');
    await poller.pollNow();
    expect(poller.getHealth().reasons).not.toContain('BACKLOG_PERSISTED_ACROSS_POLLS');
    await poller.pollNow();
    expect(poller.getHealth().reasons).toContain('BACKLOG_PERSISTED_ACROSS_POLLS');
    await poller.pollNow();
    expect(poller.getHealth().reasons).not.toContain('BACKLOG_PERSISTED_ACROSS_POLLS');
  });

  it('bounds one total poll at 14 minutes, leaves the ledger unchanged, and permits recovery', async () => {
    const domain = fakeDomainGate();
    const key = 'events/2026-09-01/a.ndjson';
    let listAttempts = 0;
    const inbox: FakeInbox = {
      listNewObjects: vi.fn(async (_sinceKey, signal) => {
        listAttempts += 1;
        if (listAttempts === 1) {
          return new Promise<string[]>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return [key];
      }),
      fetchNdjson: vi.fn(async () => batch(key, [])),
    };
    const { poller } = buildPoller({ gate: domain.gate, inbox });
    const firstPoll = poller.pollNow();
    const completion = expect(firstPoll).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await completion;

    expect(domain.ledgered).toEqual([]);
    expect(poller.getExecutionState().consecutiveFailures).toBe(1);

    await poller.pollNow();
    expect(domain.ledgered).toEqual([key]);
    expect(poller.getExecutionState().consecutiveFailures).toBe(0);

    expect(domain.ledgered).toEqual([key]);
  });

  it('leaves a hung body unledgered after 60 seconds and processes it on a later poll', async () => {
    const domain = fakeDomainGate();
    const key = 'events/2026-09-01/a.ndjson';
    let resolveLate!: (body: string) => void;
    let fetchAttempts = 0;
    const objectStore: InboxObjectStore = {
      listKeys: async ({ signal }) => {
        signal.throwIfAborted();
        return [key];
      },
      getObjectText: async ({ signal }) => {
        signal.throwIfAborted();
        fetchAttempts += 1;
        if (fetchAttempts === 1) {
          return new Promise<string>((resolve) => {
            resolveLate = resolve;
          });
        }
        return '';
      },
    };
    const inbox = new InboxClient({ store: objectStore, clock: { now: () => NOW } });
    const { poller } = buildPoller({ gate: domain.gate, inbox: inbox as never });
    const firstPoll = poller.pollNow();

    await vi.advanceTimersByTimeAsync(60_000);
    await firstPoll;

    expect(domain.ledgered).toEqual([]);
    expect(poller.getExecutionState().consecutiveFailures).toBe(1);

    await poller.pollNow();
    expect(domain.ledgered).toEqual([key]);
    expect(poller.getExecutionState().consecutiveFailures).toBe(0);

    resolveLate('');
    await Promise.resolve();
    expect(domain.ledgered).toEqual([key]);
  });

  it('does not flush a hung upstream outbox upload and succeeds on the next poll', async () => {
    const pollDomain = fakeDomainGate();
    const outcome: CloudOutcomeRow = {
      id: 'stage:event-1',
      cloudEntityId: 'ce_01JC0000000000000000000000',
      label: 'won',
      lossReasonCode: null,
      overrideDirection: null,
      observedAt: NOW,
    };
    let flushed = false;
    const upstreamDomain = {
      withDomain: async <T>(operation: (domain: {
        listCloudMembership(): { cloudEntityIds: string[]; manualContacts: [] };
        listUnflushedCloudOutcomes(): CloudOutcomeRow[];
        markCloudOutcomesFlushed(): void;
        listUnflushedSuppressionHandles(): [];
        markSuppressionHandlesFlushed(): void;
      }) => T): Promise<T> => operation({
        listCloudMembership: () => ({ cloudEntityIds: [], manualContacts: [] }),
        listUnflushedCloudOutcomes: () => (flushed ? [] : [outcome]),
        markCloudOutcomesFlushed: () => {
          flushed = true;
        },
        listUnflushedSuppressionHandles: () => [],
        markSuppressionHandlesFlushed: () => undefined,
      }),
    };
    const sync = new UpstreamSync({
      domainGate: upstreamDomain as never,
      loadHmacSalt: async () => null,
      clock: { now: () => NOW },
      batchIds: { next: () => 'batch-1' },
    });
    let resolveLate!: () => void;
    let uploadAttempts = 0;
    let firstUploadSignal: AbortSignal | undefined;
    const store: UpstreamObjectStore = {
      putObjectText: async ({ signal }) => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          firstUploadSignal = signal;
          await new Promise<void>((resolve) => {
            resolveLate = resolve;
          });
        }
      },
    };
    const poller = new SourcingPoller({
      domainGate: pollDomain.gate,
      loadCredentials: async () => ({
        credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        source: 'keychain',
      }),
      createInboxClient: async () => ({
        listNewObjects: async () => [],
        fetchNdjson: async () => batch('unused', []),
      }),
      upstream: {
        sync,
        createStore: async () => store,
        saltState: async () => 'none',
        setSalt: async () => undefined,
      },
      clock: { now: () => NOW },
    });
    const firstPoll = poller.pollNow();

    await vi.advanceTimersByTimeAsync(60_000);
    await firstPoll;

    expect(firstUploadSignal?.aborted).toBe(true);
    expect(flushed).toBe(false);

    resolveLate();
    await Promise.resolve();
    expect(flushed).toBe(false);

    await poller.pollNow();
    expect(flushed).toBe(true);
  });
});
