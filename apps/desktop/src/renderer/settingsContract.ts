import { z } from 'zod';
import {
  SETTING_KEYS,
  dashboardResponseSchema,
  diagnosticsResponseSchema,
  postureReferenceResponseSchema,
  settingHistoryResponseSchema,
  settingsSnapshotSchema,
  statePostureViewSchema,
  uuid,
} from '@fss/contracts';

/**
 * What Settings is given (specification 10.1, 13.3, 13.4, 14.2).
 *
 * One view with three tabs — Administration, Dashboard, Diagnostics — because they are
 * the three things a person opens when they are *not* selling: configuring, looking at
 * results, and finding out why something is not working. The one personal setting lives
 * here too: "Your calling number" (lane g60), without which Today has no Call button.
 *
 * The renderer holds no rule. It never decides who may change a setting, never
 * computes an effective cap and never works out whether sending is on: it renders
 * what the API said, including the API's own `effectiveSendingEnabled`. Section 14.2:
 * the client "contains no authoritative sequence, suppression, policy, eligibility,
 * or send logic".
 *
 * Since 1.0.13 the state is a **schema** rather than an interface, because it crosses
 * the operation registry (`src/shared/operations.ts`) and both sides of that boundary
 * parse what they are handed. The parts that are a route's answer are the contracts'
 * own schemas; the parts that are this window's projection are declared here, where the
 * projection is made.
 */

export const SETTINGS_TAB_SCREENS = ['settings', 'dashboard', 'diagnostics'] as const;
export type AdminScreen = (typeof SETTINGS_TAB_SCREENS)[number];

/**
 * One of the person's calling numbers, kept verbatim from the server.
 *
 * `usedForCalls` is the server's choice of which number Today dials from, so the page
 * shows it rather than working it out from the dates.
 */
export const callingNumberViewSchema = z.object({
  id: uuid,
  e164: z.string().max(32),
  label: z.string().max(200).nullable(),
  verificationStatus: z.enum(['unverified', 'verified']),
  enabled: z.boolean(),
  verifiedAt: z.string().max(40).nullable(),
  verificationMethod: z.enum(['owner_attestation', 'admin_attestation']).nullable(),
  disabledAt: z.string().max(40).nullable(),
  usedForCalls: z.boolean(),
});
export type CallingNumberView = z.infer<typeof callingNumberViewSchema>;

/**
 * What the postures section reads. `reference` is the release's own words — the
 * statements and the quoted rules — and `records` every posture ever recorded, revoked
 * ones too. Either is null when its read did not answer, and `readError` names why, so
 * the section says it could not read them rather than showing an empty list that would
 * read as "no state has a posture".
 */
export const posturesStateSchema = z.object({
  reference: postureReferenceResponseSchema.nullable(),
  records: z.array(statePostureViewSchema).nullable(),
  readError: z.string().max(80).nullable(),
});
export type PosturesState = z.infer<typeof posturesStateSchema>;

/**
 * What `/outbound/status` said, kept verbatim.
 *
 * Nothing here is derived on the client. `authenticationPasses` is the server's
 * answer to 12.7's four-part checklist and `effectiveCap` is the ramp the server
 * computed from `healthy_sending_days` — the cap is never stored, and a client that
 * recomputed it would be a second implementation of 12.7's schedule.
 */
export const sendingAdminViewSchema = z.object({
  domain: z
    .object({
      domain: z.string().max(253),
      spfPass: z.boolean(),
      dkimPass: z.boolean(),
      dmarcPass: z.boolean(),
      postmasterReviewedAt: z.string().max(40).nullable(),
      authenticationPasses: z.boolean(),
      automatedSendingEnabled: z.boolean(),
    })
    .nullable(),
  ramps: z.array(
    z.object({
      mailboxId: uuid,
      healthySendingDays: z.number().int(),
      effectiveCap: z.number().int(),
      adminDailyCap: z.number().int().nullable(),
      raisedDailyCap: z.number().int().nullable(),
      lastHealthFailure: z.string().max(40).nullable(),
    }),
  ),
});
export type SendingAdminView = z.infer<typeof sendingAdminViewSchema>;

export const pipelineStageRowViewSchema = z.object({
  key: z.string().max(80),
  displayName: z.string().max(200),
  position: z.number().int(),
  terminalKind: z.enum(['won', 'lost']).nullable(),
  retired: z.boolean(),
});
export type PipelineStageRowView = z.infer<typeof pipelineStageRowViewSchema>;

/**
 * `POST /settings/history` as the API answered it, values included (lane g78, D04):
 * the slice's current value and version, and every version with the value it set.
 */
export type SettingHistoryView = z.infer<typeof settingHistoryResponseSchema>;

