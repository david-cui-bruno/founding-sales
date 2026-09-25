import type {
  DashboardResponse,
  DiagnosticsResponse,
  SettingHistoryResponse,
  SettingKey,
  SettingsSnapshot,
} from '@fss/contracts';

/**
 * The administration window's contract (specification 10.1, 13.3, 13.4, 14.2).
 *
 * One window with three screens — Settings, Dashboard, Diagnostics — because they are
 * the three things a person opens when they are *not* selling: configuring, looking
 * at results, and finding out why something is not working. The one personal setting
 * lives here too: "Your calling number" (lane g60), without which Today has no Call
 * button. The Today window stays
 * small and fast; this one is opened, used and closed, exactly as G3b said of the CRM
 * windows.
 *
 * The renderer holds no rule. It never decides who may change a setting, never
 * computes an effective cap and never works out whether sending is on: it renders
 * what the API said, including the API's own `effectiveSendingEnabled`. Section 14.2:
 * the client "contains no authoritative sequence, suppression, policy, eligibility,
 * or send logic".
 */

export type AdminScreen = 'settings' | 'dashboard' | 'diagnostics';

export interface AdminState {
  readonly screen: AdminScreen;
  readonly role: 'admin' | 'salesperson';
  readonly online: boolean;
  /** False offline or below the minimum client version: every control is inert. */
  readonly mayMutate: boolean;
  /** The last refusal code, verbatim, for the view to turn into one sentence. */
  readonly notice: string | null;
  readonly settings: SettingsSnapshot | null;
  readonly dashboard: DashboardResponse | null;
  readonly diagnostics: DiagnosticsResponse | null;
  /** The pipeline, for the stage-administration section. */
  readonly stages: readonly PipelineStageRowView[];
  /** The history of one slice, when a person opened it. */
  readonly history: SettingHistoryView | null;
  /**
   * G7-2's sending posture, for the section that edits it. Null for a salesperson:
   * every `/outbound/*` path is admin-only with a redacted 403, so their page does
   * not ask and offers no control.
   */
  readonly sendingAdmin: SendingAdminView | null;
  /**
   * Why an admin's `/outbound/status` read failed, as the refusal code — `offline`,
   * `unreadable_answer`, `http_500` and the like — or null when it did not fail or was
   * not asked (lane g69). The section says it could not read the status rather than
   * vanishing, which is how a parse failure on every answer went unseen until 8.0ae.
   */
  readonly sendingReadError: string | null;
  /**
   * The person's own calling numbers (9.1; lane g60), as `GET /calling-identities`
   * answered them. Every role has this section: a number is the person's own, and 9.2
   * refuses a dial from anybody else's. Null when the read did not answer — offline,
   * refused, or an API older than the route — which the section says rather than
   * showing an empty list that would read as "you have no number".
   */
  readonly callingNumbers: readonly CallingNumberView[] | null;
}

/**
 * One of the person's calling numbers, kept verbatim from the server.
 *
 * `usedForCalls` is the server's choice of which number Today dials from, so the page
 * shows it rather than working it out from the dates.
 */
export interface CallingNumberView {
  readonly id: string;
  readonly e164: string;
  readonly label: string | null;
  readonly verificationStatus: 'unverified' | 'verified';
  readonly enabled: boolean;
  readonly verifiedAt: string | null;
  readonly verificationMethod: 'owner_attestation' | 'admin_attestation' | null;
  readonly disabledAt: string | null;
  readonly usedForCalls: boolean;
}

/**
 * Add a calling number, and attest it in the same press when the person ticked the
 * statement. The number is sent as typed; the server normalizes it and refuses
 * anything that is not `+`, a country code and the rest (`number_invalid`).
 */
export interface AddCallingNumberInput {
  readonly e164: string;
  /** Empty for no label. */
  readonly label: string;
  /** "This is the number I place calls from." Unticked adds the number unverified. */
  readonly attested: boolean;
}

/**
 * What `/outbound/status` said, kept verbatim.
 *
 * Nothing here is derived on the client. `authenticationPasses` is the server's
 * answer to 12.7's four-part checklist and `effectiveCap` is the ramp the server
 * computed from `healthy_sending_days` — the cap is never stored, and a client that
 * recomputed it would be a second implementation of 12.7's schedule.
 */
