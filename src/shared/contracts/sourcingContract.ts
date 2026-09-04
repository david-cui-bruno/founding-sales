import { z } from 'zod';

/**
 * Sourcing poller status surface (plan Task 3). Counters are session-scoped
 * process counters, not durable aggregates; the durable state is the cursor
 * row. `backlogCount` is null when unknown (no poll has listed the inbox yet).
 */
export const sourcingCountersSchema = z.object({
  imported: z.number().int().nonnegative(),
  // Re-reads after the schema-9 cursor reset replay receipts; those are
  // counted here, never as fresh imports.
  replayed: z.number().int().nonnegative(),
  needsIdentity: z.number().int().nonnegative(),
  scoreUpdates: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
}).strict();

export const sourcingCredentialStateSchema = z.enum(['keychain', 'file', 'none']);

export type PollExecutionState = {
  state: 'idle' | 'running';
  pollId: string | null;
  startedAt: string | null;
  lastCompletedAt: string | null;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  backlogCount: number | null;
};

export type PollDegradedReason =
  | 'POLL_EXCEEDED_TOTAL_DEADLINE'
  | 'NO_SUCCESS_WITHIN_TWO_CADENCES'
  | 'BACKLOG_PERSISTED_ACROSS_POLLS'
  | 'CREDENTIALS_WITHOUT_COMPLETED_POLL';

export type SourcingPollHealth = {
  status: 'healthy' | 'degraded';
  reasons: PollDegradedReason[];
  state: PollExecutionState;
  lastSuccessAgeMs: number | null;
};

export type FixtureExecutionEvidence = {
  cleanupStarted: boolean;
  cleanupCompleted: boolean;
  replacementStartedAfterCleanup: boolean;
  maxConcurrentExecutions: number;
};

const canonicalUtcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
);

export const pollExecutionStateSchema = z.object({
  state: z.enum(['idle', 'running']),
  pollId: z.string().min(1).nullable(),
  startedAt: canonicalUtcTimestampSchema.nullable(),
  lastCompletedAt: canonicalUtcTimestampSchema.nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastFailureAt: canonicalUtcTimestampSchema.nullable(),
  lastFailureCode: z.string().min(1).nullable(),
  backlogCount: z.number().int().nonnegative().nullable(),
}).strict() as unknown as z.ZodType<PollExecutionState>;

export const pollDegradedReasonSchema: z.ZodType<PollDegradedReason> = z.enum([
  'POLL_EXCEEDED_TOTAL_DEADLINE',
  'NO_SUCCESS_WITHIN_TWO_CADENCES',
  'BACKLOG_PERSISTED_ACROSS_POLLS',
  'CREDENTIALS_WITHOUT_COMPLETED_POLL',
]);

export const sourcingPollHealthSchema = z.object({
  status: z.enum(['healthy', 'degraded']),
  reasons: z.array(pollDegradedReasonSchema),
  state: pollExecutionStateSchema,
  lastSuccessAgeMs: z.number().nonnegative().nullable(),
}).strict() as unknown as z.ZodType<SourcingPollHealth>;

const fixtureExecutionEvidenceSchema = z.object({
  cleanupStarted: z.boolean(),
  cleanupCompleted: z.boolean(),
  replacementStartedAfterCleanup: z.boolean(),
  maxConcurrentExecutions: z.number().int().nonnegative(),
}).strict();

/**
 * Whether the founder has provisioned the shared membership HMAC salt
 * (Task 4). 'none' means membership uploads omit contact_hmacs entirely.
 */
export const sourcingHmacSaltStateSchema = z.enum(['set', 'none']);

export const sourcingStatusSchema = z.object({
  lastPolledAt: z.string().nullable(),
  lastKey: z.string().nullable(),
  backlogCount: z.number().int().nonnegative().nullable(),
  counters: sourcingCountersSchema,
  credentialState: sourcingCredentialStateSchema,
  hmacSaltState: sourcingHmacSaltStateSchema,
  execution: pollExecutionStateSchema,
  health: sourcingPollHealthSchema,
  fixtureExecutionEvidence: fixtureExecutionEvidenceSchema.optional(),
}).strict();

/** Founder-pasted shared salt; never logged, stored via safeStorage only. */
export const setHmacSaltRequestSchema = z.object({
  salt: z.string().trim().min(1).max(512),
}).strict();

export type SourcingCounters = z.infer<typeof sourcingCountersSchema>;
export type SourcingCredentialState = z.infer<typeof sourcingCredentialStateSchema>;
export type SourcingHmacSaltState = z.infer<typeof sourcingHmacSaltStateSchema>;
export type SourcingStatus = z.infer<typeof sourcingStatusSchema>;
export type SetHmacSaltRequest = z.infer<typeof setHmacSaltRequestSchema>;
