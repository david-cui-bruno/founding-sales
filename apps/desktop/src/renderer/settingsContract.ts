import type {
  DashboardResponse,
  DiagnosticsResponse,
  SettingKey,
  SettingsSnapshot,
} from '@fss/contracts';

/**
 * The administration window's contract (specification 10.1, 13.3, 13.4, 14.2).
 *
 * One window with three screens — Settings, Dashboard, Diagnostics — because they are
 * the three things a person opens when they are *not* selling: configuring, looking
 * at results, and finding out why something is not working. The Today window stays
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

export interface SettingHistoryView {
  readonly settingKey: SettingKey;
  readonly versions: readonly {
    readonly version: number;
    readonly changeNote: string | null;
    readonly changedAt: string;
    readonly supersededAt: string | null;
  }[];
}

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
}

declare global {
  var callieAdmin: AdminBridge | undefined;
}
