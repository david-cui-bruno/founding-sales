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
export const SETTING_KEYS = ['business_time_zone', 'sending_enabled'] as const;
export type ActiveSettingKey = (typeof SETTING_KEYS)[number];

/**
 * @deprecated Retired 26 Sep 2026. `alert_thresholds` and `client_version_range`
 * changed nothing: the API takes its client range from the deployment and CloudWatch
 * takes its thresholds from Terraform. The server no longer answers, accepts or
 * reports a history for either. The wire vocabulary still names them only because the
 * Mac's settings rows and their tests do; remove this list once the desktop has
 * dropped them. Migration 0019 deleted their rows and took both keys out of the
 * table's CHECK.
 */
const RETIRED_SETTING_KEYS = ['alert_thresholds', 'client_version_range'] as const;

/** A key the wire may name: an active one, or (deprecated) a retired one. */
export type SettingKey = ActiveSettingKey | (typeof RETIRED_SETTING_KEYS)[number];

// ---------------------------------------------------------------------------
// The slices
// ---------------------------------------------------------------------------

const ianaTimeZoneSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/, 'an IANA time zone');

/** Appendix D: "A configurable workspace business zone initialized to America/New_York." */
const businessTimeZoneSettingSchema = z.strictObject({ timeZone: ianaTimeZoneSchema });

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
} as const satisfies Record<ActiveSettingKey, z.ZodType>;

/**
 * The value a workspace has before an admin has ever set one. Indexable by any wire
 * key; a retired key has no default.
 */
export const DEFAULT_SETTING_VALUES: Readonly<Record<ActiveSettingKey, unknown> & Partial<Record<SettingKey, unknown>>> =
  Object.freeze({
    business_time_zone: { timeZone: 'America/New_York' },
    sending_enabled: { enabled: false, releaseGateReference: null },
  });

// ---------------------------------------------------------------------------
// Commands and reads
// ---------------------------------------------------------------------------

const commandEnvelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

/** Every key a response may carry, the retired two included (deprecated). */
const settingKeySchema = z.enum([...SETTING_KEYS, ...RETIRED_SETTING_KEYS]);
/** The keys a command or a history request may name: the server refuses a retired one. */
const activeSettingKeySchema = z.enum(SETTING_KEYS);

export const updateSettingCommandSchema = z.strictObject({
  ...commandEnvelope,
  settingKey: activeSettingKeySchema,
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
