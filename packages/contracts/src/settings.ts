import { DEFAULT_MEETING_AUTO_RECORDING, meetingAutoRecordingSettingSchema } from './meetingAutoRecording.ts';
import { z } from 'zod';
import { DEFAULT_MEETING_TRANSCRIPTION, meetingTranscriptionSettingSchema } from './meetingTranscription.ts';
import { commandIdSchema } from './auth.ts';
import { clientVersionRangeSchema, semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';

/**
 * The wire contract of administrative configuration, the dashboard and Diagnostics
 * (specification 10.1, 13.3, 13.4, 16.2, Appendix F).
 *
 * It lives in `@fss/contracts` for the same reason G4's dial vocabulary does: the
 * Electron client renders the settings forms, the dashboard and the Diagnostics page,
 * and it may not depend on `@fss/domain` (14.2). A vocabulary it cannot import is a
 * vocabulary it re-types, and a re-typed enum drifts.
 *
 * Two rules shape everything below.
 *
 * **A setting's value is validated by its key's schema, not by the caller.** The
 * update command carries `settingKey` and an opaque `value`, and the server picks the
 * schema from the key. A client cannot choose which validation applies to its own
 * payload.
 *
 * **Bounds that exist for safety are in the schema, not only in a check.** The
 * server applies the key's schema to the value after choosing the schema by key, so a
 * request outside a bound is refused with `invalid_value` and writes no version.
 */

// ---------------------------------------------------------------------------
// The setting keys
// ---------------------------------------------------------------------------

/**
 * Every configuration slice this lane owns and versions.
 *
 * State postures, calling windows, suppression, research limits and thresholds,
 * memberships, devices, mailboxes and the **workspace holiday calendar** are
 * configuration too, and they are *not* here: each already has, or is getting, its
 * own versioned table and its own commands, owned by the lane that built it. Copying
 * them into a second store would give the workspace two answers for the same
 * question. The settings surface reads them through their own endpoints; see
 * `docs/greenfield/settings.md`.
 *
 * Two slices were briefly here and were removed before publication, for the same
 * reason in two shapes. G8's migration 0012 owns `workspace_holiday_calendars`,
 * because a business-day delay freezes the calendar *version* on to every stored due
 * instant and a jsonb slice a later save rewrites cannot be an immutable version.
 * G7-2's migration 0010 owns `mailbox_send_ramp` and `sending_domains`, because the
 * per-mailbox cap and the authentication flags carry row-level CHECKs — 75 by
 * command and 100 by constraint, and no enabling without SPF, DKIM, DMARC and a
 * reviewed postmaster — that a jsonb blob cannot express. See
 * `docs/decisions/g9-two-slices-that-belong-to-other-lanes.md`.
 */
export const SETTING_KEYS = ['business_time_zone', 'sending_enabled', 'postal_address'] as const;
export type ActiveSettingKey = (typeof SETTING_KEYS)[number];

/**
 * Every key the wire may name. `alert_thresholds` and `client_version_range` were
 * retired on 26 September 2026 and their rows deleted by migration 0019; the enum kept
 * naming them so that desktop 1.0.11's settings rows would parse, and they went with
 * the 1.0.14 minimum (lane W3-C2).
 */
export type SettingKey = ActiveSettingKey;

// ---------------------------------------------------------------------------
// The slices
// ---------------------------------------------------------------------------

const ianaTimeZoneSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/, 'an IANA time zone');

/** Appendix D: "A configurable workspace business zone initialized to America/New_York." */
const businessTimeZoneSettingSchema = z.strictObject({ timeZone: ianaTimeZoneSchema });

/**
 * 10.1's postal footer, back as a setting (migration 0020, lane W3-F, 27 September 2026).
 *
 * It was a slice here until 22 September 2026, when David decided an automated email
 * carries no postal address and migration 0015 dropped the column the old footer used.
 * `docs/archive/decisions/g20-automated-email-carries-no-postal-address.md` says how it
 * comes back: "reversing it is a new migration, not a revert" — a **new settings key**,
 * not the dropped column, a new slice and a new rule. This is that key; migration 0020
 * widens `workspace_settings_key_known` to admit it and nothing else.
 *
 * The value is plain text and bounded, because it is appended to every automated body:
 * at most 200 characters, no markup, no link and no "unsubscribe" (which the fence's own
 * CHECK refuses in a body). `{ "address": null }` clears it, and a cleared address is not
 * an error: the footer is then the sign-off alone, and sending continues. The switch that would make it compulsory is `SEND_FOOTER_POLICY`
 * in `packages/domain/src/rules/templates.ts`.
 */
