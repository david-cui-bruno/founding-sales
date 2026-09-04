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
export const outboundAuthorizationReasonCodeSchema = z.enum([
  'person_or_handle_opted_out',
  'channel_contact_kind_mismatch',
  'contact_validation_unusable',
  'federal_status_unknown',
  'federal_dnc_listed',
  'federal_evidence_stale',
  'federal_area_code_mismatch',
  'tcpa_status_unknown',
  'tcpa_blocked',
  'jurisdiction_unknown',
  'jurisdiction_blocked',
  'state_registration_missing',
  'state_dnc_subscription_missing',
  'state_consent_rule_unknown',
  'outside_recipient_window',
]);

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
  label: z.string().min(1),
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
export type OutboundAuthorizationReasonCode = z.infer<
  typeof outboundAuthorizationReasonCodeSchema
>;
export type LeadPriorityContext = z.infer<typeof leadPriorityContextSchema>;
export type PrimaryAction = z.infer<typeof primaryActionSchema>;
export type MutationReceipt = z.infer<typeof mutationReceiptSchema>;
