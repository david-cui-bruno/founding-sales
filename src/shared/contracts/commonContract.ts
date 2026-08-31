import { z } from 'zod';

export const personIdSchema = z.string().min(1);
export const salesCycleIdSchema = z.string().min(1);
export const lifecycleStageSchema = z.enum([
  'unreviewed',
  'ready',
  'contacted',
  'interviewed',
  'offered',
  'won',
  'lost_nurture',
]);
export const prioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export const fitBandSchema = z.enum(['low', 'medium', 'high']);
export const timingBandSchema = z.enum(['cold', 'warm', 'hot']);
export const reachabilitySchema = z.enum(['direct', 'indirect', 'none']);

export const leadPriorityContextSchema = z.object({
  priority: prioritySchema,
  fitPoints: z.number().int().min(0).max(30),
  fitBand: fitBandSchema,
  timingValue: z.number().min(0).max(40),
  timingBand: timingBandSchema,
  reachability: reachabilitySchema,
  dataConfidence: z.number().int().min(0).max(10),
}).strict();

export const primaryActionSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  channel: z.enum(['call', 'text', 'email', 'review', 'onboarding']),
  dueAt: z.string().datetime({ offset: true }),
  label: z.string().min(1),
  overdue: z.boolean(),
}).strict();

export const mutationReceiptSchema = z.object({
  revision: z.number().int().nonnegative(),
  affectedPersonIds: z.array(personIdSchema),
  affectedSalesCycleIds: z.array(salesCycleIdSchema),
}).strict();

export type LifecycleStage = z.infer<typeof lifecycleStageSchema>;
export type Priority = z.infer<typeof prioritySchema>;
export type FitBand = z.infer<typeof fitBandSchema>;
export type TimingBand = z.infer<typeof timingBandSchema>;
export type Reachability = z.infer<typeof reachabilitySchema>;
export type LeadPriorityContext = z.infer<typeof leadPriorityContextSchema>;
export type PrimaryAction = z.infer<typeof primaryActionSchema>;
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;