export const POSTAL_ADDRESS_MAX_LENGTH = 200;

const postalAddressTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(POSTAL_ADDRESS_MAX_LENGTH)
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
  .refine(value => !/[\x00-\x09\x0b-\x1f\x7f]|\r/.test(value), 'plain text, on one or more lines')
  .refine(value => !/<[a-z/!][^>]*>/i.test(value), 'no markup')
  .refine(value => !/https?:\/\/|www\./i.test(value), 'no link')
  .refine(value => !/unsubscribe/i.test(value), 'no unsubscribe wording');

export const postalAddressSettingSchema = z.strictObject({
  /** The address the footer carries, or null when the workspace has configured none. */
  address: postalAddressTextSchema.nullable(),
});
export type PostalAddressSetting = z.infer<typeof postalAddressSettingSchema>;

/**
 * 16.2: "Production sending remains disabled until ... an authenticated admin enables
 * sending."
 *
 * This is the admin's half of that sentence. The deployment's half is the
 * `sendingEnabled` flag the release process sets, and the two are ANDed: see
 * `docs/decisions/g9-sending-enable-is-two-switches.md`. The `releaseGateReference` is
 * what the admin is attesting to — the rehearsal run whose artifact digests match what
 * is deployed — and it is required when enabling, because "an admin clicked yes" is
 * not the gate.
 *
 * The schema checks only that a reference is there. Since lane g71 the server also
 * requires it to be the `releaseGateReference` of a stored release record
 * (`./release.ts`) that passed and names the running API's digest, and the worker
 * requires the same record to name its own. Those checks need the database and the
 * process's own identity, so they are the domain's (`updateSetting`, `decideSend`), not
 * this schema's.
 *
 * Since lane g100 the reference may instead be the release process's name,
 * `ci-gate:main` (`CI_GATE_MAIN_POLICY` in `./release.ts`): any stored `ci-gate` record
 * that names the asking process's digest. The shape is unchanged, so a stored value
 * and the desktop's text field need nothing new.
 */
export const sendingEnabledSettingSchema = z
  .strictObject({
    enabled: z.boolean(),
    releaseGateReference: z.string().trim().min(1).max(200).nullable(),
  })
  .refine(value => !value.enabled || value.releaseGateReference !== null, {
    message: 'enabling production sending names the release gate it passed',
  });
export type SendingEnabledSetting = z.infer<typeof sendingEnabledSettingSchema>;

/** Every key's value schema, chosen by the server from the key the command names. */
export const SETTING_VALUE_SCHEMAS = {
  business_time_zone: businessTimeZoneSettingSchema,
  sending_enabled: sendingEnabledSettingSchema,
  postal_address: postalAddressSettingSchema,
} as const satisfies Record<ActiveSettingKey, z.ZodType>;

/**
 * The value a workspace has before an admin has ever set one. Indexable by any wire
 * key; a retired key has no default.
 */
export const DEFAULT_SETTING_VALUES: Readonly<Record<ActiveSettingKey, unknown> & Partial<Record<SettingKey, unknown>>> =
  Object.freeze({
    business_time_zone: { timeZone: 'America/New_York' },
    sending_enabled: { enabled: false, releaseGateReference: null },
    // No address until an admin configures one, and no address is not an error.
    postal_address: { address: null },
  });

// ---------------------------------------------------------------------------
// The call-to-booking switches (migration 0028)
// ---------------------------------------------------------------------------