export const adminStateSchema = z.strictObject({
  screen: z.enum(SETTINGS_TAB_SCREENS),
  role: z.enum(['admin', 'salesperson']),
  online: z.boolean(),
  /** False offline or below the minimum client version: every control is inert. */
  mayMutate: z.boolean(),
  /** The last refusal code, verbatim, for the view to turn into one sentence. */
  notice: z.string().max(200).nullable(),
  settings: settingsSnapshotSchema.nullable(),
  dashboard: dashboardResponseSchema.nullable(),
  diagnostics: diagnosticsResponseSchema.nullable(),
  /** The pipeline, for the stage-administration section. */
  stages: z.array(pipelineStageRowViewSchema),
  /** The history of one slice, when a person opened it. */
  history: settingHistoryResponseSchema.nullable(),
  /**
   * G7-2's sending posture, for the section that edits it. Null for a salesperson:
   * every `/outbound/*` path is admin-only with a redacted 403, so their page does
   * not ask and offers no control.
   */
  sendingAdmin: sendingAdminViewSchema.nullable(),
  /**
   * Why an admin's `/outbound/status` read failed, as the refusal code, or null when it
   * did not fail or was not asked (lane g69). The section says it could not read the
   * status rather than vanishing, which is how a parse failure went unseen until 8.0ae.
   */
  sendingReadError: z.string().max(80).nullable(),
  /**
   * The person's own calling numbers (9.1; lane g60). Null when the read did not answer,
   * which the section says rather than showing an empty list that would read as "you
   * have no number".
   */
  callingNumbers: z.array(callingNumberViewSchema).nullable(),
  /** The states on the "OK to call" list and the texts the section shows (9.2 step 6). */
  postures: posturesStateSchema.nullable(),
});
export type AdminState = z.infer<typeof adminStateSchema>;

/**
 * Put several states on the "OK to call" list with one confirmation (wave 2, S4.2; D5).
 *
 * `POST /postures/allow` takes the list and the literal `confirmed: true`, and records
 * every statement of `GET /postures/reference` as confirmed, with the domain's own
 * citations — invariant 7's "software records and enforces legal posture; it does not
 * invent it", with the founder ticking one box for the list rather than four per state.
 */
export const allowStatesInputSchema = z.strictObject({
  states: z.array(z.string().regex(/^[A-Za-z]{2}$/u)).min(1).max(60),
  confirmed: z.literal(true),
  /** Where it was read, or a registration number; empty for none. */
  note: z.string().max(1000),
});
export type AllowStatesInput = z.infer<typeof allowStatesInputSchema>;

/**
 * Add a calling number. Since wave 2 (S4.3) the number is attested as it is added:
 * verified, enabled and usable for calls at once, so there is nothing left to tick.
 * The number is sent as typed; the server normalizes it and refuses anything that is
 * not `+`, a country code and the rest (`number_invalid`).
 */
export const addCallingNumberInputSchema = z.strictObject({
  e164: z.string().trim().min(1).max(32),
  /** Empty for no label. */
  label: z.string().max(200),
});
export type AddCallingNumberInput = z.infer<typeof addCallingNumberInputSchema>;

/** 12.7's two admin decisions about a cap. Absent and null differ: null clears. */
export const setSendingCapInputSchema = z.strictObject({
  mailboxId: uuid,
  lowerTo: z.number().int().nullable().optional(),
  raiseTo: z.number().int().nullable().optional(),
});
export type SetSendingCapInput = z.infer<typeof setSendingCapInputSchema>;

/**
 * A new holiday calendar, which supersedes rather than edits.
 *
 * The version is named by the person, not generated, because it is the label that
 * will appear frozen on every due instant computed under it — and a name somebody
 * chose ("2027-federal") is readable in an incident where a serial number is not.
 */
export const recordHolidayCalendarInputSchema = z.strictObject({
  version: z.string().max(40),
  /** Local calendar dates, `YYYY-MM-DD`. */
  dates: z.array(z.string().max(10)).max(400),
});
export type RecordHolidayCalendarInput = z.infer<typeof recordHolidayCalendarInputSchema>;

/** 12.7's checklist, which is a person saying they looked: FSS never queries DNS. */
export const recordSendingAuthenticationInputSchema = z.strictObject({
  domain: z.string().max(253),
  spfPass: z.boolean(),
  dkimPass: z.boolean(),
  dmarcPass: z.boolean(),
  postmasterReviewed: z.boolean(),
  automatedSendingEnabled: z.boolean(),
});
export type RecordSendingAuthenticationInput = z.infer<typeof recordSendingAuthenticationInputSchema>;

/**
 * A key a command may name: the active three. The two retired in wave 1 are still in the
 * wire vocabulary, because a server from before that deletion still reports them, but
 * nothing may be written to them — so the type of a Save is narrower than the type of a
 * row, and that is the point.
 */
export const activeSettingKeySchema = z.enum(SETTING_KEYS);
export type ActiveSettingKey = z.infer<typeof activeSettingKeySchema>;

export const saveSettingInputSchema = z.strictObject({
  settingKey: activeSettingKeySchema,
  value: z.unknown(),
  /** Optional in effect: empty is sent as "Changed on the Mac" (wave 1). */
  changeNote: z.string().max(500),
});
export type SaveSettingInput = {
  readonly settingKey: ActiveSettingKey;
  readonly value: unknown;
  readonly changeNote: string;
};
