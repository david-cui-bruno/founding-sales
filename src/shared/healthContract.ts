import { z } from 'zod';

const canonicalUtcTimestampSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
);

export const appHealthSchema = z.object({
  appVersion: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  databasePath: z.string().min(1),
  databaseEncrypted: z.literal(true),
  cipherVersion: z.string().min(1),
  fts5Available: z.boolean(),
  pendingJobs: z.number().int().nonnegative(),
  interruptedJobsRecovered: z.number().int().nonnegative(),
  domainStatus: z.enum(['ready', 'blocked']),
  domainReady: z.boolean(),
  domainBlockingViolationCount: z.number().int().nonnegative(),
  domainRepairableIssueCount: z.number().int().nonnegative(),
  domainProjectionRefreshCandidateCount: z.number().int().nonnegative(),
  pendingProjectionRebuilds: z.number().int().nonnegative(),
  domainStartupEvaluatedAt: canonicalUtcTimestampSchema,
});

export type AppHealth = z.infer<typeof appHealthSchema>;
