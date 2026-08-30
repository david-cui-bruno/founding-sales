import { z } from 'zod';

export const APPLE_TEST_CALL_CONSENT = 'I CONSENT TO THIS TEST CALL' as const;
export const APPLE_TEST_MESSAGE_CONSENT = 'I CONSENT TO THIS TEST MESSAGE' as const;

export const APPLE_SPIKE_IPC_CHANNELS = {
  status: 'apple-spike:status',
  probeCapabilities: 'apple-spike:probe-capabilities',
  requestContacts: 'apple-spike:request-contacts',
  promptAccessibility: 'apple-spike:prompt-accessibility',
  scanRecentNotes: 'apple-spike:scan-recent-notes',
  scanTestMessages: 'apple-spike:scan-test-messages',
  startCallObservation: 'apple-spike:start-call-observation',
  stopCallObservation: 'apple-spike:stop-call-observation',
  sendTestMessage: 'apple-spike:send-test-message',
} as const;

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

const normalizedHandleSchema = z.string().regex(/^\+[1-9]\d{7,14}$/u);
const testMessageBodySchema = z.string().min(1).refine(
  (value) => utf8ByteLength(value) <= 500,
  { message: 'Test message must be at most 500 UTF-8 bytes' },
);

export const probeCapabilitiesActionSchema = z.object({
  action: z.literal('probe_capabilities'),
}).strict();

export const requestContactsActionSchema = z.object({
  action: z.literal('request_contacts'),
}).strict();

export const promptAccessibilityActionSchema = z.object({
  action: z.literal('prompt_accessibility'),
}).strict();

export const scanRecentNotesActionSchema = z.object({
  action: z.literal('scan_recent_notes'),
}).strict();

export const scanTestMessagesActionSchema = z.object({
  action: z.literal('scan_test_messages'),
  normalizedHandle: normalizedHandleSchema,
}).strict();

export const startCallObservationActionSchema = z.object({
  action: z.literal('start_call_observation'),
  confirmation: z.literal(APPLE_TEST_CALL_CONSENT),
}).strict();

export const stopCallObservationActionSchema = z.object({
  action: z.literal('stop_call_observation'),
}).strict();

export const sendTestMessageActionSchema = z.object({
  action: z.literal('send_test_message'),
  normalizedHandle: normalizedHandleSchema,
  body: testMessageBodySchema,
  confirmation: z.literal(APPLE_TEST_MESSAGE_CONSENT),
}).strict();

export const appleSpikeActionSchema = z.discriminatedUnion('action', [
  probeCapabilitiesActionSchema,
  requestContactsActionSchema,
  promptAccessibilityActionSchema,
  scanRecentNotesActionSchema,
  scanTestMessagesActionSchema,
  startCallObservationActionSchema,
  stopCallObservationActionSchema,
  sendTestMessageActionSchema,
]);

export const appleSpikeReadOnlyActionSchema = z.discriminatedUnion('action', [
  probeCapabilitiesActionSchema,
  scanRecentNotesActionSchema,
  scanTestMessagesActionSchema,
]);

export const appleSpikePermissionActionSchema = z.discriminatedUnion('action', [
  requestContactsActionSchema,
  promptAccessibilityActionSchema,
]);

export const appleSpikeManualActionSchema = z.discriminatedUnion('action', [
  startCallObservationActionSchema,
  stopCallObservationActionSchema,
  sendTestMessageActionSchema,
]);

const appleBridgeStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('disabled'),
    reason: z.enum(['unsupported_platform', 'not_packaged_or_configured']),
  }).strict(),
  z.object({ state: z.literal('starting') }).strict(),
  z.object({
    state: z.literal('ready'),
    helperVersion: z.string().min(1).max(64),
    protocolVersion: z.literal(1),
  }).strict(),
  z.object({
    state: z.literal('degraded'),
    code: z.enum([
      'staging_unavailable',
      'helper_resolution_failed',
      'helper_verification_failed',
      'helper_launch_failed',
      'handshake_failed',
      'helper_exited',
      'helper_transport_failed',
      'helper_shutdown_failed',
    ]),
    message: z.string().min(1).max(300),
  }).strict(),
]);

