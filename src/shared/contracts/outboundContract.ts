import { z } from 'zod';
import {
  mutationReceiptSchema,
  outboundAuthorizationReasonCodeSchema,
  personIdSchema,
  salesCycleIdSchema,
  type MutationReceipt,
  type OutboundAuthorizationReasonCode,
} from './commonContract';

export type OutboundChannel = 'call' | 'text' | 'email';
export type OutboundRequest = Readonly<{
  commandId: string;
  channel: OutboundChannel;
  personId: string;
  salesCycleId: string;
  contactMethodId: string;
  expectedContactSnapshot: string;
}>;
export type OutboundStatus = 'handoff_accepted' | 'refused' | 'unavailable' | 'unknown';
/**
 * `manual_dial` (D6) is the closed reason a hand-dialed attempt carries. The founder read the
 * number off the call card and dialed it himself, so no automated channel was used: the status
 * stays `unavailable` and this code says why it is unavailable rather than leaving it as the
 * vague `channel_unavailable`. It is never `handoff_accepted`: nothing accepted a handoff, no
 * `tel:` URI was opened and the helper was never asked. `hasConsistentReason` below forbids a
 * reason on `handoff_accepted` anyway, so claiming acceptance would have to erase the one fact
 * that distinguishes a hand dial from a helper dial in every receipt that carries it.
 */
export type OutboundReason =
  | 'stale_contact' | 'invalid_target' | 'cycle_not_executable'
  | 'command_conflict' | 'command_evidence_invalid' | 'outbound_busy'
  | 'channel_unavailable' | 'phone_route_unverified' | 'inbound_safety_unwired'
  | 'workspace_inactive' | 'operation_interrupted' | 'handoff_uncertain'
  | 'result_not_persisted' | 'manual_dial'
  | OutboundAuthorizationReasonCode;
export type HandoffResult = Readonly<{
  status: OutboundStatus;
  reasonCode: OutboundReason | null;
}>;
export type OutboundReceipt = HandoffResult & Readonly<{
  commandId: string;
  channel: OutboundChannel;
  mutation: MutationReceipt;
}>;
export type CapabilityReason =
  | 'phone_route_unverified' | 'inbound_safety_unwired' | 'workspace_inactive'
  | 'not_integrated' | 'channel_unavailable';
export type Capability = Readonly<{
  state: 'available' | 'unavailable';
  reasonCode: CapabilityReason | null;
}>;
export type OutboundCapabilities = Readonly<{
  phoneHandoff: Capability;
  callObservation: Capability;
  recording: Capability;
  messagesSend: Capability;
  gmailSend: Capability;
  managedAudioImport: Capability;
  appleTranscriptExtraction: Capability;
  localDrafts: true;
}>;
export type OutboundAttemptSummary = Readonly<{
  commandId: string;
  channel: OutboundChannel;
  contactMethodId: string;
  requestedAt: string;
  manualActivityId: string | null;
  status: OutboundStatus;
  reasonCode: OutboundReason | null;
}>;

const outboundChannelSchema = z.enum(['call', 'text', 'email']);
const outboundStatusSchema = z.enum(['handoff_accepted', 'refused', 'unavailable', 'unknown']);
const outboundReasonSchema = z.enum([
  'stale_contact', 'invalid_target', 'cycle_not_executable',
  'command_conflict', 'command_evidence_invalid', 'outbound_busy',
  'channel_unavailable', 'phone_route_unverified', 'inbound_safety_unwired',
  'workspace_inactive', 'operation_interrupted', 'handoff_uncertain', 'result_not_persisted',
  'manual_dial',
  ...outboundAuthorizationReasonCodeSchema.options,
]);

export const outboundRequestSchema = z.object({
  commandId: z.string().uuid(),
  channel: outboundChannelSchema,
  personId: personIdSchema,
  salesCycleId: salesCycleIdSchema,
  contactMethodId: z.string().min(1),
  expectedContactSnapshot: z.string().length(64).regex(/^[a-f0-9]{64}$/),
}).strict();

const resultShape = { status: outboundStatusSchema, reasonCode: outboundReasonSchema.nullable() };
// Execution acknowledgement is not evidence of delivery or occurrence.
// Zod infers nullable object keys as optional under this repository's
// non-strict-null tsconfig. Runtime schemas still require the key and null.
function hasConsistentReason(result: { status: OutboundStatus; reasonCode?: OutboundReason | null }): boolean {
  return (result.status === 'handoff_accepted') === (result.reasonCode === null);
}
const reasonIssue = { message: 'Status and reason must agree.', path: ['reasonCode'] };

export const handoffResultSchema = z.object(resultShape).strict()
  .refine(hasConsistentReason, reasonIssue);
export const outboundReceiptSchema = z.object({
  ...resultShape,
  commandId: z.string().uuid(),
  channel: outboundChannelSchema,
  mutation: mutationReceiptSchema,
}).strict().refine(hasConsistentReason, reasonIssue);

export const capabilitySchema = z.object({
  state: z.enum(['available', 'unavailable']),
  reasonCode: z.enum([
    'phone_route_unverified', 'inbound_safety_unwired', 'workspace_inactive',
    'not_integrated', 'channel_unavailable',
  ]).nullable(),
}).strict().refine(
  (capability) => (capability.state === 'available') === (capability.reasonCode === null),
  reasonIssue,
);

export const outboundCapabilitiesSchema = z.object({
  phoneHandoff: capabilitySchema,
  callObservation: capabilitySchema,
  recording: capabilitySchema,
  messagesSend: capabilitySchema,
  gmailSend: capabilitySchema,
  managedAudioImport: capabilitySchema,
  appleTranscriptExtraction: capabilitySchema,
  localDrafts: z.literal(true),
}).strict();

export const outboundAttemptSummarySchema = z.object({
  ...resultShape,
  commandId: z.string().uuid(),
  channel: outboundChannelSchema,
  contactMethodId: z.string().min(1),
  requestedAt: z.string().datetime({ offset: true }),
  manualActivityId: z.string().min(1).nullable(),
}).strict().refine(hasConsistentReason, reasonIssue);