/**
 * Four workspace settings that are **not** in `SETTING_KEYS`, on purpose.
 *
 * `GET /settings` answers with a `strictObject` whose `settingKey` is `z.enum(SETTING_KEYS)`,
 * and every installed Mac parses it with the enum it was built with. A key added to that
 * list would make the settings page of every installed build fail to parse. So these live
 * in the same versioned table (`workspace_settings`, whose CHECK 0028 widens), are written
 * by the same `updateSetting` command, and are left out of the settings snapshot.
 *
 *   * `calling_provider` — `tel` (the Mac opens a `tel:` link; the default) or `twilio`
 *     (the new call-session routes answer). The default leaves every new route at 404.
 *   * `calendar_integration` — `off` (the default) or `calcom` (the Cal.com webhook is
 *     accepted for this workspace).
 *   * `telephony_budget` — the per-day ceiling in cents for Twilio minutes, the most minutes
 *     one call reserves, and the price per minute in micro-dollars. A ceiling of 0 means
 *     telephony spend is disabled: `POST /calls/session` refuses `telephony_budget_disabled`.
 *   * `voicemail_script` — the template of the voicemail a caller leaves (slice C1, which
 *     owns the read, the write and the editor). `{ template }`, at most 2 000 characters;
 *     absent is `DEFAULT_VOICEMAIL_TEMPLATE`. Not an integration, but kept out of the
 *     snapshot for the same reason, so it lives in this list.
 *   * `call_transcription` — slice C2 (migration 0030): whether answered, recorded calls of
 *     at least twenty seconds are transcribed, the per-day ceiling in cents for that, and
 *     the price per minute in micro-dollars. Off, a ceiling of 0, and Deepgram's published
 *     Nova-3 pre-recorded rate (4 300, i.e. $0.0043 a minute, read 30 September 2026) by
 *     default — a setting, not a constant, so a price change is an edit.
 *   * `monthly_cash_ceiling_cents` — slice P1 (migration 0031): the month-to-date cash
 *     ceiling, in cents, that telephony and transcription reservations are cleared against
 *     together with their daily ceilings. `{ cents }`, 0 to 5 000; absent is 2 500 ($25).
 *     Month-to-date spend is every provider's settled cost plus its open reservations on
 *     the workspace business time zone's calendar month.
 */
export const meetingAnalysisSettingSchema = z.strictObject({
  enabled: z.boolean(), dailyCeilingCents: z.number().int().min(0).max(500),
  creditCoverage: z.strictObject({ ...meetingTranscriptionSettingSchema.shape.creditCoverage.unwrap().shape, service: z.literal('bedrock') })
    .refine(value => Date.parse(value.validUntil) > Date.parse(value.verifiedAt), 'coverage must expire after verification').nullable(),
});
export type MeetingAnalysisSetting = z.infer<typeof meetingAnalysisSettingSchema>;
export const DEFAULT_MEETING_ANALYSIS: MeetingAnalysisSetting = { enabled: false, dailyCeilingCents: 0, creditCoverage: null };

export const meetingFollowThroughSettingSchema = z.strictObject({ sequenceVersionId: z.string().uuid().nullable() });
export const DEFAULT_MEETING_FOLLOW_THROUGH = { sequenceVersionId: null };

export const INTEGRATION_SETTING_KEYS = [
  'calling_provider',
  'calendar_integration',
  'telephony_budget',
  'voicemail_script',
  'call_transcription',
  'monthly_cash_ceiling_cents',
  'meeting_transcription',
  'meeting_analysis',
  'meeting_follow_through',
  'meeting_auto_recording',
] as const;
export type IntegrationSettingKey = (typeof INTEGRATION_SETTING_KEYS)[number];

/** Every key the versioned store may hold. */
export type StoredSettingKey = ActiveSettingKey | IntegrationSettingKey;

export const callingProviderSettingSchema = z.strictObject({ provider: z.enum(['tel', 'twilio']) });
export type CallingProviderSetting = z.infer<typeof callingProviderSettingSchema>;

export const calendarIntegrationSettingSchema = z.strictObject({ integration: z.enum(['off', 'calcom']) });
export type CalendarIntegrationSetting = z.infer<typeof calendarIntegrationSettingSchema>;

export const telephonyBudgetSettingSchema = z.strictObject({
  /** Cents per business day for Twilio minutes. 0 disables telephony spend. At most $100. */
  dailyCeilingCents: z.number().int().min(0).max(10_000),
  /** Minutes one call session reserves before it is placed. */
  maxMinutesPerCall: z.number().int().min(1).max(240),
  /** Micro-dollars per minute (Twilio US outbound is about 14 000). */
  unitPriceMicros: z.number().int().min(0).max(10_000_000),
});
export type TelephonyBudgetSetting = z.infer<typeof telephonyBudgetSettingSchema>;

