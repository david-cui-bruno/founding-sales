/**
 * Sourcing poller (plan Task 3): orchestrates inboxClient -> intakeMapper ->
 * domain intake, with a durable processed-file ledger.
 *
 * Dispatch per validated event:
 * - `intake`: person-bearing -> `importCloudSourceEvent` on the domain facade
 *   (standard intake + unreviewed cycle; receipts keyed
 *   `cloud:<idempotency_key>` make replays no-ops).
 * - `needs-identity`: counted and structured-logged; surfacing them as review
 *   items is Task 5. No new table.
 * - `score-update`: counted; cloud-score persistence lands in Task 5.
 *
 * Progress is defined by the `sourcing_processed_files` ledger (schema 9),
 * NOT a lexicographic cursor: every poll lists the whole inbox and skips
 * ledgered keys, so a key that sorts before an already-processed key (clock
 * skew between lambdas, manual repair copies) is still picked up. A file is
 * ledgered only after it has WHOLLY processed, so a mid-file failure retries
 * the same file next tick (every dispatch is idempotent) while later files
 * still process. `sourcing_cursor.last_key` is kept as the max processed key
 * purely so the status row shows freshness. The poller never throws: every
 * failure is caught, logged, and reflected in a health counter.
 *
 * Listing cost: inbox files accumulate at ~10/day, so a full ListObjectsV2
 * walk stays a handful of pages for years. No pruning or partitioning until
 * that changes.
 */
import type { FoundationRuntime } from '../foundation/foundationRuntime';
import type { Clock } from '../domain/support/clock';
import type {
  SourcingCounters,
  SourcingCredentialState,
  FixtureExecutionEvidence,
  SourcingHmacSaltState,
  SourcingStatus,
} from '../../shared/contracts/sourcingContract';
import type { InboxBatch } from './inboxClient';
import type { LoadedSourcingCredentials } from './sourcingCredentialStore';
import type { UpstreamObjectStore, UpstreamSync } from './upstreamSync';
import { buildNeedsIdentityIntakeCommand, mapCloudSourceEvent } from './intakeMapper';
import { RemoteOperationTimeoutError } from '../runtime/abortDeadline';
import {
  evaluatePollHealth,
  type PollExecutionState,
  type SourcingPollHealth,
} from './pollExecutionState';

/** The subset of the inbox client the poller drives; injected for tests. */
export type PollableInbox = {
  listNewObjects(sinceKey: string | null, signal: AbortSignal): Promise<string[]>;
  fetchNdjson(key: string, signal: AbortSignal): Promise<InboxBatch>;
};

export type SourcingPollerDomainGate = Pick<FoundationRuntime, 'withDomain'>;

/**
 * Injected recurring-timer surface. `schedule` arms the recurring callback
 * and returns a disarm function. Production passes a 15-minute unref'd
 * interval; tests trigger the callback directly.
 */
export type PollTimer = {
  schedule(callback: () => void): () => void;
};

export type PollIdGenerator = {
  next(): string;
};

export type WatchdogTimer = {
  schedule(callback: () => void): () => void;
};

type OwnedPoll = {
  pollId: string;
  startedAt: string;
  controller: AbortController;
  promise: Promise<void>;
};

const POLL_CADENCE_MS = 15 * 60_000;
const POLL_TOTAL_DEADLINE_MS = 14 * 60_000;

export class SourcingPoller {
  private readonly domainGate: SourcingPollerDomainGate;
  private readonly loadCredentials: () => Promise<LoadedSourcingCredentials>;
  private readonly createInboxClient: (
    credentials: LoadedSourcingCredentials,
  ) => Promise<PollableInbox>;
  private readonly upstream: {
    sync: UpstreamSync;
    createStore: (
      credentials: LoadedSourcingCredentials,
    ) => Promise<UpstreamObjectStore>;
    saltState: () => Promise<SourcingHmacSaltState>;
    setSalt: (salt: string) => Promise<void>;
  } | undefined;
  private readonly clock: Clock;
  private readonly log: (message: string) => void;

