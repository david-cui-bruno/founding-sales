import type { SessionQueryable } from '../db/queryable.ts';
import type { WorkspaceScope } from '../db/workspaceScope.ts';
import { workspaceScope } from '../db/workspaceScope.ts';
import {
  IDEMPOTENCY_PROTECTIONS,
  JOB_CLASSES,
  JOB_KIND_CLASS,
  JOB_KIND_PROTECTION,
  isJobKind,
  jobClassOf,
  type IdempotencyProtection,
  type JobClass,
  type JobKind,
} from './jobKinds.ts';
import type { ClaimedJob } from './jobStore.ts';

/**
 * The handler registry (specification 13.2: "Jobs are at least once. Every handler is
 * protected by business uniqueness, a monotonic fencing token, or the outbound
 * at-most-once fence").
 *
 * Declaring the protection is not documentation. The runner reads it and behaves
 * differently for each: a `fencing_token` handler is wrapped in a transaction that
 * locks its own job row by token first, a `business_uniqueness` handler is committed
 * together with its completion, and an `outbound_fence` handler is run outside the
 * completion transaction because the thing it does cannot be rolled back. A kind that
 * forgets to declare one cannot be registered.
 *
 * The registry also carries the lane each kind runs in (`jobKinds.ts`, `JOB_KIND_CLASS`),
 * because the runner's slots claim by lane and a kind nobody classified would be a kind
 * no slot ever claims. Registering one refuses startup, by name.
 */

export interface JobHandlerInput {
  /** One backend connection. The runner has already opened a transaction where it should. */
  readonly session: SessionQueryable;
  /** Built from the claimed row's `workspace_id`, so everything the handler touches is scoped. */
  readonly scope: WorkspaceScope;
  readonly job: ClaimedJob;
}

/**
 * What a re-entrant handler returns after one bounded unit of work.
 *
 * A handler that returns nothing did the whole job and the runner completes it, which
 * is every handler today. A handler that returns a chunk is asking to be called again:
 * the runner commits the work and `progress` together, hands the cursor back through
 * `job.payload.progress`, and keeps calling while the lease has time left. `done: true`
 * is the last chunk and completes the job. See `apps/worker/src/runner/jobRunner.ts`.
 */
export interface JobChunk {
  /** The cursor the next call resumes from. JSON, stored in `payload.progress`. */
  readonly progress: Readonly<Record<string, unknown>>;
  readonly done: boolean;
}

export function isJobChunk(value: unknown): value is JobChunk {
  return typeof value === 'object' && value !== null && 'progress' in value && 'done' in value;
}

export interface JobHandler {
  readonly kind: JobKind;
  readonly protection: IdempotencyProtection;
  /** Attempts before the job is dead. Four by default: see docs/decisions/g5-retry-ladder.md. */
  readonly maxAttempts: number;
  readonly leaseSeconds: number;
  handle(input: JobHandlerInput): Promise<void | JobChunk>;
}

export class HandlerRegistryError extends Error {
  constructor(
    readonly code:
      | 'KIND_UNKNOWN'
      | 'KIND_ALREADY_REGISTERED'
      | 'PROTECTION_MISMATCH'
      | 'ATTEMPTS_INVALID'
      | 'CLASS_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'HandlerRegistryError';
  }
}

export interface HandlerRegistryOptions {
  /**
   * The lane table. A parameter with exactly one production value, so the refusal a
   * total `Record<JobKind, JobClass>` makes unreachable in TypeScript still has a test:
   * the failure this guards against arrives with a kind the compiler never saw.
   */
  readonly classOf?: ((kind: JobKind) => JobClass | undefined) | undefined;
}

export class HandlerRegistry {
  readonly #handlers = new Map<JobKind, JobHandler>();
  readonly #classes = new Map<JobKind, JobClass>();
  readonly #classOf: (kind: JobKind) => JobClass | undefined;

  constructor(options: HandlerRegistryOptions = {}) {
    this.#classOf = options.classOf ?? jobClassOf;
  }

  register(handler: JobHandler): this {
    if (!isJobKind(handler.kind)) {
      throw new HandlerRegistryError('KIND_UNKNOWN', `${handler.kind} is not a job kind of Appendix C`);
    }
    if (this.#handlers.has(handler.kind)) {
      throw new HandlerRegistryError('KIND_ALREADY_REGISTERED', `${handler.kind} already has a handler`);
    }
    // Appendix C names the protection for each kind. A handler may not choose another
    // one: the table is the contract, and disagreeing with it silently is how a
    // duplicate send gets shipped.
    if (JOB_KIND_PROTECTION[handler.kind] !== handler.protection) {
      throw new HandlerRegistryError(
        'PROTECTION_MISMATCH',
        `Appendix C protects ${handler.kind} by ${JOB_KIND_PROTECTION[handler.kind]}, not ${handler.protection}`,
      );
    }
    if (!Number.isInteger(handler.maxAttempts) || handler.maxAttempts < 1) {
      throw new HandlerRegistryError('ATTEMPTS_INVALID', 'a handler runs at least once before it is dead');
    }
    // No lane, no slot: an unclassified kind would sit in the queue for ever while
    // every slot claimed around it. Refusing here refuses the process.
    const jobClass = this.#classOf(handler.kind);
    if (jobClass === undefined) {
      throw new HandlerRegistryError(
        'CLASS_MISSING',
        `${handler.kind} has no job class; classify it urgent or bulk in JOB_KIND_CLASS`,
      );
    }
    this.#handlers.set(handler.kind, handler);
    this.#classes.set(handler.kind, jobClass);
    return this;
  }

  get(kind: string): JobHandler | undefined {
    return isJobKind(kind) ? this.#handlers.get(kind) : undefined;
  }

  kinds(): JobKind[] {
    return [...this.#handlers.keys()];
  }

  all(): JobHandler[] {
    return [...this.#handlers.values()];
  }

  /** The lane a registered kind runs in. */
  classOf(kind: JobKind): JobClass | undefined {
    return this.#classes.get(kind);
  }

  /** The registered kinds of one lane, in registration order. What a slot claims. */
  kindsOfClass(jobClass: JobClass): JobKind[] {
    return [...this.#classes.entries()].filter(([, value]) => value === jobClass).map(([kind]) => kind);
  }

  /** Every registered kind by lane. The list a test reads to prove nothing is unclassified. */
  classes(): Readonly<Record<JobClass, JobKind[]>> {
    return Object.freeze(
      Object.fromEntries(JOB_CLASSES.map(jobClass => [jobClass, this.kindsOfClass(jobClass)])) as Record<
        JobClass,
        JobKind[]
      >,
    );
  }
}

/** The scope a handler runs under: the system, acting for the claimed row's workspace. */
export function scopeForJob(job: ClaimedJob): WorkspaceScope {
  return workspaceScope(job.workspaceId, { kind: 'system', component: 'worker' });
}

export { IDEMPOTENCY_PROTECTIONS, JOB_CLASSES, JOB_KIND_CLASS };
export type { IdempotencyProtection, JobClass, JobKind };