/** Slice C1's default voicemail. The placeholders are C1's to fill. */
export const DEFAULT_VOICEMAIL_TEMPLATE =
  "Hi {contactFirstName}, this is {callerName} from Callie. I'm calling about how {firmName} handles maintenance requests after hours. I'll try you again, or you can reach me at {callbackNumber}. Thanks.";

/** The longest voicemail template an admin may save (slice S1 raised it from 1 000 to 2 000). */
export const VOICEMAIL_TEMPLATE_MAX_CHARACTERS = 2_000;
export const voicemailScriptSettingSchema = z.strictObject({
  template: z.string().min(1).max(VOICEMAIL_TEMPLATE_MAX_CHARACTERS),
});
export type VoicemailScriptSetting = z.infer<typeof voicemailScriptSettingSchema>;

/** The highest daily transcription ceiling an admin may set: $5. */
export const TRANSCRIPTION_DAILY_CEILING_MAX_CENTS = 500;
/** Deepgram Nova-3 pre-recorded, pay as you go: $0.0043 a minute (https://deepgram.com/pricing, read 30 Sep 2026). */
export const DEFAULT_TRANSCRIPTION_UNIT_PRICE_MICROS = 4_300;

export const callTranscriptionSettingSchema = z.strictObject({
  enabled: z.boolean(),
  /** Cents per business day for transcription. 0 means nothing is transcribed. At most $5. */
  dailyCeilingCents: z.number().int().min(0).max(TRANSCRIPTION_DAILY_CEILING_MAX_CENTS),
  /** Micro-dollars per minute of audio. */
  unitPriceMicros: z.number().int().min(0).max(10_000_000),
});
export type CallTranscriptionSetting = z.infer<typeof callTranscriptionSettingSchema>;

/** The highest month-to-date cash ceiling an admin may set: $50. */
export const MONTHLY_CASH_CEILING_MAX_CENTS = 5_000;
/** The month-to-date cash ceiling a workspace has before an admin sets one: $25. */
export const DEFAULT_MONTHLY_CASH_CEILING_CENTS = 2_500;

export const monthlyCashCeilingSettingSchema = z.strictObject({
  /** Cents per calendar month across telephony, transcription and every other provider. 0 refuses every new reservation. */
  cents: z.number().int().min(0).max(MONTHLY_CASH_CEILING_MAX_CENTS),
});
export type MonthlyCashCeilingSetting = z.infer<typeof monthlyCashCeilingSettingSchema>;

export const INTEGRATION_SETTING_VALUE_SCHEMAS = {
  calling_provider: callingProviderSettingSchema,
  calendar_integration: calendarIntegrationSettingSchema,
  telephony_budget: telephonyBudgetSettingSchema,
  voicemail_script: voicemailScriptSettingSchema,
  call_transcription: callTranscriptionSettingSchema,
  monthly_cash_ceiling_cents: monthlyCashCeilingSettingSchema,
  meeting_transcription: meetingTranscriptionSettingSchema,
  meeting_analysis: meetingAnalysisSettingSchema,
  meeting_follow_through: meetingFollowThroughSettingSchema,
  meeting_auto_recording: meetingAutoRecordingSettingSchema,
} as const satisfies Record<IntegrationSettingKey, z.ZodType>;

export const DEFAULT_INTEGRATION_SETTING_VALUES: Readonly<Record<IntegrationSettingKey, unknown>> = Object.freeze({
  calling_provider: { provider: 'tel' },
  calendar_integration: { integration: 'off' },
  telephony_budget: { dailyCeilingCents: 0, maxMinutesPerCall: 30, unitPriceMicros: 14_000 },
  voicemail_script: { template: DEFAULT_VOICEMAIL_TEMPLATE },
  call_transcription: { enabled: false, dailyCeilingCents: 0, unitPriceMicros: DEFAULT_TRANSCRIPTION_UNIT_PRICE_MICROS },
  monthly_cash_ceiling_cents: { cents: DEFAULT_MONTHLY_CASH_CEILING_CENTS },
  meeting_transcription: DEFAULT_MEETING_TRANSCRIPTION,
  meeting_analysis: DEFAULT_MEETING_ANALYSIS,
  meeting_follow_through: DEFAULT_MEETING_FOLLOW_THROUGH,
  meeting_auto_recording: DEFAULT_MEETING_AUTO_RECORDING,
});