  private readonly counters: SourcingCounters = {
    imported: 0,
    replayed: 0,
    needsIdentity: 0,
    scoreUpdates: 0,
    quarantined: 0,
  };
  private credentialState: SourcingCredentialState = 'none';
  private backlogCount: number | null = null;
  private executionState: PollExecutionState = {
    state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null,
    consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null,
    backlogCount: null,
  };
  private consecutiveBackloggedPolls = 0;
  private activePoll: OwnedPoll | undefined;
  private disarmTimer: (() => void) | undefined;
  private disarmWatchdog: (() => void) | undefined;
  private stopped = false;
  private readonly pollIds: PollIdGenerator;
  private readonly watchdogTimer: WatchdogTimer;
  private readonly fixtureExecutionEvidence: (() => FixtureExecutionEvidence) | undefined;

  constructor(input: {
    domainGate: SourcingPollerDomainGate;
    loadCredentials: () => Promise<LoadedSourcingCredentials>;
    createInboxClient: (
      credentials: LoadedSourcingCredentials,
    ) => Promise<PollableInbox>;
    /**
     * Optional Task 4 upstream leg. When present, every successful poll ends
     * with a membership upload plus an outcome-outbox flush over a store
     * built from the same credentials.
     */
    upstream?: {
      sync: UpstreamSync;
      createStore: (
        credentials: LoadedSourcingCredentials,
      ) => Promise<UpstreamObjectStore>;
      saltState: () => Promise<SourcingHmacSaltState>;
      setSalt: (salt: string) => Promise<void>;
    };
    clock: Clock;
    log?: (message: string) => void;
    pollIds?: PollIdGenerator;
    watchdogTimer?: WatchdogTimer;
    fixtureExecutionEvidence?: () => FixtureExecutionEvidence;
  }) {
    this.domainGate = input.domainGate;
    this.loadCredentials = input.loadCredentials;
    this.createInboxClient = input.createInboxClient;
    this.upstream = input.upstream;
    this.clock = input.clock;
    this.log = input.log ?? (() => undefined);
    this.pollIds = input.pollIds ?? { next: () => crypto.randomUUID() };
    this.watchdogTimer = input.watchdogTimer ?? {
      schedule: (callback) => {
        const interval = setInterval(callback, 60_000);
        interval.unref();
        return () => clearInterval(interval);
      },
    };
    this.fixtureExecutionEvidence = input.fixtureExecutionEvidence;
  }

  /** Poll once at startup, then on every timer tick until stop(). */
  async start(timer: PollTimer): Promise<void> {
    this.disarmTimer = timer.schedule(() => {
      void this.pollNow();
    });
    this.disarmWatchdog = this.watchdogTimer.schedule(() => this.runWatchdog());
    await this.pollNow();
  }

  stop(): void {
    this.stopped = true;
    this.disarmTimer?.();
    this.disarmTimer = undefined;
    this.disarmWatchdog?.();
    this.disarmWatchdog = undefined;
    this.activePoll?.controller.abort(new Error('SOURCING_POLLER_STOPPED'));
  }

  /** Awaits any in-flight poll; used by tests and shutdown. */
  async idle(): Promise<void> {
    await this.activePoll?.promise.catch((): undefined => undefined);
  }

  /**
   * Runs one poll, coalescing overlapping requests into the in-flight run.
   * Never rejects: failures are logged and counted.
   */
  pollNow(): Promise<void> {
    if (this.activePoll !== undefined) return this.activePoll.promise;
    return this.startOwnedPoll().promise;
  }

  async retry(): Promise<void> {
    const owned = this.activePoll;
    if (owned !== undefined) {
      if (!this.isExpired(owned)) return owned.promise;
      owned.controller.abort(
        new RemoteOperationTimeoutError('POLL_TOTAL_TIMEOUT', POLL_TOTAL_DEADLINE_MS),
      );
      await owned.promise;
    }
    await this.pollNow();
  }

