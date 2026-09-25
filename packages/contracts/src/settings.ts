import { z } from 'zod';
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
 * warning threshold must be below the critical one, a client-version range must be
 * two real semantic versions: the server applies the key's schema to the value after
 * choosing the schema by key, so a request outside a bound is refused with
 * `invalid_value` and writes no version. A bound a client can move is not a bound.
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
export const SETTING_KEYS = [
  'alert_thresholds',
  'business_time_zone',
  'client_version_range',
  'sending_enabled',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

// ---------------------------------------------------------------------------
// 13.3's thresholds, as versioned configuration
// ---------------------------------------------------------------------------

/** `HH:MM` on a 24-hour clock. */
export const localTimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a local time of day');

/**
 * Specification 13.3: "Initial alarm thresholds are configuration, versioned with the
 * release." The nine of them, plus G1's repeat interval.
 *
 * Seven of these are also Terraform variables in `infra/modules/alerts/variables.tf`,
 * and `packages/domain/test/settings/settings.test.ts` reads that file and fails when
 * a default here disagrees with the default there. Two are not, because no CloudWatch
 * variable expresses them: the Today deadline is a workspace-local time of day, and
 * the held fraction is a literal inside a metric-math expression.
 */
export const alertThresholdsSchema = z
  .strictObject({
    /** "Today snapshot absent at 05:10 workspace time", in the workspace business zone. */
    todaySnapshotDeadlineLocalTime: localTimeOfDaySchema,
    /** "three missed one-minute scheduler or mailbox checks" */
    heartbeatMissedChecks: z.number().int().min(1).max(10),
    /** "oldest runnable job older than five minutes warning" */
    oldestJobAgeWarningSeconds: z.number().int().min(30).max(86_400),
    /** "... or fifteen minutes critical" */
    oldestJobAgeCriticalSeconds: z.number().int().min(30).max(86_400),
    /** "Gmail watch within two days of expiry" */
    gmailWatchExpiryHours: z.number().int().min(1).max(168),
    /** "canary not completed within five minutes" */
    canaryStaleSeconds: z.number().int().min(60).max(86_400),
    /** "all active sequences unexpectedly held", as the held fraction the alarm compares. */
    allSequencesHeldFraction: z.number().min(0.1).max(1),
    /** "dead job unresolved for one hour" */
    deadJobUnresolvedSeconds: z.number().int().min(60).max(604_800),
    /** "connected mailbox with recent sends disconnected for 48 hours" */
    mailboxDisconnectedHours: z.number().int().min(1).max(720),
    /** Not one of the nine: G1's repeat interval for an unacknowledged critical alert. */
    unacknowledgedCriticalSeconds: z.number().int().min(300).max(86_400),
  })
  .refine(value => value.oldestJobAgeWarningSeconds < value.oldestJobAgeCriticalSeconds, {
    message: 'the warning threshold must be lower than the critical one',
  });
export type AlertThresholds = z.infer<typeof alertThresholdsSchema>;

/** The values of 13.3, and the Terraform defaults they must equal. */
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = Object.freeze({
  todaySnapshotDeadlineLocalTime: '05:10',
  heartbeatMissedChecks: 3,
  oldestJobAgeWarningSeconds: 300,
  oldestJobAgeCriticalSeconds: 900,
  gmailWatchExpiryHours: 48,
  canaryStaleSeconds: 300,
  allSequencesHeldFraction: 1,
  deadJobUnresolvedSeconds: 3600,
  mailboxDisconnectedHours: 48,
  unacknowledgedCriticalSeconds: 3600,
});

/**
 * Which Terraform variable each threshold is the same number as. The two with `null`
 * have no variable, and saying so here is what keeps the test's list honest.
 */
export const ALERT_THRESHOLD_TERRAFORM_VARIABLES: Readonly<Record<keyof AlertThresholds, string | null>> =
  Object.freeze({
    todaySnapshotDeadlineLocalTime: null,
    heartbeatMissedChecks: 'heartbeat_missed_checks',
    oldestJobAgeWarningSeconds: 'oldest_job_age_warning_seconds',
    oldestJobAgeCriticalSeconds: 'oldest_job_age_critical_seconds',
    gmailWatchExpiryHours: 'gmail_watch_expiry_hours',
    canaryStaleSeconds: 'canary_stale_seconds',
    allSequencesHeldFraction: null,
    deadJobUnresolvedSeconds: 'dead_job_unresolved_seconds',
    mailboxDisconnectedHours: 'mailbox_disconnected_hours',
    unacknowledgedCriticalSeconds: 'unacknowledged_critical_seconds',
  });

// ---------------------------------------------------------------------------
// The other slices
// ---------------------------------------------------------------------------

export const ianaTimeZoneSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/, 'an IANA time zone');