/** The schema and default for any stored key. */
export const STORED_SETTING_VALUE_SCHEMAS: Readonly<Record<StoredSettingKey, z.ZodType>> = Object.freeze({
  ...SETTING_VALUE_SCHEMAS,
  ...INTEGRATION_SETTING_VALUE_SCHEMAS,
});
export const DEFAULT_STORED_SETTING_VALUES: Readonly<Record<StoredSettingKey, unknown>> = Object.freeze({
  ...DEFAULT_SETTING_VALUES,
  ...DEFAULT_INTEGRATION_SETTING_VALUES,
});

/**
 * `GET /settings/integrations` (slice S1): the four call-to-booking settings in one answer, and
 * whether each integration's credentials are in place. `missing` is a list of field NAMES
 * (`auth_token`), never a value, a length or a prefix of one.
 */
const integrationConfigured = z.strictObject({ ok: z.boolean(), missing: z.array(z.string().max(64)).max(16) });
export const integrationsSettingsResponseSchema = z.strictObject({
  meetingAutoRecording: z.strictObject({setting:meetingAutoRecordingSettingSchema,version:z.number().int().nonnegative(),configured:z.strictObject({ready:z.boolean(),workerFresh:z.boolean()})}).optional(),
  meetingFollowThrough: z.strictObject({ setting: meetingFollowThroughSettingSchema, choices: z.array(z.strictObject({ id: z.string().uuid(), label: z.string().max(240) })).max(100) }).optional(),
  meetingAnalysis: z.strictObject({ setting: meetingAnalysisSettingSchema, spentTodayCents: z.number().int().nonnegative() }).optional(),
  meetingTranscription: z.strictObject({ setting: meetingTranscriptionSettingSchema, spentTodayCents: z.number().int().nonnegative() }).optional(),
  callingProvider: z.enum(['tel', 'twilio']),
  telephonyBudget: telephonyBudgetSettingSchema,
  calendarIntegration: z.enum(['off', 'calcom']),
  voicemailScript: z.string().min(1).max(VOICEMAIL_TEMPLATE_MAX_CHARACTERS),
  configured: z.strictObject({ twilioVoice: integrationConfigured, calcom: integrationConfigured }),
  /** Today's settled plus reserved Twilio minutes, in cents, on the budget's own day boundary. */
  spentTodayCents: z.number().int().min(0),
  /**
   * Slice C2's call transcription, answered only to a client that asks for it with
   * `?include=transcription`: a desktop built with slice S1 parses this answer with its
   * own strict build of this schema, and an unasked-for key would make its whole section
   * unreadable. `spentTodayCents` is today's settled plus reserved transcription cost.
   */
  transcription: z
    .strictObject({
      setting: callTranscriptionSettingSchema,
      configured: integrationConfigured,
      spentTodayCents: z.number().int().min(0),
    })
    .optional(),
  /**
   * Slice P1's month-to-date cash ceiling, answered only to a client that asks with
   * `?include=month`, for the reason `transcription` is. `spentMonthCents` is this calendar
   * month's settled plus reserved CASH cost across every cash-funded provider, on the
   * business time zone — what the ceiling is measured against. `creditsMonthCents` (slice
   * C3a) is the same month's cost of the providers paid from AWS credits (Amazon Transcribe):
   * shown beside it, never counted against the ceiling. Answered only when the client also
   * asks `?include=credits`, so a P1 desktop, which parses `month` strictly, never meets
   * it; optional, so a reader tolerates an API from before it.
   */
  month: z
    .strictObject({
      ceilingCents: z.number().int().min(0).max(MONTHLY_CASH_CEILING_MAX_CENTS),
      spentMonthCents: z.number().int().min(0),
      creditsMonthCents: z.number().int().min(0).optional(),
    })
    .optional(),
});
export type IntegrationsSettingsResponse = z.infer<typeof integrationsSettingsResponseSchema>;