  async getStatus(): Promise<SourcingStatus> {
    if (this.credentialState === 'none') {
      // Reflect provisioning that happened after the last poll attempt.
      try {
        this.credentialState = (await this.loadCredentials()).source;
      } catch {
        this.credentialState = 'none';
      }
    }
    let hmacSaltState: SourcingHmacSaltState = 'none';
    if (this.upstream !== undefined) {
      try {
        hmacSaltState = await this.upstream.saltState();
      } catch {
        hmacSaltState = 'none';
      }
    }
    const cursor = await this.domainGate.withDomain(
      (domain) => domain.getSourcingCursor(),
    );
    return {
      lastPolledAt: cursor.polledAt,
      lastKey: cursor.lastKey,
      backlogCount: this.backlogCount,
      counters: { ...this.counters },
      credentialState: this.credentialState,
      hmacSaltState,
      execution: this.getExecutionState(),
      health: this.getHealth(),
      ...(this.fixtureExecutionEvidence === undefined
        ? {}
        : { fixtureExecutionEvidence: this.fixtureExecutionEvidence() }),
    };
  }

  getExecutionState(): PollExecutionState {
    return { ...this.executionState, backlogCount: this.backlogCount };
  }

  getHealth(): SourcingPollHealth {
    return evaluatePollHealth({
      state: this.getExecutionState(),
      credentialState: this.credentialState,
      consecutiveBackloggedPolls: this.consecutiveBackloggedPolls,
      nowMs: Date.parse(this.clock.now()),
      cadenceMs: POLL_CADENCE_MS,
      totalDeadlineMs: POLL_TOTAL_DEADLINE_MS,
    });
  }

