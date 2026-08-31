import { z } from 'zod';

export const appHealthSchema = z.object({
  appVersion: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  databasePath: z.string().min(1),
  databaseEncrypted: z.literal(true),
  cipherVersion: z.string().min(1),
  fts5Available: z.boolean(),
  pendingJobs: z.number().int().nonnegative(),
  interruptedJobsRecovered: z.number().int().nonnegative(),
});

export type AppHealth = z.infer<typeof appHealthSchema>;
