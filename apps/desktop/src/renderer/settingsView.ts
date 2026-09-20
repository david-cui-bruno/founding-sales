import { SETTINGS_ELSEWHERE_FALLBACK } from './settingsElsewhere.ts';
import type { AdminState } from './settingsContract.ts';

/**
 * The administration window as a value (specification 10.1, 13.3, 13.4, 14.2).
 *
 * A pure function of the state, with no DOM in it, for the same reason G3b's
 * `firmWorkspaceView.ts` is: the interesting decisions here are which controls are
 * offered and which are inert, and those are worth asserting without a browser.
 *
 * Three rules it applies, and it applies no others.
 *
 * **A control is offered only when it would work.** Not an admin, offline, or below
 * the minimum client version: the row renders with `editable: false` and a reason.
 * The server refuses it anyway; showing an enabled control that is about to be
 * refused is the thing that makes a person distrust the page.
 *
 * **A figure that cannot be computed says so.** `{ available: false }` from the
 * dashboard becomes an explicit "not in this build, owned by G7-2" panel rather than
 * a zero. Zero is a measurement.
 *
 * **Nothing is computed from a setting's value.** Whether sending is effectively on
 * is the API's answer, read out. A second implementation of that AND on the client
 * would be a second place for 16.2 to be wrong.
 */

export interface SettingRowView {
  readonly settingKey: string;
  readonly label: string;
  readonly version: number;
  /** "Default" when no admin has set it, otherwise when and by whom. */
  readonly provenance: string;
  readonly value: unknown;
  readonly editable: boolean;
  readonly notEditableBecause: string | null;
}

export interface ElsewhereRowView {
  readonly topic: string;
  readonly path: string;
  readonly ownedBy: string;
}

export interface PanelView {
  readonly title: string;
  readonly lines: readonly string[];
  /** Set when the figures behind this panel are not in the build. */
  readonly unavailable: string | null;
}

export interface SendingAdminSectionView {
  /** The checklist as one sentence, naming what is still missing. */
  readonly domainLine: string;
  readonly domain: string | null;
  readonly editable: boolean;
  readonly notEditableBecause: string | null;
  /**
   * 12.6's rolling personal-Gmail guard. Shown and never offered: G7-2 gave it no
   * route on purpose, because changing it is a reviewed policy change.
   */
  readonly guard: {
    readonly line: string;
    readonly editable: false;
    readonly readOnlyBecause: string;
  };
  readonly ramps: readonly {
    readonly mailboxId: string;
    readonly line: string;
    readonly editable: boolean;
  }[];
}

/** Why the guard has no control, in the words the page shows. */
const GUARD_READ_ONLY =
  'Section 12.6 makes changing the personal-Gmail guard a reviewed policy change, so there is no control for it here.';

export interface AdminView {
  readonly screen: AdminState['screen'];
  readonly notice: string | null;
  readonly banner: string | null;
  readonly settings: readonly SettingRowView[];
  readonly elsewhere: readonly ElsewhereRowView[];
  readonly sending: { readonly line: string; readonly editable: boolean } | null;
  /** G7-2's section. Null for anybody who is not an admin. */
  readonly sendingAdmin: SendingAdminSectionView | null;
  /** G8's holiday calendar: what it is now, and whether this person may replace it. */
  readonly holidays: {
    readonly version: string;
    readonly dates: readonly string[];
    readonly line: string;
    readonly editable: boolean;
    readonly notEditableBecause: string | null;
  } | null;
  readonly stages: readonly {
    readonly key: string;
    readonly label: string;
    readonly administrable: boolean;
    readonly note: string | null;
  }[];
  readonly panels: readonly PanelView[];
  readonly alerts: readonly {
    readonly alertId: string;
    readonly label: string;
    readonly runbookPath: string | null;
    readonly acknowledgeable: boolean;
  }[];
}

const LABELS: Readonly<Record<string, string>> = Object.freeze({
  alert_thresholds: 'Alarm thresholds',
  business_time_zone: 'Workspace business zone',
  client_version_range: 'Supported client versions',
  postal_footer: 'Postal footer',
  sending_enabled: 'Production sending',
});

/** Why a control is inert, in the order a person would want to be told. */
function inertBecause(state: AdminState): string | null {
  if (!state.online) return 'offline';
  if (!state.mayMutate) return 'upgrade_required';
  if (state.role !== 'admin') return 'admin_only';
  return null;
}

function provenanceOf(entry: { version: number; changedAt: string | null }): string {
  if (entry.version === 0 || entry.changedAt === null) return 'Default, never configured';
  return `Version ${String(entry.version)}, changed ${entry.changedAt}`;
}

