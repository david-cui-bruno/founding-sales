import type { SessionQueryable } from '../db/queryable.ts';
import type { WorkspaceScope } from '../db/workspaceScope.ts';
import { workspaceScope } from '../db/workspaceScope.ts';
import { IDEMPOTENCY_PROTECTIONS, JOB_KIND_PROTECTION, isJobKind, type IdempotencyProtection, type JobKind } from './jobKinds.ts';
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
 */

export interface JobHandlerInput {
  /** One backend connection. The runner has already opened a transaction where it should. */
  readonly session: SessionQueryable;
  /** Built from the claimed row's `workspace_id`, so everything the handler touches is scoped. */
  readonly scope: WorkspaceScope;
  readonly job: ClaimedJob;
}

export interface JobHandler {
  readonly kind: JobKind;
  readonly protection: IdempotencyProtection;
  /** Attempts before the job is dead. Four by default: see docs/decisions/g5-retry-ladder.md. */
  readonly maxAttempts: number;
  readonly leaseSeconds: number;
  handle(input: JobHandlerInput): Promise<void>;
}

export class HandlerRegistryError extends Error {
  constructor(
    readonly code: 'KIND_UNKNOWN' | 'KIND_ALREADY_REGISTERED' | 'PROTECTION_MISMATCH' | 'ATTEMPTS_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'HandlerRegistryError';
  }
}

export class HandlerRegistry {
  readonly #handlers = new Map<JobKind, JobHandler>();

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
    this.#handlers.set(handler.kind, handler);
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
}

/** The scope a handler runs under: the system, acting for the claimed row's workspace. */
export function scopeForJob(job: ClaimedJob): WorkspaceScope {
  return workspaceScope(job.workspaceId, { kind: 'system', component: 'worker' });
}

export { IDEMPOTENCY_PROTECTIONS };
export type { IdempotencyProtection, JobKind };
