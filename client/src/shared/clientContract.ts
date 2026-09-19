import { z } from 'zod';
import {
  attemptKindSchema,
  diagnosticsViewSchema,
  settingsViewSchema,
  todayViewSchema,
  v1CommandReceiptSchema,
  v1CommandSchema,
  v1FirmViewSchema,
  weekViewSchema,
  type SettingsView,
  type TodayView,
  type V1FirmView,
  type WeekView,
} from '../../../src/shared/contracts/v1Contract';

/**
 * What crosses the client's own IPC bridge (`window.callie`), validated on both sides. The worker's shape
 * is the shared `/v1` contract; this file only adds the client's envelopes around it: the pairing state,
 * the honest outcomes of a read or a command (ok, unavailable, unauthenticated, unpaired) and the sentences
 * the renderer shows. No token ever appears in any of these shapes.
 */
const instant = z.iso.datetime({ precision: 3 });
const uuid = z.string().uuid();
const slug = z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/).max(40);

export const CLIENT_CHANNELS = {
  status: 'client:status',
  pair: 'client:pair',
  get: 'client:get',
  command: 'client:command',
  unpair: 'client:unpair',
  /** Hand one number to Phone.app (slice S2). Handing off is not calling: David presses the button. */
  dial: 'client:dial',
  /** The local Phone.app setup proof on this Mac (slice S5): read it, confirm it, clear it. */
  phoneSetup: 'client:phone-setup',
} as const;

export const clientStatusSchema = z.strictObject({
  state: z.enum(['unpaired', 'paired']),
  /** The worker's https origin (or plain http to the loopback interface, for the stub); null when unconfigured. */
  endpoint: z.string().nullable(),
  endpointSource: z.enum(['environment', 'file', 'none']),
  deviceId: uuid.nullable(),
  workspaceId: z.string().nullable(),
  pairedAt: instant.nullable(),
  /** The plain sentence the Pair page shows after the worker refused the stored token and the client forgot it. */
  notice: z.string().nullable(),
});
export type ClientStatus = z.infer<typeof clientStatusSchema>;

export const pairRequestSchema = z.strictObject({ codeOrPath: z.string().min(1).max(4096) });
export type PairRequest = z.infer<typeof pairRequestSchema>;
export const pairResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('paired'), status: clientStatusSchema, codeFileDeleted: z.boolean() }),
  z.strictObject({ outcome: z.literal('refused'), reason: slug, sentence: z.string() }),
  z.strictObject({ outcome: z.literal('unavailable'), reason: slug, sentence: z.string() }),
]);
export type PairResult = z.infer<typeof pairResultSchema>;

export const viewPathSchema = z.enum(['/v1/diagnostics', '/v1/today', '/v1/settings', '/v1/firms', '/v1/week']);
export type ViewPath = z.infer<typeof viewPathSchema>;
export const readRequestSchema = z.strictObject({ view: viewPathSchema, kind: attemptKindSchema.optional(),
  /** The firm the Firm view names (S2); refused on any other view. */
  firmId: z.string().min(1).max(200).optional() })
  .refine(request => (request.view === '/v1/firms') === (request.firmId !== undefined), 'firmId belongs to the Firm view');
export type ReadRequest = z.infer<typeof readRequestSchema>;

const unavailableSchema = z.strictObject({
  outcome: z.literal('unavailable'),
  reason: slug,
  status: z.number().int().nullable(),
  sentence: z.string(),
});
const unauthenticatedSchema = z.strictObject({
  outcome: z.literal('unauthenticated'),
  reason: z.enum(['device_revoked', 'device_expired']).nullable(),
  /** True when the client forgot its token because the worker named the reason; the Pair page follows. */
  cleared: z.boolean(),
  sentence: z.string(),
});
const unpairedSchema = z.strictObject({ outcome: z.literal('unpaired'), sentence: z.string() });

/** Where an ok view came from: the worker just now, or the last good `/v1/today` file this Mac kept when the worker did not answer. */
export const viewSourceSchema = z.enum(['worker', 'last_good']);
export type ViewSource = z.infer<typeof viewSourceSchema>;
export const readResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('ok'), fetchedAt: instant, view: z.unknown(), source: viewSourceSchema.optional(),
    /** For a last-good answer: the sentence of the failed read it stands in for. */
    sentence: z.string().optional() }),
  unavailableSchema,
  unauthenticatedSchema,
  unpairedSchema,
]);
export type ReadResult<View = unknown> =
  | { outcome: 'ok'; fetchedAt: string; view: View; source?: ViewSource; sentence?: string }
  | z.infer<typeof unavailableSchema>
  | z.infer<typeof unauthenticatedSchema>
  | z.infer<typeof unpairedSchema>;

export const commandResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('ok'), receipt: v1CommandReceiptSchema }),
  unavailableSchema,
  unauthenticatedSchema,
  unpairedSchema,
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