function seconds(value: number | null): string {
  return value === null ? 'never' : `${String(Math.round(value))}s`;
}

/** `key: count, key: count`, or "none" for an empty breakdown. Never a bare blank. */
function keyed(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'none';
  return value
    .map(entry => {
      const row = entry as { key?: unknown; count?: unknown };
      return `${String(row.key)}: ${String(row.count)}`;
    })
    .join(', ');
}

/**
 * 13.4's drift, as a sentence that is honest when nobody has confirmed anything.
 *
 * A rate of null is not zero: "nobody corrected the model" and "nobody looked at a
 * reply" are the same numerator and completely different news.
 */
function driftLine(facts: Readonly<Record<string, unknown>>): string {
  const confirmations = Number(facts['confirmations']);
  if (confirmations === 0) return 'No reply was confirmed in this window, so there is no drift to report.';
  const rate = facts['correctionRate'];
  const percent = typeof rate === 'number' ? `${String(Math.round(rate * 100))}%` : 'unknown';
  return `${String(facts['corrected'])} corrected of ${String(confirmations)} confirmed (${percent}). By suggester: ${keyed(facts['correctedBySuggester'])}.`;
}

export function adminViewOf(state: AdminState): AdminView {
  const reason = inertBecause(state);
  const editable = reason === null;

  const settings = (state.settings?.settings ?? []).map(entry => ({
    settingKey: entry.settingKey,
    label: LABELS[entry.settingKey] ?? entry.settingKey,
    version: entry.version,
    provenance: provenanceOf(entry),
    value: entry.value,
    editable,
    notEditableBecause: reason,
  }));

  const elsewhere = (state.settings?.elsewhere ?? SETTINGS_ELSEWHERE_FALLBACK).map(entry => ({
    topic: entry.topic,
    path: entry.path,
    ownedBy: entry.ownedBy,
  }));

  // 16.2's two switches, read out rather than recombined.
  const sending =
    state.settings === null
      ? null
      : {
          line: state.settings.effectiveSendingEnabled
            ? 'Production sending is enabled.'
            : state.settings.deploymentSendingEnabled
              ? 'Enabled by the release process; an admin has not enabled it.'
              : 'The release process has not enabled sending on this deployment.',
          editable,
        };

  const stages = state.stages.map(stage => ({
    key: stage.key,
    label: `${stage.displayName}${stage.retired ? ' (retired)' : ''}`,
    // 8.1: "rename, reorder, add, or retire *nonterminal* stages".
    administrable: editable && stage.terminalKind === null,
    note:
      stage.terminalKind !== null
        ? 'Won and Lost are terminal and cannot be renamed, reordered or retired.'
        : reason,
  }));

  return {
    screen: state.screen,
    notice: state.notice,
    banner: state.online ? null : 'Offline. This page is a snapshot and nothing can be changed.',
    settings,
    elsewhere,
    sending,
    sendingAdmin: sendingAdminSection(state, reason),
    holidays:
      state.settings === null
        ? null
        : {
            version: state.settings.holidayCalendar.version,
            dates: state.settings.holidayCalendar.dates,
            // A calendar is superseded, never edited, so the current version is
            // named: the next one has to be a different name, and a person about to
            // choose one should see what is taken.
            line:
              state.settings.holidayCalendar.dates.length === 0
                ? `No holidays are configured (version "${state.settings.holidayCalendar.version}"). Weekends are skipped by the rule, not by this list.`
                : `Version "${state.settings.holidayCalendar.version}": ${String(state.settings.holidayCalendar.dates.length)} dates.`,
            editable,
            notEditableBecause: reason,
          },
    stages,
    panels: [...dashboardPanels(state), ...diagnosticsPanels(state)],
    alerts: (state.diagnostics?.alerts ?? []).map(alert => ({
      alertId: alert.id,
      label: `${alert.severity}: ${alert.alertKey}${alert.acknowledgedAt === null ? '' : ' (acknowledged)'}`,
      runbookPath: alert.runbookPath,
      acknowledgeable: editable && alert.acknowledgedAt === null,
    })),
  };
}

/**
 * G7-2's sending section (12.6, 12.7).
 *
 * Absent rather than inert for a salesperson: every `/outbound/*` path is admin-only
 * with a redacted 403, and a control that answers 403 is worse than no control.
 *
 * The checklist line names what is missing rather than offering an enable the
 * database will refuse — `sending_domains` has a CHECK forbidding
 * `automated_sending_enabled` without all four — but it decides nothing: what
 * "passes" means is `authenticationPasses` as the server computed it.
 */