export const appleSpikeStatusSchema = z.object({
  enabled: z.boolean(),
  bridge: appleBridgeStatusSchema,
}).strict();

const unavailableResultSchema = z.object({
  action: z.enum([
    'probe_capabilities',
    'request_contacts',
    'prompt_accessibility',
    'scan_recent_notes',
    'scan_test_messages',
    'start_call_observation',
    'stop_call_observation',
    'send_test_message',
  ]),
  outcome: z.literal('capability_unavailable'),
  message: z.literal('This Apple feasibility operation is unavailable on this Mac.'),
}).strict();

export const appleSpikeResultSchema = z.union([
  z.object({
    action: z.literal('probe_capabilities'),
    outcome: z.literal('completed'),
    capabilities: z.record(z.string(), z.boolean()),
  }).strict(),
  z.object({
    action: z.literal('request_contacts'),
    outcome: z.literal('completed'),
    contactAccess: z.enum(['full', 'limited', 'denied', 'not_determined']),
  }).strict(),
  z.object({
    action: z.literal('prompt_accessibility'),
    outcome: z.literal('completed'),
    accessibilityTrusted: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal('scan_recent_notes'),
    outcome: z.literal('completed'),
    artifactCount: z.number().int().nonnegative().max(501),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    action: z.literal('scan_test_messages'),
    outcome: z.literal('completed'),
    sentCount: z.number().int().nonnegative().max(500),
    receivedCount: z.number().int().nonnegative().max(500),
    latestAt: z.string().datetime().nullable(),
  }).strict(),
  z.object({
    action: z.literal('start_call_observation'),
    outcome: z.literal('completed'),
    observation: z.literal('started'),
  }).strict(),
  z.object({
    action: z.literal('stop_call_observation'),
    outcome: z.literal('completed'),
    observation: z.literal('stopped'),
  }).strict(),
  z.object({
    action: z.literal('send_test_message'),
    outcome: z.literal('completed'),
    delivery: z.literal('sent'),
  }).strict(),
  unavailableResultSchema,
]);

export const scanTestMessagesInputSchema = scanTestMessagesActionSchema.omit({ action: true });
export const startCallObservationInputSchema = startCallObservationActionSchema.omit({ action: true });
export const sendTestMessageInputSchema = sendTestMessageActionSchema.omit({ action: true });

export type AppleSpikeAction = z.infer<typeof appleSpikeActionSchema>;
export type AppleSpikeReadOnlyAction = z.infer<typeof appleSpikeReadOnlyActionSchema>;
export type AppleSpikePermissionAction = z.infer<typeof appleSpikePermissionActionSchema>;
export type AppleSpikeManualAction = z.infer<typeof appleSpikeManualActionSchema>;
export type AppleSpikeStatus = z.infer<typeof appleSpikeStatusSchema>;
export type AppleSpikeResult = z.infer<typeof appleSpikeResultSchema>;
export type AppleSpikeUnavailableResult<Action extends AppleSpikeAction['action']> = {
  action: Action;
  outcome: 'capability_unavailable';
  message: 'This Apple feasibility operation is unavailable on this Mac.';
};
export type AppleSpikeResultFor<Action extends AppleSpikeAction['action']> =
  | Extract<AppleSpikeResult, { action: Action }>
  | AppleSpikeUnavailableResult<Action>;
export type ScanTestMessagesInput = z.infer<typeof scanTestMessagesInputSchema>;
export type StartCallObservationInput = z.infer<typeof startCallObservationInputSchema>;
export type SendTestMessageInput = z.infer<typeof sendTestMessageInputSchema>;