/**
 * `GET /settings/finishing` (slice P1, invariant I1): whether each switch is on, and how
 * much already started is still finishing — e-mails claimed for Gmail, research runs under
 * way, transcriptions whose Deepgram request may be in flight, and reply classifications
 * whose model request may be (`classification`). Turning a switch off
 * starts nothing new; these may finish and their results are recorded. Nothing is
 * recalled or reversed. `transcription` and `classification` are optional so a reader
 * tolerates an answer without them.
 */
const finishingCount = z.strictObject({ on: z.boolean(), finishing: z.number().int().min(0) });
export const finishingResponseSchema = z.strictObject({
  sending: finishingCount,
  research: finishingCount,
  transcription: finishingCount.optional(),
  classification: finishingCount.optional(),
});
export type FinishingResponse = z.infer<typeof finishingResponseSchema>;

// ---------------------------------------------------------------------------
// Commands and reads
// ---------------------------------------------------------------------------

const commandEnvelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

/** Every key a response may carry, which is every key a command may name. */
const settingKeySchema = z.enum(SETTING_KEYS);
const activeSettingKeySchema = settingKeySchema;

export const updateSettingCommandSchema = z.strictObject({
  ...commandEnvelope,
  /**
   * A settings-page key, or one of the call-to-booking switches (0028). Only a new
   * client names the latter; the snapshot below never carries them.
   */
  settingKey: z.enum([...SETTING_KEYS, ...INTEGRATION_SETTING_KEYS]),
  /** Validated by the key's schema on the server, never by a schema the client chose. */
  value: z.unknown(),
  /**
   * Optional since wave 2 (D5's API half): blank or absent is recorded as "Changed on
   * the Mac". Desktops up to 1.0.11 always send one.
   */
  changeNote: z.string().trim().max(500).optional(),
});

/** What `GET /settings` answers: every slice, at its current version. */
export const settingsSnapshotSchema = z.strictObject({
  settings: z.array(
    z.strictObject({
      settingKey: settingKeySchema,
      value: z.unknown(),
      /** Zero when no admin has set it and the default is in force. */
      version: z.number().int().min(0),
      changedAt: instant.nullable(),
      changedByUserId: uuid.nullable(),
      changeNote: z.string().nullable(),
    }),
  ),
  /**
   * Where the rest of the configuration lives. The settings page renders a link per
   * entry rather than a second copy of the data.
   */
  elsewhere: z.array(
    z.strictObject({
      topic: z.string(),
      path: z.string(),
      ownedBy: z.string(),
    }),
  ),
  /**
   * G8's current workspace holiday calendar, carried here so the settings page can
   * show what it is about to replace. Not stored by this lane: a version is frozen
   * onto every due instant G8 computes, so the calendar has to be a versioned row of
   * its own rather than a slice of a settings blob.
   */
  holidayCalendar: z.strictObject({
    version: z.string(),
    /** Local calendar dates, `YYYY-MM-DD`, sorted. */
    dates: z.array(z.string()),
  }),
  /** The deployment half of 16.2, read-only. `sending_enabled` is the admin's half. */
  deploymentSendingEnabled: z.boolean(),
  /** Both halves, ANDed. What the sending code actually asks. */
  effectiveSendingEnabled: z.boolean(),
});

export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;

// ---------------------------------------------------------------------------
// Stage administration (8.1)
// ---------------------------------------------------------------------------

/**
 * The commands behind the settings page's pipeline section.
 *
 * They are here rather than in `crm.ts` because they are administration: a
 * salesperson never sends one, and the page that does is the settings page. The
 * *reads* they change stay in the CRM contract, where the board and the Firm page
 * find them.
 *
 * There is no "create terminal stage" and no "unretire": the workspace has exactly
 * one Won and one Lost, and a retired stage that came back would change the meaning
 * of every opportunity that sat in it while it was retired.
 */
const pipelineStageKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/u, 'a pipeline stage key');
const pipelineStageNameSchema = z.string().trim().min(1).max(80);