function sendingAdminSection(state: AdminState, reason: string | null): SendingAdminSectionView | null {
  const posture = state.sendingAdmin;
  if (state.role !== 'admin' || posture === null) return null;
  const editable = reason === null;
  const domain = posture.domain;

  const missing =
    domain === null
      ? []
      : [
          domain.spfPass ? null : 'spf',
          domain.dkimPass ? null : 'dkim',
          domain.dmarcPass ? null : 'dmarc',
          domain.postmasterReviewedAt === null ? 'postmaster review' : null,
        ].filter((item): item is string => item !== null);

  const domainLine =
    domain === null
      ? 'No sending domain is configured.'
      : domain.authenticationPasses
        ? `${domain.domain}: authentication passes; automated sending ${domain.automatedSendingEnabled ? 'enabled' : 'not enabled'}.`
        : `${domain.domain}: authentication incomplete — still needed: ${missing.join(', ')}.`;

  return {
    domainLine,
    domain: domain?.domain ?? null,
    editable,
    notEditableBecause: reason,
    guard: {
      line:
        domain === null
          ? `Personal-Gmail guard: unknown. ${String(posture.personalGmailRecipients)} recipients in the last 24 hours.`
          : `Personal-Gmail guard: ${String(domain.personalGmailGuardPer24h)} per 24 hours, ${String(posture.personalGmailRecipients)} used.`,
      editable: false,
      readOnlyBecause: GUARD_READ_ONLY,
    },
    ramps: posture.ramps.map(ramp => ({
      mailboxId: ramp.mailboxId,
      line: `${String(ramp.healthySendingDays)} healthy days, cap ${String(ramp.effectiveCap)}${
        ramp.adminDailyCap === null ? '' : ` (lowered to ${String(ramp.adminDailyCap)})`
      }${ramp.raisedDailyCap === null ? '' : ` (raised to ${String(ramp.raisedDailyCap)})`}${
        ramp.lastHealthFailure === null ? '' : `; last health failure: ${ramp.lastHealthFailure}`
      }.`,
      editable,
    })),
  };
}

function dashboardPanels(state: AdminState): readonly PanelView[] {
  const dashboard = state.dashboard;
  if (state.screen !== 'dashboard' || dashboard === null) return [];

  const absence = (figure: { available: boolean; owner?: string; reason?: string }): string | null =>
    figure.available ? null : `Not in this build (${figure.owner ?? 'unknown'}): ${figure.reason ?? ''}`.trim();

  /** Lines only when the figure exists. An unavailable panel shows its reason alone. */
  const linesOf = (
    figure: { available: boolean },
    render: (facts: Readonly<Record<string, unknown>>) => readonly string[],
  ): readonly string[] =>
    figure.available ? render(figure as unknown as Readonly<Record<string, unknown>>) : [];

  return [
    {
      title: 'Scope',
      lines: [
        dashboard.audience === 'workspace' ? 'Every firm in the workspace.' : 'Your assigned firms.',
        `${String(dashboard.firmsInScope)} firms, ${dashboard.window.from} to ${dashboard.window.to}.`,
      ],
      unavailable: null,
    },
    {
      title: 'Email',
      lines: [
        `Replies: ${String(dashboard.messages.human)} human, ${String(dashboard.messages.uncertain)} uncertain.`,
        `Bounces: ${String(dashboard.messages.bounces)}. Opt-outs: ${String(dashboard.messages.optOuts)}.`,
      ],
      unavailable: absence(dashboard.sending),
    },
    {
      title: 'Reply handling',
      lines: [
        `${String(dashboard.replyHandling.handled)} of ${String(dashboard.replyHandling.replies)} handled.`,
        `Median ${seconds(dashboard.replyHandling.medianSecondsToHandle)}, slowest ${seconds(dashboard.replyHandling.slowestSecondsToHandle)}.`,
      ],
      unavailable: null,
    },
    {
      title: 'Calls',
      lines: dashboard.calls.map(entry => `${entry.key}: ${String(entry.count)}`),
      unavailable: null,
    },
    {
      title: 'Stage movement',
      lines: dashboard.stageMovement.map(entry => `${entry.key}: ${String(entry.count)}`),
      unavailable: null,
    },
    {
      title: 'Holds',
      lines: dashboard.holds.byReason.map(
        entry => `${entry.reasonCode}: ${String(entry.count)}, oldest ${seconds(entry.oldestAgeSeconds)}`,
      ),
      unavailable: null,
    },
    {
      title: 'Sequences',
      lines: linesOf(dashboard.enrollments, facts => [
        `${String(facts['started'])} started; ${String(facts['active'])} active now, ${String(facts['reviewRequired'])} awaiting review.`,
        `Ended: ${keyed(facts['ended'])}`,
        `Steps completed: ${keyed(facts['stepsCompleted'])}`,
        `Held now: ${keyed(facts['heldSteps'])}`,
      ]),
      unavailable: absence(dashboard.enrollments),
    },
    {
      title: 'LinkedIn',
      lines: linesOf(dashboard.enrollments, facts => [
        `${String(facts['linkedinHandoffs'])} handed off.`,
        `Recorded: ${String(facts['linkedinRecordedReplies'])} replied, ${String(facts['linkedinNoEngagement'])} no engagement.`,
      ]),
      unavailable: absence(dashboard.enrollments),
    },
    {
      title: 'Classifier',
      lines: linesOf(dashboard.classifier, facts => [
        `${facts['enabled'] === true ? 'Enabled' : 'Disabled'}: ${String(facts['modelName'])} at effort ${String(facts['effort'])}, cap ${String(facts['dailyCallCap'])} a day.`,
        `${String(facts['callsAttempted'])} attempts, ${String(facts['callsSent'])} sent. ${keyed(facts['byOutcome'])}`,
        // Tokens, not money: nothing in this build records a price, and a figure in
        // dollars here would be this page inventing one.
        `Tokens: ${String(facts['inputTokens'])} in (${String(facts['cachedInputTokens'])} cached), ${String(facts['outputTokens'])} out.`,
        driftLine(facts),
      ]),
      unavailable: absence(dashboard.classifier),
    },
  ];
}

