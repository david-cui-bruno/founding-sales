import { z } from 'zod';

import { personIdSchema, salesCycleIdSchema } from './commonContract';

export const metricIdSchema = z.enum([
  'interviews', 'offers', 'wins', 'offer_rate', 'win_rate', 'jobs_requested', 'jobs_filled', 'fill_rate',
  'new_mrr', 'founding_customers', 'design_partner_fitness', 'overdue_actions', 'invalid_action_cycles',
]);
export const metricSchema = z.object({
  id: metricIdSchema, label: z.string(), displayValue: z.string(), numericValue: z.number().nullable(),
  target: z.number().nullable(), priorDelta: z.number().nullable(), numerator: z.number().int().nonnegative().nullable(),
  denominator: z.number().int().nonnegative().nullable(), drilldownCount: z.number().int().nonnegative(),
}).strict();
export const jobRequestSchema = z.object({
  id: z.string(), salesCycleId: salesCycleIdSchema.nullable(), requestedAt: z.string().datetime({ offset: true }),
  status: z.enum(['requested', 'filled', 'cancelled']), contractorAcceptedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export const fridayReportSchema = z.object({
  periodStartsAt: z.string().datetime({ offset: true }), periodEndsAt: z.string().datetime({ offset: true }),
  asOf: z.string().datetime({ offset: true }), metrics: z.array(metricSchema),
  sourceRows: z.array(z.object({ source: z.string(), interviews: z.number().int().nonnegative(), offers: z.number().int().nonnegative(), wins: z.number().int().nonnegative() }).strict()),
  jobs: z.array(jobRequestSchema), revision: z.number().int().nonnegative(),
}).strict();

/**
 * Week selector for the scoreboard: 0 is the current week, negative values
 * walk back one Monday-anchored week per step. Future weeks are meaningless
 * (no events can exist yet), so positive offsets are rejected.
 */
export const fridayReportRequestSchema = z.object({
  weekOffset: z.number().int().min(-520).max(0),
}).strict();

export const metricDrilldownRequestSchema = z.object({
  metricId: metricIdSchema,
}).strict();

export const metricDrilldownSchema = z.object({
  metricId: metricIdSchema,
  label: z.string().min(1),
  rows: z.array(z.object({
    id: z.string().min(1),
    personId: personIdSchema.nullable(),
    salesCycleId: salesCycleIdSchema.nullable(),
    label: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }).nullable(),
    detail: z.string().nullable(),
  }).strict()),
}).strict();

export const createJobRequestSchema = z.object({
  jobId: z.string().min(1),
  salesCycleId: salesCycleIdSchema.nullable(),
  requestedAt: z.string().datetime({ offset: true }),
}).strict();

export const fillJobRequestSchema = z.object({
  jobId: z.string().min(1),
  contractorAcceptedAt: z.string().datetime({ offset: true }),
}).strict();

export const cancelJobRequestSchema = z.object({
  jobId: z.string().min(1),
}).strict();

export type MetricId = z.infer<typeof metricIdSchema>;
export type Metric = z.infer<typeof metricSchema>;
export type JobRequest = z.infer<typeof jobRequestSchema>;
export type FridayReport = z.infer<typeof fridayReportSchema>;
export type FridayReportRequest = z.infer<typeof fridayReportRequestSchema>;
export type MetricDrilldownRequest = z.infer<typeof metricDrilldownRequestSchema>;
export type MetricDrilldown = z.infer<typeof metricDrilldownSchema>;
export type CreateJobRequest = z.infer<typeof createJobRequestSchema>;
export type FillJobRequest = z.infer<typeof fillJobRequestSchema>;
export type CancelJobRequest = z.infer<typeof cancelJobRequestSchema>;
