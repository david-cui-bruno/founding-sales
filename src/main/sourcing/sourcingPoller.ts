/**
 * Sourcing poller (plan Task 3): orchestrates inboxClient -> intakeMapper ->
 * domain intake, with a durable per-file cursor.
 *
 * Dispatch per validated event:
 * - `intake`: person-bearing -> `importCloudSourceEvent` on the domain facade
 *   (standard intake + unreviewed cycle; receipts keyed
 *   `cloud:<idempotency_key>` make replays no-ops).
 * - `needs-identity`: counted and structured-logged; surfacing them as review
 *   items is Task 5. No new table.
 * - `score-update`: counted; cloud-score persistence lands in Task 5.
 *
 * The cursor advances only after a WHOLE file has processed, so a mid-file
 * failure leaves the cursor unchanged and the next tick retries the same file
 * (every dispatch is idempotent). The poller never throws: every failure is
 * caught, logged, and reflected in a health counter.
 */
import type { FoundationRuntime } from '../foundation/foundationRuntime';
import type { Clock } from '../domain/support/clock';
import type {
  SourcingCounters,
  SourcingCredentialState,
  SourcingStatus,
} from '../../shared/contracts/sourcingContract';
import type { InboxBatch } from './inboxClient';
import type { LoadedSourcingCredentials } from './sourcingCredentialStore';
import { mapCloudSourceEvent } from './intakeMapper';

/** The subset of the inbox client the poller drives; injected for tests. */
export type PollableInbox = {
  listNewObjects(sinceKey: string | null): Promise<string[]>;
  fetchNdjson(key: string): Promise<InboxBatch>;
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

export type SourcingPollerHealth = {
  consecutiveFailures: number;
  lastFailureAt: string | null;
};

export class SourcingPoller {
  private readonly domainGate: SourcingPollerDomainGate;
  private readonly loadCredentials: () => Promise<LoadedSourcingCredentials>;
  private readonly createInboxClient: (
    credentials: LoadedSourcingCredentials,
  ) => Promise<PollableInbox>;
  private readonly clock: Clock;
  private readonly log: (message: string) => void;

  private readonly counters: SourcingCounters = {
    imported: 0,
    needsIdentity: 0,
    scoreUpdates: 0,
    quarantined: 0,
  };
  private credentialState: SourcingCredentialState = 'none';
  private backlogCount: number | null = null;
  private consecutiveFailures = 0;
  private lastFailureAt: string | null = null;
  private activePoll: Promise<void> | undefined;
  private disarmTimer: (() => void) | undefined;
  private stopped = false;

  constructor(input: {
    domainGate: SourcingPollerDomainGate;
    loadCredentials: () => Promise<LoadedSourcingCredentials>;
    createInboxClient: (
      credentials: LoadedSourcingCredentials,
    ) => Promise<PollableInbox>;
    clock: Clock;
    log?: (message: string) => void;
  }) {
    this.domainGate = input.domainGate;
    this.loadCredentials = input.loadCredentials;
    this.createInboxClient = input.createInboxClient;
    this.clock = input.clock;
    this.log = input.log ?? (() => undefined);
  }

  /** Poll once at startup, then on every timer tick until stop(). */
  async start(timer: PollTimer): Promise<void> {
    this.disarmTimer = timer.schedule(() => {
      void this.pollNow();
    });
    await this.pollNow();
  }

  stop(): void {
    this.stopped = true;
    this.disarmTimer?.();
    this.disarmTimer = undefined;
  }

  /** Awaits any in-flight poll; used by tests and shutdown. */
  async idle(): Promise<void> {
    await this.activePoll?.catch((): undefined => undefined);
  }

  /**
   * Runs one poll, coalescing overlapping requests into the in-flight run.
   * Never rejects: failures are logged and counted.
   */
  pollNow(): Promise<void> {
    if (this.activePoll !== undefined) {
      return this.activePoll;
    }
    const poll = this.runPoll()
      .catch((error: unknown) => this.recordFailure(error))
      .finally(() => {
        if (this.activePoll === poll) {
          this.activePoll = undefined;
        }
      });
    this.activePoll = poll;
    return poll;
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
    const cursor = await this.domainGate.withDomain(
      (domain) => domain.getSourcingCursor(),
    );
    return {
      lastPolledAt: cursor.polledAt,
      lastKey: cursor.lastKey,
      backlogCount: this.backlogCount,
      counters: { ...this.counters },
      credentialState: this.credentialState,
    };
  }

  getHealth(): SourcingPollerHealth {
    return {
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
    };
  }

  private async runPoll(): Promise<void> {
    if (this.stopped) return;

    const loaded = await this.loadCredentials();
    this.credentialState = loaded.source;
    if (loaded.credentials === null) {
      // Not provisioned: idle quietly, never an error.
      return;
    }

    const inbox = await this.createInboxClient(loaded);
    const cursor = await this.domainGate.withDomain(
      (domain) => domain.getSourcingCursor(),
    );
    const keys = await inbox.listNewObjects(cursor.lastKey);
    this.backlogCount = keys.length;

    for (const key of keys) {
      if (this.stopped) return;
      const batch = await inbox.fetchNdjson(key);
      await this.processBatchOrThrow(batch);
      await this.domainGate.withDomain((domain) => {
        domain.recordSourcingPoll({ lastKey: key });
      });
      this.backlogCount = Math.max(0, this.backlogCount - 1);
    }

    if (keys.length === 0) {
      // Record the poll time so the status row reflects freshness even when
      // the inbox is quiet.
      await this.domainGate.withDomain((domain) => {
        domain.recordSourcingPoll({ lastKey: cursor.lastKey });
      });
    }
    this.consecutiveFailures = 0;
  }

  /**
   * Processes one file. Throws on the first dispatch failure so the caller
   * leaves the cursor untouched and the next tick retries the whole file
   * (dispatches are idempotent, so partial progress is safe to repeat).
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
      if (mapped.kind === 'intake') {
        await this.domainGate.withDomain((domain) => {
          domain.importCloudSourceEvent({
            command: mapped.command,
            cloudEntityId: mapped.cloudEntityId,
          });
        });
        this.counters.imported += 1;
      } else if (mapped.kind === 'needs-identity') {
        this.counters.needsIdentity += 1;
        this.log(
          `sourcing needs-identity ${mapped.receiptKey} `
          + `(${mapped.channel}, ${mapped.situsAddress?.line1 ?? 'no situs address'})`,
        );
      } else {
        this.counters.scoreUpdates += 1;
      }
    }
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    this.lastFailureAt = this.clock.now();
    const message = error instanceof Error ? error.message : String(error);
    this.log(`sourcing poll failed (attempt kept cursor): ${message}`);
  }
}