function diagnosticsPanels(state: AdminState): readonly PanelView[] {
  const report = state.diagnostics;
  if (state.screen !== 'diagnostics' || report === null) return [];

  return [
    {
      title: 'Schema and client',
      lines: [
        `Database at version ${String(report.schema.appliedVersion)}; this API accepts ${String(report.schema.declaredRange.minimum)}–${String(report.schema.declaredRange.maximum)}.`,
        report.schema.accepted ? 'Accepted.' : 'The database is outside the accepted range.',
        `Clients ${report.clientVersions.minimum} to ${report.clientVersions.maximum}.`,
      ],
      unavailable: null,
    },
    {
      title: 'Production sending',
      lines: [
        `Release process: ${report.sending.deploymentEnabled ? 'enabled' : 'disabled'}.`,
        `Admin: ${report.sending.adminEnabled ? 'enabled' : 'disabled'}.`,
        `Effective: ${report.sending.effective ? 'enabled' : 'disabled'}.`,
      ],
      unavailable: null,
    },
    {
      title: 'Restore generation',
      lines: [
        `Database ${report.restore.systemGeneration === null ? 'unknown' : String(report.restore.systemGeneration)}, expected ${report.restore.expectedSystemGeneration === null ? 'unpinned' : String(report.restore.expectedSystemGeneration)}.`,
        report.restore.mismatch
          ? 'Mismatch. Sending and dialling are held until the post-restore protocol completes.'
          : 'Matches.',
      ],
      unavailable: null,
    },
    {
      title: 'Jobs',
      lines: [
        `${String(report.jobs.runnable)} runnable, ${String(report.jobs.running)} running, ${String(report.jobs.dead)} dead.`,
        `Oldest runnable ${seconds(report.jobs.oldestRunnableAgeSeconds)}; oldest dead ${seconds(report.jobs.oldestDeadAgeSeconds)}.`,
      ],
      unavailable: null,
    },
    {
      title: 'Heartbeats and canary',
      lines: [
        ...report.heartbeats.map(
          beat => `${beat.component}/${beat.instanceKey}: ${beat.fresh ? 'fresh' : 'stale'} (${seconds(beat.ageSeconds)})`,
        ),
        `Canary last completed ${seconds(report.canaryCompletionAgeSeconds)} ago.`,
      ],
      unavailable: null,
    },
    {
      title: report.mailboxVisibility === 'all' ? 'Mailboxes' : 'Your mailbox',
      lines: report.mailboxes.map(
        mailbox =>
          `${mailbox.status}/${mailbox.syncState}: covered to ${mailbox.coverageWatermarkAt ?? 'never'}, watch expires ${mailbox.watchExpiresAt ?? 'never'}${mailbox.automationHeld ? ', automation held' : ''}`,
      ),
      unavailable: null,
    },
  ];
}