export const createPipelineStageCommandSchema = z.strictObject({
  ...commandEnvelope,
  key: pipelineStageKeySchema,
  displayName: pipelineStageNameSchema,
  /** Among the nonterminal stages, 1-based. Last by default. */
  position: z.number().int().min(1).max(50).optional(),
});

export const renamePipelineStageCommandSchema = z.strictObject({
  ...commandEnvelope,
  stageKey: pipelineStageKeySchema,
  displayName: pipelineStageNameSchema,
});

export const reorderPipelineStagesCommandSchema = z.strictObject({
  ...commandEnvelope,
  /** Every nonterminal stage key, in the order they should appear. */
  stageKeys: z.array(pipelineStageKeySchema).min(1).max(50),
});

export const retirePipelineStageCommandSchema = z.strictObject({
  ...commandEnvelope,
  stageKey: pipelineStageKeySchema,
});

// ---------------------------------------------------------------------------
// The dashboard read (13.4)
// ---------------------------------------------------------------------------

/**
 * The window a dashboard read is computed over.
 *
 * Required rather than defaulted on the server: a figure whose window the caller did
 * not choose is a figure two people compare and disagree about. The upper bound is
 * exclusive, so two adjacent windows never double-count a row.
 */
const dashboardWindowSchema = z
  .strictObject({ from: instant, to: instant })
  .refine(value => Date.parse(value.from) < Date.parse(value.to), {
    message: 'the window starts before it ends',
  });

export const dashboardRequestSchema = z.strictObject({
  window: dashboardWindowSchema,
});

export const settingHistoryRequestSchema = z.strictObject({
  settingKey: activeSettingKeySchema,
  limit: z.number().int().min(1).max(200).optional(),
});

// ---------------------------------------------------------------------------
// What the Mac parses back
// ---------------------------------------------------------------------------

/**
 * The dashboard and Diagnostics responses, as the client reads them.
 *
 * `z.object` rather than `z.strictObject`, and that is the useful property here
 * rather than a relaxation: an unknown key is *stripped*, so a field a later lane
 * adds to the server's DTO cannot reach the renderer until this schema names it. A
 * page cannot display what it did not declare, which is the client half of
 * "responses are typed and redacted for the caller's visibility class" (14.1).
 */
const unavailableSchema = z.object({
  available: z.literal(false),
  owner: z.string(),
  reason: z.string(),
});

const countByKeySchema = z.object({ key: z.string(), count: z.number() });