/** Appendix D: "A configurable workspace business zone initialized to America/New_York." */
export const businessTimeZoneSettingSchema = z.strictObject({ timeZone: ianaTimeZoneSchema });
export type BusinessTimeZoneSetting = z.infer<typeof businessTimeZoneSettingSchema>;

/*
 * 10.1's postal footer was a slice here until 22 September 2026. David decided an
 * automated email carries no postal address, so there is nothing to configure and the
 * slice is gone rather than left empty; migration 0015 removed the key from the
 * table's CHECK. `docs/decisions/g20-automated-email-carries-no-postal-address.md`.
 * 12.6 is unaffected: the footer still ends with the reply-to-stop sentence, and
 * `SENDING_STOP_LINE` in `./templates.ts` is that sentence.
 */

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
  alert_thresholds: alertThresholdsSchema,
  business_time_zone: businessTimeZoneSettingSchema,
  client_version_range: clientVersionRangeSchema,
  sending_enabled: sendingEnabledSettingSchema,
} as const satisfies Record<SettingKey, z.ZodType>;

/** The value a workspace has before an admin has ever set one. */
export const DEFAULT_SETTING_VALUES: Readonly<Record<SettingKey, unknown>> = Object.freeze({
  alert_thresholds: DEFAULT_ALERT_THRESHOLDS,
  business_time_zone: { timeZone: 'America/New_York' },
  client_version_range: { minimum: '1.0.0', maximum: '1.0.0' },
  sending_enabled: { enabled: false, releaseGateReference: null },
});

// ---------------------------------------------------------------------------
// Commands and reads
// ---------------------------------------------------------------------------

const commandEnvelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

export const settingKeySchema = z.enum(SETTING_KEYS);

export const updateSettingCommandSchema = z.strictObject({
  ...commandEnvelope,
  settingKey: settingKeySchema,
  /** Validated by the key's schema on the server, never by a schema the client chose. */
  value: z.unknown(),
  changeNote: z.string().trim().min(1).max(500),
});
export type UpdateSettingCommand = z.infer<typeof updateSettingCommandSchema>;

/** One version of one setting. The history is every row; the current one has no successor. */
export const settingVersionSchema = z.strictObject({
  settingKey: settingKeySchema,
  version: z.number().int().min(1),
  value: z.unknown(),
  changeNote: z.string().nullable(),
  changedByUserId: uuid.nullable(),
  changedAt: instant,
  supersededAt: instant.nullable(),
});
export type SettingVersion = z.infer<typeof settingVersionSchema>;

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

/** The calendar command the settings page sends, which is G8's `/sequences/holidays`. */
export const recordHolidayCalendarCommandSchema = z.strictObject({
  /** A new version name: an edit supersedes, it never rewrites. */
  version: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/u),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/u)).max(400),
});
export type RecordHolidayCalendarCommand = z.infer<typeof recordHolidayCalendarCommandSchema>;
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
export const pipelineStageKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/u, 'a pipeline stage key');
export const pipelineStageNameSchema = z.string().trim().min(1).max(80);

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
export const dashboardWindowSchema = z
  .strictObject({ from: instant, to: instant })
  .refine(value => Date.parse(value.from) < Date.parse(value.to), {
    message: 'the window starts before it ends',
  });

export const dashboardRequestSchema = z.strictObject({
  window: dashboardWindowSchema,
});
export type DashboardRequest = z.infer<typeof dashboardRequestSchema>;

export const settingHistoryRequestSchema = z.strictObject({
  settingKey: settingKeySchema,
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
});
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

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

export const settingsResponseSchema = settingsSnapshotSchema;