export interface SendingAdminView {
  readonly domain: {
    readonly domain: string;
    readonly spfPass: boolean;
    readonly dkimPass: boolean;
    readonly dmarcPass: boolean;
    readonly postmasterReviewedAt: string | null;
    readonly authenticationPasses: boolean;
    readonly automatedSendingEnabled: boolean;
    readonly personalGmailGuardPer24h: number;
  } | null;
  /** How much of 12.6's rolling guard the last 24 hours used. */
  readonly personalGmailRecipients: number;
  readonly ramps: readonly {
    readonly mailboxId: string;
    readonly healthySendingDays: number;
    readonly effectiveCap: number;
    readonly adminDailyCap: number | null;
    readonly raisedDailyCap: number | null;
    readonly lastHealthFailure: string | null;
  }[];
}

/** 12.7's two admin decisions about a cap. Absent and null differ: null clears. */
export interface SetSendingCapInput {
  readonly mailboxId: string;
  readonly lowerTo?: number | null;
  readonly raiseTo?: number | null;
}

/**
 * A new holiday calendar, which supersedes rather than edits.
 *
 * The version is named by the person, not generated, because it is the label that
 * will appear frozen on every due instant computed under it — and a name somebody
 * chose ("2027-federal") is readable in an incident where a serial number is not.
 */
export interface RecordHolidayCalendarInput {
  readonly version: string;
  /** Local calendar dates, `YYYY-MM-DD`. */
  readonly dates: readonly string[];
}

/** 12.7's checklist, which is a person saying they looked: FSS never queries DNS. */
export interface RecordSendingAuthenticationInput {
  readonly domain: string;
  readonly spfPass: boolean;
  readonly dkimPass: boolean;
  readonly dmarcPass: boolean;
  readonly postmasterReviewed: boolean;
  readonly automatedSendingEnabled: boolean;
}

export interface PipelineStageRowView {
  readonly key: string;
  readonly displayName: string;
  readonly position: number;
  readonly terminalKind: 'won' | 'lost' | null;
  readonly retired: boolean;
}

/**
 * `POST /settings/history` as the API answered it, values included (lane g78, D04):
 * the slice's current value and version, and every version with the value it set.
 * Until g78 this carried four fields per version and no value at all, so History could
 * say when something changed and never what.
 */
export type SettingHistoryView = SettingHistoryResponse;

export interface SaveSettingInput {
  readonly settingKey: SettingKey;
  readonly value: unknown;
  readonly changeNote: string;
}

export interface AdminBridge {
  state(): Promise<AdminState>;
  show(input: { readonly screen: AdminScreen }): Promise<AdminState>;
  saveSetting(input: SaveSettingInput): Promise<AdminState>;
  openHistory(input: { readonly settingKey: SettingKey }): Promise<AdminState>;
  loadDashboard(input: { readonly from: string; readonly to: string }): Promise<AdminState>;
  createStage(input: { readonly key: string; readonly displayName: string }): Promise<AdminState>;
  renameStage(input: { readonly stageKey: string; readonly displayName: string }): Promise<AdminState>;
  reorderStages(input: { readonly stageKeys: readonly string[] }): Promise<AdminState>;
  retireStage(input: { readonly stageKey: string }): Promise<AdminState>;
  acknowledgeAlert(input: { readonly alertId: string }): Promise<AdminState>;
  setSendingCap(input: SetSendingCapInput): Promise<AdminState>;
  recordSendingAuthentication(input: RecordSendingAuthenticationInput): Promise<AdminState>;
  recordHolidayCalendar(input: RecordHolidayCalendarInput): Promise<AdminState>;
  addCallingNumber(input: AddCallingNumberInput): Promise<AdminState>;
  attestCallingNumber(input: { readonly identityId: string }): Promise<AdminState>;
  retireCallingNumber(input: { readonly identityId: string }): Promise<AdminState>;
}

declare global {
  var callieAdmin: AdminBridge | undefined;
}