  private startOwnedPoll(): OwnedPoll {
    const pollId = this.pollIds.next();
    const startedAt = this.clock.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      controller.abort(
        new RemoteOperationTimeoutError('POLL_TOTAL_TIMEOUT', POLL_TOTAL_DEADLINE_MS),
      );
    }, POLL_TOTAL_DEADLINE_MS);
    deadline.unref();
    const owned = { pollId, startedAt, controller } as OwnedPoll;
    this.executionState = { ...this.executionState, state: 'running', pollId, startedAt };
    owned.promise = this.runPoll(controller.signal)
      .then((successfulBacklogSample) => {
        if (successfulBacklogSample !== null) {
          this.recordSuccess(pollId, successfulBacklogSample);
        }
      })
      .catch((error: unknown) => this.recordFailure(error, pollId))
      .finally(() => {
        clearTimeout(deadline);
        if (this.activePoll?.pollId === pollId) {
          this.activePoll = undefined;
          this.executionState = {
            ...this.executionState, state: 'idle', pollId: null, startedAt: null,
          };
        }
      });
    this.activePoll = owned;
    return owned;
  }

  private runWatchdog(): void {
    const owned = this.activePoll;
    if (owned !== undefined && this.isExpired(owned)) {
      owned.controller.abort(
        new RemoteOperationTimeoutError('POLL_TOTAL_TIMEOUT', POLL_TOTAL_DEADLINE_MS),
      );
    }
  }

  private isExpired(owned: OwnedPoll): boolean {
    return Date.parse(this.clock.now()) - Date.parse(owned.startedAt) > POLL_TOTAL_DEADLINE_MS;
  }

  /** Stores the founder-pasted membership HMAC salt (Task 4). */
  async setHmacSalt(salt: string): Promise<void> {
    if (this.upstream === undefined) {
      throw new Error('Upstream sync is not configured; the salt has nowhere to live.');
    }
    await this.upstream.setSalt(salt);
  }

  private async runPoll(signal: AbortSignal): Promise<number | null> {
    if (this.stopped) return null;

    const loaded = await this.loadCredentials();
    signal.throwIfAborted();
    this.credentialState = loaded.source;
    if (loaded.credentials === null) {
      // Not provisioned: idle quietly, never an error.
      return null;
    }

    const inbox = await this.createInboxClient(loaded);
    signal.throwIfAborted();
    const { cursor, processedKeys } = await this.domainGate.withDomain(
      (domain) => ({
        cursor: domain.getSourcingCursor(),
        processedKeys: domain.getProcessedFileKeys(),
      }),
    );
    signal.throwIfAborted();
    // List EVERYTHING and let the ledger decide: a startAfter cursor would
    // permanently skip keys that sort before it (the live zz-repair incident).
    const allKeys = await inbox.listNewObjects(null, signal);
    signal.throwIfAborted();
    const keys = allKeys.filter((key) => !processedKeys.has(key));
    const successfulBacklogSample = keys.length;
    this.backlogCount = keys.length;

    let firstFailure: unknown;
    let maxProcessedKey = cursor.lastKey;
    for (const key of keys) {
      if (this.stopped) return null;
      try {
        const batch = await inbox.fetchNdjson(key, signal);
        signal.throwIfAborted();
        await this.processBatchOrThrow(batch);
        signal.throwIfAborted();
      } catch (error) {
        // A failed file is NOT ledgered and retries next tick. Later files
        // may still process safely: the ledger, not a cursor, defines
        // progress, so skipping ahead cannot lose the failed key.
        firstFailure ??= error;
        this.log(
          `sourcing file failed (not ledgered, retries next tick) ${key}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (maxProcessedKey === null || key > maxProcessedKey) {
        maxProcessedKey = key;
      }
      const lastKey = maxProcessedKey;
      signal.throwIfAborted();
      await this.domainGate.withDomain((domain) => {
        domain.recordProcessedFile({ key });
        // Keep the cursor as the max processed key so the status row still
        // shows freshness; it no longer gates which files are read.
        domain.recordSourcingPoll({ lastKey });
      });
      signal.throwIfAborted();
      this.backlogCount = Math.max(0, this.backlogCount - 1);
    }

    if (keys.length === 0) {
      // Record the poll time so the status row reflects freshness even when
      // the inbox is quiet.
      signal.throwIfAborted();
      await this.domainGate.withDomain((domain) => {
        domain.recordSourcingPoll({ lastKey: cursor.lastKey });
      });
      signal.throwIfAborted();
    }

    if (firstFailure !== undefined) {
      throw firstFailure;
    }

    // Ledger TTL: after a fully successful poll, drop processed-file rows
    // older than 90 days. Never on a failed poll, so a retryable failure
    // cannot race the prune.
    signal.throwIfAborted();
    await this.domainGate.withDomain((domain) => {
      domain.pruneProcessedFileLedger();
    });
    signal.throwIfAborted();

    // Task 4 upstream leg: membership + outcome flush after the inbox is
    // drained. An AccessDenied (IAM PutObject on upstream/* may lag the app)
    // is logged and retried next poll; nothing was marked flushed.
    if (this.upstream !== undefined) {
      try {
        const store = await this.upstream.createStore(loaded);
        signal.throwIfAborted();
        await this.upstream.sync.run(store, signal);
      } catch (error) {
        signal.throwIfAborted();
        this.log(
          `sourcing upstream sync failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }
    signal.throwIfAborted();
    return successfulBacklogSample;
  }

  /**
   * Processes one file. Throws on the first dispatch failure so the caller
   * leaves the file out of the ledger and the next tick retries the whole
   * file (dispatches are idempotent, so partial progress is safe to repeat).
   */
  private async processBatchOrThrow(batch: InboxBatch): Promise<void> {
    this.counters.quarantined += batch.quarantined.length;
    for (const line of batch.quarantined) {
      this.log(
        `sourcing quarantine ${line.key}:${line.lineNumber}: ${line.reason}`,
      );
    }

    for (const event of batch.events) {
      const mapped = mapCloudSourceEvent(event);
      try {
        await this.dispatchMappedEvent(mapped);
      } catch (error) {
        // Permanent per-event failures must not wedge the cursor: a replayed
        // idempotency key with CHANGED content can never succeed on retry
        // (the receipt comparison is deterministic), so it is quarantined
        // and the rest of the file proceeds. Everything else (network, DB
        // lock, transient) still throws so the whole file retries.
        if ((error as { name?: string }).name === 'IntakeIdempotencyConflictError') {
          this.counters.quarantined += 1;
          this.log(
            `sourcing quarantine ${mapped.receiptKey}: `
            + `idempotency conflict (${(error as Error).message})`,
          );
          continue;
        }
        throw error;
      }
    }
  }

  private async dispatchMappedEvent(
    mapped: ReturnType<typeof mapCloudSourceEvent>,
  ): Promise<void> {
    if (mapped.kind === 'intake') {
      const result = await this.domainGate.withDomain((domain) => (
        domain.importCloudSourceEvent({
          command: mapped.command,
          cloudEntityId: mapped.cloudEntityId,
        })
      ));
      // Full re-reads after the schema-9 cursor reset replay stored receipts;
      // counting those as imports would lie in the status row.
      if (result.replayed === false) {
        this.counters.imported += 1;
      } else {
        this.counters.replayed += 1;
      }
    } else if (mapped.kind === 'needs-identity') {
      // Task 5: person-null events become "Unknown owner · <situs>"
      // placeholders in the standard Unreviewed review lane; the founder
      // resolves identity by renaming (the cloud entity link is already
      // written at import). Events without a usable address stay
      // counted-and-skipped.
      const command = buildNeedsIdentityIntakeCommand(mapped);
      if (command !== null) {
        await this.domainGate.withDomain((domain) => {
          domain.importCloudSourceEvent({
            command,
            cloudEntityId: mapped.cloudEntityId,
          });
        });
      } else {
        this.log(
          `sourcing needs-identity skipped ${mapped.receiptKey} `
          + `(${mapped.channel}, no usable situs address)`,
        );
      }
      this.counters.needsIdentity += 1;
    } else {
      // Task 5: scorer re-emission -> persist onto the original prospect
      // through the intake receipt; unknown keys stay counted-and-skipped.
      const applied = await this.domainGate.withDomain((domain) => (
        domain.applyCloudScoreUpdate({
          receiptKey: mapped.receiptKey,
          scoresVersion: mapped.scoresVersion,
          fit: mapped.fit,
          timing: mapped.timing,
          reasons: mapped.reasons,
          scoredAt: mapped.scoredAt,
        })
      ));
      if (!applied) {
        this.log(
          `sourcing score-update skipped ${mapped.receiptKey} (no intake receipt)`,
        );
      }
    this.counters.scoreUpdates += 1;
    }
  }

  private recordSuccess(pollId: string, successfulBacklogSample: number): void {
    if (this.activePoll?.pollId !== pollId) return;
    this.consecutiveBackloggedPolls = successfulBacklogSample > 0
      ? this.consecutiveBackloggedPolls + 1
      : 0;
    this.executionState = {
      ...this.executionState,
      lastCompletedAt: this.clock.now(),
      consecutiveFailures: 0,
      lastFailureCode: null,
      backlogCount: this.backlogCount,
    };
  }

  private recordFailure(error: unknown, pollId: string): void {
    if (this.activePoll?.pollId !== pollId) return;
    this.consecutiveBackloggedPolls = 0;
    const code = error instanceof RemoteOperationTimeoutError
      ? error.code
      : error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.name)
        ? error.name
        : 'POLL_FAILED';
    this.executionState = {
      ...this.executionState,
      consecutiveFailures: this.executionState.consecutiveFailures + 1,
      lastFailureAt: this.clock.now(),
      lastFailureCode: code,
      backlogCount: this.backlogCount,
    };
    const message = error instanceof Error ? error.message : String(error);
    this.log(`sourcing poll failed (failed files stay unledgered): ${message}`);
  }
}