/** The Today view is the contract's own schema (slice S1): the four lanes as cards, or `{ list: null, reason }`. */
export { todayViewSchema, type TodayView };
/** The Settings view is the contract's own schema: postures and reference texts (S1b) and every S5 section. */
export { settingsViewSchema, type SettingsView };
/** The Week view is the contract's own schema (S5): the last seven Eastern days from the permanent records. */
export { weekViewSchema, type WeekView };
export const lastGoodTodaySchema = z.strictObject({ fetchedAt: instant, view: todayViewSchema });
export type LastGoodToday = z.infer<typeof lastGoodTodaySchema>;

/** The view schema for each path the client reads. */
export const viewSchemas = {
  '/v1/diagnostics': diagnosticsViewSchema,
  '/v1/today': todayViewSchema,
  '/v1/settings': settingsViewSchema,
  '/v1/firms': v1FirmViewSchema,
  '/v1/week': weekViewSchema,
} as const;

/**
 * Handing one number to Phone.app (slice S2). Every refusal is named and carries the plain sentence the card shows:
 * a dial the client refuses is never a silent nothing. `unknown` means the handoff may have reached Phone.app and
 * may not have; it is never reported as a call, and only `log_call_outcome` says what happened on the line.
 */
export const dialRequestSchema = z.strictObject({ firmId: z.string().min(1).max(200), number: z.string().min(1).max(60) });
export type DialRequest = z.infer<typeof dialRequestSchema>;
export const DIAL_REFUSALS = ['no_view', 'view_stale', 'card_unknown', 'dial_not_allowed', 'number_mismatch',
  'number_excluded', 'suppressed', 'route_unavailable', 'handoff_uncertain'] as const;
export const dialRefusalSchema = z.enum(DIAL_REFUSALS);
export type DialRefusal = z.infer<typeof dialRefusalSchema>;
export const DIAL_REFUSAL_SENTENCES: Readonly<Record<DialRefusal, string>> = Object.freeze({
  no_view: 'This Mac has not read a list yet, so there is no card to dial from.',
  view_stale: 'This list is more than two minutes old. Refresh it and try again.',
  card_unknown: 'That firm is not on the list this Mac is showing.',
  dial_not_allowed: 'The worker holds this firm: it says the dial is not allowed right now.',
  number_mismatch: 'That number is not the one on the card. Refresh the list and try again.',
  number_excluded: 'That is not a number this Mac will ever dial.',
  suppressed: 'This firm is suppressed. It is never called again.',
  route_unavailable: 'The Phone.app handoff is not set up on this Mac, so nothing was dialed.',
  handoff_uncertain: 'The handoff may or may not have reached Phone.app. Check Phone.app before dialing again.',
});
/**
 * The Phone.app setup proof this Mac holds (slice S5). The proof file never leaves the Mac: what crosses this
 * bridge is its state and the sha256 digest the worker records beside David's confirmation, never the proof.
 *
 *   configured        the stored proof matches the helper this Mac would actually launch
 *   needs_confirmation a helper is there and David has not confirmed it (or has confirmed a different one)
 *   unconfigured      no proof stored and none needed right now
 *   unavailable       this Mac has no phone route at all: an unpackaged run, or no helper to inspect
 *
 * Confirming writes the proof and nothing else. It is not permission to dial: the launcher still checks the
 * helper's signature and the excluded-number rules at the moment a number is handed over.
 */
export const PHONE_SETUP_STATES = ['configured', 'needs_confirmation', 'unconfigured', 'unavailable'] as const;
export const phoneSetupActionSchema = z.strictObject({ action: z.enum(['read', 'confirm', 'clear']) });
export type PhoneSetupAction = z.infer<typeof phoneSetupActionSchema>;
export const clientPhoneSetupSchema = z.strictObject({
  state: z.enum(PHONE_SETUP_STATES),
  confirmedAt: instant.nullable(),
  /** The sha256 of the confirmed proof's fingerprint, which is exactly what `confirm_phone_setup` sends. */
  proofDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  /** The digest of the helper this Mac would launch now, when there is one to inspect. */
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  sentence: z.string(),
});
export type ClientPhoneSetup = z.infer<typeof clientPhoneSetupSchema>;
export const PHONE_SETUP_SENTENCES: Readonly<Record<z.infer<typeof clientPhoneSetupSchema>['state'], string>> = Object.freeze({
  configured: 'This Mac holds a confirmed setup proof for the helper it would launch.',
  needs_confirmation: 'This Mac can reach a phone helper, but the setup is not confirmed. Confirm it before dialing.',
  unconfigured: 'This Mac holds no setup proof.',
  unavailable: 'This Mac has no phone route: there is no packaged helper to inspect, so nothing can be confirmed here.',
});

export const dialResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('handed_off'), number: z.string().min(1).max(60) }),
  z.strictObject({ outcome: z.literal('refused'), reason: dialRefusalSchema, sentence: z.string() }),
  z.strictObject({ outcome: z.literal('unknown'), reason: z.literal('handoff_uncertain'), sentence: z.string() }),
]);
export type DialResult = z.infer<typeof dialResultSchema>;

export { attemptKindSchema, diagnosticsViewSchema, v1CommandSchema, v1FirmViewSchema, type V1FirmView };
export const ATTEMPT_KINDS = attemptKindSchema.options;
