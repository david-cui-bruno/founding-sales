import { z } from 'zod';

/**
 * Sourcing poller status surface (plan Task 3). Counters are session-scoped
 * process counters, not durable aggregates; the durable state is the cursor
 * row. `backlogCount` is null when unknown (no poll has listed the inbox yet).
 */
export const sourcingCountersSchema = z.object({
  imported: z.number().int().nonnegative(),
  needsIdentity: z.number().int().nonnegative(),
  scoreUpdates: z.number().int().nonnegative(),
  quarantined: z.number().int().nonnegative(),
}).strict();

export const sourcingCredentialStateSchema = z.enum(['keychain', 'file', 'none']);

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