export const dashboardResponseSchema = z.object({
  window: z.object({ from: instant, to: instant }),
  audience: z.enum(['workspace', 'assigned']),
  firmsInScope: z.number(),
  messages: z.object({
    incomingMatched: z.number(),
    human: z.number(),
    uncertain: z.number(),
    automated: z.number(),
    bounces: z.number(),
    optOuts: z.number(),
  }),
  replyHandling: z.object({
    replies: z.number(),
    handled: z.number(),
    medianSecondsToHandle: z.number().nullable(),
    slowestSecondsToHandle: z.number().nullable(),
  }),
  calls: z.array(countByKeySchema),
  stageMovement: z.array(countByKeySchema),
  holds: z.object({
    open: z.number(),
    byReason: z.array(
      z.object({ reasonCode: z.string(), count: z.number(), oldestAgeSeconds: z.number() }),
    ),
  }),
  suppressions: z.array(countByKeySchema),
  sending: z.union([unavailableSchema, z.object({ available: z.literal(true) }).loose()]),
  enrollments: z.union([unavailableSchema, z.object({ available: z.literal(true) }).loose()]),
  classifier: z.union([unavailableSchema, z.object({ available: z.literal(true) }).loose()]),
  // Lane J-facts' funnel (migration 0022). `z.object` strips what it does not name,
  // so adding this key is not a wire break: 1.0.14 and 1.0.15 drop it unread. The
  // shape is spelled out rather than left `.loose()` because it is small, closed and
  // finished — the three other sources are loose because their own fields are still
  // moving, and a schema that names the fields is what makes a later change visible
  // on the wire.
  funnel: z.union([
    unavailableSchema,
    z.object({
      available: z.literal(true),
      byKind: z.array(countByKeySchema),
      firmsByKind: z.array(countByKeySchema),
      uniqueFirms: z.number(),
      firmsInScope: z.number(),
    }),
  ]),
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

/**
 * `restore` is a compatibility field and nothing else (lane W3-S8, 26 September 2026).
 *
 * The system-generation pin is gone: a restore is a runbook
 * (`docs/greenfield/runbooks/restore.md`), and nothing reads or compares generations. The
 * installed desktop 1.0.11 still parses this object strictly and renders it in Settings →
 * Diagnostics, so the API answers the same shape with neutral values —
 * `RESTORE_DIAGNOSTIC_NOT_APPLICABLE`, which 1.0.11 shows as "unknown, unpinned, matches".
 * Delete the field once the desktop that no longer reads it is the one installed.
 */
export const RESTORE_DIAGNOSTIC_NOT_APPLICABLE = Object.freeze({
  systemGeneration: null,
  expectedSystemGeneration: null,
  mismatch: false,
} as const);

export const diagnosticsResponseSchema = z.object({
  restore: z.object({
    systemGeneration: z.number().nullable(),
    expectedSystemGeneration: z.number().nullable(),
    mismatch: z.boolean(),
  }),
  schema: z.object({
    appliedVersion: z.number(),
    declaredRange: z.object({ minimum: z.number(), maximum: z.number() }),
    accepted: z.boolean(),
  }),
  clientVersions: clientVersionRangeSchema,
  sending: z.object({
    deploymentEnabled: z.boolean(),
    adminEnabled: z.boolean(),
    effective: z.boolean(),
  }),
  jobs: z.object({
    runnable: z.number(),
    running: z.number(),
    retryable: z.number(),
    dead: z.number(),
    oldestRunnableAgeSeconds: z.number().nullable(),
    oldestDeadAgeSeconds: z.number().nullable(),
  }),
  heartbeats: z.array(
    z.object({
      component: z.string(),
      instanceKey: z.string(),
      ageSeconds: z.number(),
      expectedIntervalSeconds: z.number(),
      fresh: z.boolean(),
    }),
  ),
  canaryCompletionAgeSeconds: z.number().nullable(),
  alerts: z.array(
    z.object({
      id: uuid,
      alertKey: z.string(),
      severity: z.enum(['critical', 'warning']),
      raisedAt: instant,
      acknowledgedAt: instant.nullable(),
      runbookPath: z.string().nullable(),
    }),
  ),
  mailboxes: z.array(
    z.object({
      mailboxId: uuid,
      ownerUserId: uuid,
      status: z.string(),
      syncState: z.string(),
      coverageWatermarkAt: instant.nullable(),
      lastSyncedAt: instant.nullable(),
      lastSyncError: z.string().nullable(),
      watchExpiresAt: instant.nullable(),
      hoursToWatchExpiry: z.number().nullable(),
      automationHeld: z.boolean(),
    }),
  ),
  mailboxVisibility: z.enum(['all', 'own']),
});
export type DiagnosticsResponse = z.infer<typeof diagnosticsResponseSchema>;

/**
 * `POST /settings/history`: the slice's current value and every version, newest first
 * (lane g78, audit item D04).
 *
 * The Mac's copy declared four fields of each version and stripped the rest, so the
 * history showed dates and notes and never what changed. `value` is here, and `current`
 * is the value in force now — for a slice nobody has set, the default at version 0.
 * Each `value` is opaque to the wire: the server validated it against its key's schema
 * when it was written, and the page renders it as JSON.
 */
export const settingHistoryResponseSchema = z.object({
  settingKey: settingKeySchema,
  current: z.object({ value: z.unknown(), version: z.number().int().min(0) }),
  versions: z.array(
    z.object({
      settingKey: settingKeySchema,
      version: z.number().int().min(1),
      value: z.unknown(),
      changeNote: z.string().nullable(),
      changedByUserId: uuid.nullable(),
      changedAt: instant,
      supersededAt: instant.nullable(),
    }),
  ),
});
export type SettingHistoryResponse = z.infer<typeof settingHistoryResponseSchema>;

/** `POST /admin/alerts/acknowledge`. Not a receipted command; admin-only and audited. */
export const alertAcknowledgedResponseSchema = z.object({
  acknowledged: z.literal(true),
  alertKey: z.string().min(1),
});
