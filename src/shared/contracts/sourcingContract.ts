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

export const sourcingStatusSchema = z.object({
  lastPolledAt: z.string().nullable(),
  lastKey: z.string().nullable(),
  backlogCount: z.number().int().nonnegative().nullable(),
  counters: sourcingCountersSchema,
  credentialState: sourcingCredentialStateSchema,
}).strict();

export type SourcingCounters = z.infer<typeof sourcingCountersSchema>;
export type SourcingCredentialState = z.infer<typeof sourcingCredentialStateSchema>;
export type SourcingStatus = z.infer<typeof sourcingStatusSchema>;
