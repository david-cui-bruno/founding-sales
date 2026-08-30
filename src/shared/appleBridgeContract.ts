import { z } from 'zod';

export const APPLE_BRIDGE_PROTOCOL_VERSION = 1 as const;

const semanticHelperVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export const appleBridgeHelloResultSchema = z.object({
  selectedVersion: z.literal(APPLE_BRIDGE_PROTOCOL_VERSION),
  helperVersion: z.string().min(1).max(64).regex(semanticHelperVersion),
}).strict();

const requestId = z.string().uuid();
const emptyParams = z.object({}).strict();
const opaqueId = z.string().uuid();
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;
const boundedUTF8 = (maximumBytes: number) => z.string().min(1).refine(
  (value) => utf8ByteLength(value) <= maximumBytes,
  { message: `Must be at most ${maximumBytes} UTF-8 bytes` },
);

const helloRequest = z.object({
  v: z.literal(1),
  kind: z.literal('request'),
  id: requestId,
  method: z.literal('bridge.hello'),
  params: z.object({ supportedVersions: z.tuple([z.literal(1)]) }).strict(),
}).strict();

const capabilityRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('capabilities.probe'), params: emptyParams,
}).strict();

const contactsPermissionRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('permissions.requestContacts'), params: emptyParams,
}).strict();

const accessibilityPermissionRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('permissions.promptAccessibility'), params: emptyParams,
}).strict();

const startCallObservationRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('call.observe.start'), params: emptyParams,
}).strict();

const stopCallObservationRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('call.observe.stop'), params: emptyParams,
}).strict();

const armOutgoingRecordingRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('recording.armOutgoing'),
  params: z.object({ callId: opaqueId }).strict(),
}).strict();

const disarmRecordingRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('recording.disarm'),
  params: z.object({ callId: opaqueId }).strict(),
}).strict();

const scanCallRecordingsRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('notes.scanCallRecordings'), params: emptyParams,
}).strict();

const exportCallRecordingRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('notes.exportCallRecording'),
  params: z.object({ artifactId: opaqueId }).strict(),
}).strict();

const sendTestMessageRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('messages.sendTest'),
  params: z.object({
    commandId: opaqueId,
    recipientHandle: boundedUTF8(256),
    body: boundedUTF8(4_000),
    confirmation: z.literal('I CONSENT TO THIS TEST MESSAGE'),
  }).strict(),
}).strict();

const scanTestMessageActivityRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('messages.scanTestActivity'),
  params: z.object({ recipientHandle: boundedUTF8(256) }).strict(),
}).strict();

const shutdownRequest = z.object({
  v: z.literal(1), kind: z.literal('request'), id: requestId,
  method: z.literal('bridge.shutdown'), params: emptyParams,
}).strict();

const bridgeRequestEnvelopeSchema = z.discriminatedUnion('method', [
  helloRequest,
  capabilityRequest,
  contactsPermissionRequest,
  accessibilityPermissionRequest,
  startCallObservationRequest,
  stopCallObservationRequest,
  armOutgoingRecordingRequest,
  disarmRecordingRequest,
  scanCallRecordingsRequest,
  exportCallRecordingRequest,
  sendTestMessageRequest,
  scanTestMessageActivityRequest,
  shutdownRequest,
]);

export const bridgeRequestSchema = bridgeRequestEnvelopeSchema.superRefine((request, context) => {
  if (request.method === 'messages.sendTest' && request.params.commandId.toLowerCase() === request.id.toLowerCase()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['params', 'commandId'],
      message: 'Command ID must be distinct from the envelope request ID',
    });
  }
});

export const bridgeErrorCodeSchema = z.enum([
  'protocol_mismatch',
  'invalid_request',
  'permission_denied',
  'capability_unavailable',
  'identity_unresolved',
  'control_not_found',
  'recording_verification_failed',
  'artifact_not_found',
  'schema_unsupported',
  'timeout',
  'internal',
]);

export const bridgeResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    v: z.literal(1), kind: z.literal('response'), id: requestId,
    ok: z.literal(true), result: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    v: z.literal(1), kind: z.literal('response'), id: requestId,
    ok: z.literal(false),
    error: z.object({
      code: bridgeErrorCodeSchema,
      message: z.string().min(1).max(300),
      retryable: z.boolean(),
    }).strict(),
  }).strict(),
]);

export const bridgeEventSchema = z.object({
  v: z.literal(1), kind: z.literal('event'), seq: z.number().int().nonnegative(),
  event: z.enum([
    'bridge.ready', 'capability.changed', 'call.stateChanged',
    'call.identityResolved', 'call.identityUnresolved', 'recording.attempted',
    'recording.verified', 'recording.failed', 'notes.artifactDiscovered',
    'notes.exportCompleted', 'notes.transcriptUnavailable',
    'messages.activityObserved', 'bridge.warning',
  ]),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;
export type AppleBridgeHelloResult = z.infer<typeof appleBridgeHelloResultSchema>;
