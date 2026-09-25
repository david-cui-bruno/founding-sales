import {
  alertAcknowledgedResponseSchema,
  callbackInstant,
  callingIdentityChangeResultSchema,
  callingIdentityListSchema,
  dashboardResponseSchema,
  diagnosticsResponseSchema,
  outboundStatusResponseSchema,
  pipelineStagesResponseSchema,
  postureReferenceResponseSchema,
  settingHistoryResponseSchema,
  settingsSnapshotSchema,
  statePostureListResponseSchema,
  statePostureViewSchema,
  type CallingIdentityDto,
  type SettingKey,
} from '@fss/contracts';
import { businessZoneOf } from '../renderer/postureView.ts';
import type {
  AddCallingNumberInput,
  AdminScreen,
  AdminState,
  CallingNumberView,
  PipelineStageRowView,
  PosturesState,
  RecordHolidayCalendarInput,
  RecordPostureInput,
  RecordSendingAuthenticationInput,
  SaveSettingInput,
  SetSendingCapInput,
} from '../renderer/settingsContract.ts';
import type { AuthedClient } from './authedClient.ts';

/**
 * The administration window's half of the bridge, in the main process
 * (specification 10.1, 13.3, 13.4, 14.2).
 *
 * The same shape as G6's Today and CRM bridges, and for the same reasons: the
 * renderer is handed a state and never a token, every mutation goes through
 * `command` so the 5.3 envelope cannot be forgotten, and a refusal arrives as a
 * stable code the view turns into one sentence.
 *
 * It computes nothing. `effectiveSendingEnabled` is read out of the settings
 * response rather than recomputed, the dashboard's audience is whatever the server
 * decided, and a stage's administrability is the terminal flag the server sent. A
 * client that recomputed any of those would be a second implementation of a rule
 * that has to have exactly one.
 */

export const ADMIN_IPC_CHANNELS = {
  state: 'callie:admin:state',
  show: 'callie:admin:show',
  saveSetting: 'callie:admin:save-setting',
  openHistory: 'callie:admin:open-history',
  loadDashboard: 'callie:admin:load-dashboard',
  createStage: 'callie:admin:create-stage',
  renameStage: 'callie:admin:rename-stage',
  reorderStages: 'callie:admin:reorder-stages',
  retireStage: 'callie:admin:retire-stage',
  acknowledgeAlert: 'callie:admin:acknowledge-alert',
  setSendingCap: 'callie:admin:set-sending-cap',
  recordSendingAuthentication: 'callie:admin:record-sending-authentication',
  recordHolidayCalendar: 'callie:admin:record-holiday-calendar',
  addCallingNumber: 'callie:admin:add-calling-number',
  attestCallingNumber: 'callie:admin:attest-calling-number',
  retireCallingNumber: 'callie:admin:retire-calling-number',
  // Lane g84: the postures form.
  recordPosture: 'callie:admin:record-posture',
  revokePosture: 'callie:admin:revoke-posture',
} as const;
export type AdminIpcChannel = (typeof ADMIN_IPC_CHANNELS)[keyof typeof ADMIN_IPC_CHANNELS];

/**
 * The calling-number paths (lane g60), named once so the release suite can compare them
 * with the API's own `CALLING_IDENTITY_PATHS` rather than with a second copy.
 */
export const CALLING_NUMBER_API_PATHS = {
  list: '/calling-identities',
  register: '/calling-identities/register',
  attest: '/calling-identities/attest',
  disable: '/calling-identities/disable',
} as const;

/** The postures paths (lane g84), named once for the release suite to compare with `POSTURE_PATHS`. */
export const POSTURE_API_PATHS = {
  list: '/postures',
  reference: '/postures/reference',
  record: '/postures/record',
  revoke: '/postures/revoke',
} as const;

/**
 * The posture form as `POST /postures/record` takes it, or null when a date is not one.
 *
 * A date is midnight of that day in the business zone, through the domain's own clock
 * (`callbackInstant` from `@fss/contracts`), so a posture "from 25 September" is in force
 * from the first minute of the 25th where the workspace keeps its days. An empty review
 * date is left out and the server sets it a year on (10.1). The statements go as ticked:
 * whether they are all of them is the server's refusal to make.
 */
export function recordPostureBody(input: RecordPostureInput, zone: string): Readonly<Record<string, unknown>> | null {
  const effectiveFrom = callbackInstant(input.effectiveFromDate, '00:00', zone);
  if (effectiveFrom === null) return null;
  const review = input.reviewDate.trim();
  const reviewAt = review === '' ? undefined : callbackInstant(review, '00:00', zone);
  if (reviewAt === null) return null;
  return {
    state: input.state.trim().toUpperCase(),
    effectiveFrom,
    ...(reviewAt === undefined ? {} : { reviewAt }),
    confirmedStatements: [...input.confirmedStatements],
    ...(input.note.trim() === '' ? {} : { note: input.note.trim() }),
  };
}

/*
 * Every answer this window reads is parsed with `@fss/contracts`' schema for its route
 * (lane g78): the calling-number change, the stages, the settings history, the alert
 * acknowledgement and `POST /outbound/status`. The routes' own tests hold their real
 * answers to the same schemas through `wireDrift`.
 *
 * Two of the copies that were here had cost something. The history schema kept four
 * fields of each version and stripped `value` and `current`, so History showed dates
 * and notes and never what changed (D04). The outbound schema was `.loose()` all the
 * way down, which is how `personalGmailRecipients` could be read as a number for two
 * releases while unchecked fields rode along (release.md 8.0ae, D07).
 */

export interface AdminBridgeDeps {
  readonly api: AuthedClient;
  readonly session: {
    state(): Promise<{
      readonly online: boolean;
      readonly mayMutate: boolean;
      readonly device: { readonly role: 'admin' | 'salesperson' } | null;
    }>;
  };
  /** The default dashboard window, so the page has something to show on open. */
  readonly now?: () => Date;
}

export interface AdminBridgeHost {
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
  recordPosture(input: RecordPostureInput): Promise<AdminState>;
  revokePosture(input: { readonly postureId: string }): Promise<AdminState>;
}

/** The last 30 days, in UTC. A window the page shows and a person may change. */
function defaultWindow(now: Date): { readonly from: string; readonly to: string } {
  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function createAdminBridge(deps: AdminBridgeDeps): AdminBridgeHost {
  const clock = deps.now ?? ((): Date => new Date());
  let screen: AdminScreen = 'settings';
  let notice: string | null = null;
  let settings: AdminState['settings'] = null;
  let dashboard: AdminState['dashboard'] = null;
  let diagnostics: AdminState['diagnostics'] = null;
  let stages: readonly PipelineStageRowView[] = [];
  let history: AdminState['history'] = null;
  let sendingAdmin: AdminState['sendingAdmin'] = null;
  let sendingReadError: AdminState['sendingReadError'] = null;
  let callingNumbers: AdminState['callingNumbers'] = null;
  let postures: PosturesState | null = null;
  /** The role the state above was read under, or null before the first read. */
  let roleSeen: AdminState['role'] | null = null;
  const window = defaultWindow(clock());

  /**
   * The session's role, and the end of everything read under a different one (lane g69).
   *
   * A renewal carries the membership's current role and the session manager applies it,
   * so the role can change under an open window. The sending posture, the diagnostics
   * and the dashboard were each read, or not read, because of the old role: an admin
   * demoted keeps an outbound posture they may no longer see, and a salesperson made
   * admin keeps the "not read" the salesperson's page never asked for. So all three
   * are dropped, and the next read derives them again under the role the server gave.
   */
  const currentRole = async (): Promise<{ readonly role: AdminState['role']; readonly online: boolean; readonly mayMutate: boolean }> => {
    const session = await deps.session.state();
    const role = session.device?.role ?? 'salesperson';
    if (roleSeen !== null && roleSeen !== role) {
      sendingAdmin = null;
      sendingReadError = null;
      diagnostics = null;
      dashboard = null;
    }
    roleSeen = role;
    return { role, online: session.online, mayMutate: session.mayMutate };
  };

  const snapshot = async (): Promise<AdminState> => {
    const session = await currentRole();
    return {
      screen,
      role: session.role,
      online: session.online,
      mayMutate: session.mayMutate,
      notice,
      settings,
      dashboard,
      diagnostics,
      stages,
      history,
      sendingAdmin,
      sendingReadError,
      callingNumbers,
      postures,
    };
  };

  const isAdmin = async (): Promise<boolean> => (await currentRole()).role === 'admin';

  /**
   * G7-2's sending posture, in three reads, for an admin only.
   *
   * `/outbound/status` answers the domain checklist and the guard with no argument,
   * but a ramp only for a named mailbox — there is no list form, and adding one is
   * G7-2's decision to make, not this window's. So the mailbox ids come from
   * `/diagnostics`, which already applies Appendix F row 3 to them, and each ramp is
   * asked for by id. `mailboxes_one_per_owner` bounds that at one per member.
   *
   * A failure here is not a notice: the settings page has ten other sections and a
   * person who opened it to change the business time zone should not be told about an
   * outbound read they did not ask for. It is not silence either. Until lane g69 a
   * failed read left `sendingAdmin` null and the section simply did not appear, which is
   * how a parse failure on every answer went unseen in production (release.md 8.0ae). The
   * refusal code is kept as `sendingReadError`, the section says it could not read the
   * status and offers Retry, and `state()` asks again while it is set.
   */
  const loadSending = async (): Promise<void> => {
    if (!(await isAdmin())) {
      sendingAdmin = null;
      sendingReadError = null;
      return;
    }
    // Every `/outbound/*` path is a POST, the read included (`apps/api/src/routes/outbound.ts`):
    // `read` sends GET when it is given no body, and the API answered that with 405 on every
    // Administration open in production (25 September 2026), so this section never rendered.
    // The empty body is what makes it the POST the route expects.
    const status = await deps.api.read('/outbound/status', value => outboundStatusResponseSchema.parse(value), {});
    if (!status.ok) {
      sendingAdmin = null;
      sendingReadError = status.reason;
      return;
    }
    const report = await deps.api.read('/diagnostics', value => diagnosticsResponseSchema.parse(value));
    const collected: {
      mailboxId: string;
      healthySendingDays: number;
      effectiveCap: number;
      adminDailyCap: number | null;
      raisedDailyCap: number | null;
      lastHealthFailure: string | null;
    }[] = [];
    if (report.ok) {
      for (const mailbox of report.value.mailboxes) {
        const one = await deps.api.read('/outbound/status', value => outboundStatusResponseSchema.parse(value), {
          mailboxId: mailbox.mailboxId,
        });
        if (one.ok && one.value.ramp !== null) {
          collected.push({
            mailboxId: one.value.ramp.mailboxId,
            healthySendingDays: one.value.ramp.healthySendingDays,
            effectiveCap: one.value.ramp.effectiveCap,
            adminDailyCap: one.value.ramp.adminDailyCap,
            raisedDailyCap: one.value.ramp.raisedDailyCap,
            lastHealthFailure: one.value.ramp.lastHealthFailure,
          });
        }
      }
    }
    sendingAdmin = {
      domain:
        status.value.domain === null
          ? null
          : {
              domain: status.value.domain.domain,
              spfPass: status.value.domain.spfPass,
              dkimPass: status.value.domain.dkimPass,
              dmarcPass: status.value.domain.dmarcPass,
              postmasterReviewedAt: status.value.domain.postmasterReviewedAt,
              authenticationPasses: status.value.domain.authenticationPasses,
              automatedSendingEnabled: status.value.domain.automatedSendingEnabled,
              personalGmailGuardPer24h: status.value.domain.personalGmailGuardPer24h,
            },
      // The whole guard: FSS's own sends and the direct ones the sync imported (12.7,
      // "All outgoing Gmail messages, including direct sends, count").
      personalGmailRecipients: status.value.personalGmailRecipients.total,
      ramps: collected,
    };
    sendingReadError = null;
  };

  /**
   * The person's own calling numbers (lane g60), for every role.
   *
   * A failure is not a notice, for `loadSending`'s reason: a person who opened the page
   * to change something else should not be told about a read they did not ask for. The
   * section says the list could not be read instead (`callingNumbers: null`), because
   * an empty list would read as "you have no number" and invite a second registration.
   */
  const loadCallingNumbers = async (): Promise<void> => {
    const answer = await deps.api.read(CALLING_NUMBER_API_PATHS.list, value => callingIdentityListSchema.parse(value));
    callingNumbers = answer.ok ? answer.value.identities.map(viewOfNumber) : null;
  };

  /**
   * The postures and the texts the form shows (lane g84), for every role: 9.2 refuses a
   * salesperson's call over a missing posture, so a salesperson may read which. The
   * reference texts are the release's and do not change under an open window, so they
   * are read once. A failure is the section's grey line, not the page's notice.
   */
  const loadPostures = async (): Promise<void> => {
    const known = postures?.reference ?? null;
    const reference =
      known !== null
        ? { ok: true as const, value: known }
        : await deps.api.read(POSTURE_API_PATHS.reference, value => postureReferenceResponseSchema.parse(value));
    const listed = await deps.api.read(POSTURE_API_PATHS.list, value => statePostureListResponseSchema.parse(value));
    postures = {
      reference: reference.ok ? reference.value : null,
      records: listed.ok ? listed.value.postures : null,
      readError: !reference.ok ? reference.reason : !listed.ok ? listed.reason : null,
    };
  };

  const loadSettings = async (): Promise<void> => {
    const answer = await deps.api.read('/settings', value => settingsSnapshotSchema.parse(value));
    if (!answer.ok) {
      notice = answer.reason;
    } else {
      settings = answer.value;
      const stageAnswer = await deps.api.read('/pipeline/stages', value => pipelineStagesResponseSchema.parse(value));
      if (stageAnswer.ok) {
        stages = stageAnswer.value.stages.map(stage => ({
          key: stage.key,
          displayName: stage.displayName,
          position: stage.position,
          terminalKind: stage.terminalKind,
          retired: stage.retired,
        }));
      }
    }
    // Neither the sending posture nor the calling number depends on the workspace
    // settings, so a page whose settings read failed still reads both (lanes g60, g69).
    // Until g69 a failed `/settings` returned before the sending read was even asked.
    await loadSending();
    await loadCallingNumbers();
    await loadPostures();
  };

  /** One `/dashboard` read over the window named. It changes nothing but `dashboard`. */
  const readDashboard = async (range: { readonly from: string; readonly to: string }): Promise<void> => {
    const answer = await deps.api.read('/dashboard', value => dashboardResponseSchema.parse(value), {
      window: range,
    });
    if (!answer.ok) {
      notice = answer.reason;
      return;
    }
    dashboard = answer.value;
  };

  const loadDiagnostics = async (): Promise<void> => {
    const answer = await deps.api.read('/diagnostics', value => diagnosticsResponseSchema.parse(value));
    if (!answer.ok) {
      notice = answer.reason;
      return;
    }
    diagnostics = answer.value;
  };

  /** Run a command, then re-read the slice it changed. Never patch local state. */
  const afterCommand = async (
    outcome: { readonly ok: boolean; readonly reason?: string },
    reload: () => Promise<void>,
  ): Promise<AdminState> => {
    if (!outcome.ok) {
      notice = outcome.reason ?? 'refused';
      return await snapshot();
    }
    notice = null;
    await reload();
    return await snapshot();
  };

  return {
    async state() {
      const { role } = await currentRole();
      if (settings === null) await loadSettings();
      // Home reads through here on every focus and on Refresh. An admin's posture that
      // is not held — the last read failed, or the role just became admin — is asked
      // for again rather than left as the first answer (lane g69). A read that
      // succeeded is not repeated: that is what `show` and the commands are for.
      else if (role === 'admin' && sendingAdmin === null) await loadSending();
      return await snapshot();
    },

    async show(input) {
      notice = null;
      screen = input.screen;
      if (input.screen === 'settings') await loadSettings();
      if (input.screen === 'dashboard') await readDashboard(window);
      if (input.screen === 'diagnostics') await loadDiagnostics();
      return await snapshot();
    },

    async saveSetting(input) {
      const outcome = await deps.api.command(
        '/settings/update',
        { settingKey: input.settingKey, value: input.value, changeNote: input.changeNote },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async openHistory(input) {
      const answer = await deps.api.read('/settings/history', value => settingHistoryResponseSchema.parse(value), {
        settingKey: input.settingKey,
      });
      if (!answer.ok) {
        notice = answer.reason;
        return await snapshot();
      }
      // The whole answer, values included (D04): what each version set, and what is in
      // force now. The view decides how to show old and new; the bridge keeps both.
      history = answer.value;
      return await snapshot();
    },

    async loadDashboard(input) {
      // Home's "Last 7 days" reads through here (lane g65), often while Administration is
      // open in its own window on another screen. This host is one object behind both
      // windows, so the read moves neither the screen Administration shows nor the
      // window its Dashboard reads. Until g65 it set both, and the next command
      // Administration sent came back drawn on the Dashboard screen. A caller checks
      // the answer's `dashboard.window` against the window it asked for: a failed read
      // leaves the previous figures in place.
      notice = null;
      await readDashboard(input);
      return await snapshot();
    },

    async createStage(input) {
      const outcome = await deps.api.command(
        '/pipeline/stages/create',
        { key: input.key, displayName: input.displayName },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async renameStage(input) {
      const outcome = await deps.api.command(
        '/pipeline/stages/rename',
        { stageKey: input.stageKey, displayName: input.displayName },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async reorderStages(input) {
      const outcome = await deps.api.command(
        '/pipeline/stages/reorder',
        { stageKeys: [...input.stageKeys] },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async retireStage(input) {
      const outcome = await deps.api.command(
        '/pipeline/stages/retire',
        { stageKey: input.stageKey },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async acknowledgeAlert(input) {
      // G5's acknowledge is not a receipted command: it is admin-only, audited, and
      // answers `{ acknowledged: true, alertKey }`. Calling it through `command`
      // would add a command id the endpoint does not read.
      const answer = await deps.api.read('/admin/alerts/acknowledge', value => alertAcknowledgedResponseSchema.parse(value), {
        alertId: input.alertId,
      });
      return await afterCommand(
        answer.ok ? { ok: true } : { ok: false, reason: answer.reason },
        loadDiagnostics,
      );
    },

    async setSendingCap(input) {
      // 12.7: an admin may lower a cap, and may raise a mailbox to 75. The command
      // refuses above that rather than clamping, and the CHECK refuses above 100.
      // Neither bound is repeated here: a client that clamped would turn a refusal
      // an admin should see into a silent change they did not ask for.
      const outcome = await deps.api.command(
        '/outbound/cap',
        {
          mailboxId: input.mailboxId,
          // Absent and null are different to `setAdminCap`: null clears the
          // lowering, absent leaves it alone. Spread so an unset key stays unset.
          ...(input.lowerTo === undefined ? {} : { lowerTo: input.lowerTo }),
          ...(input.raiseTo === undefined ? {} : { raiseTo: input.raiseTo }),
        },
        value => value,
      );
      return await afterCommand(outcome, loadSending);
    },

    async recordSendingAuthentication(input) {
      // 12.7's checklist is a person saying they looked: FSS never queries DNS, so
      // this is a record of a human observation, not a measurement.
      const outcome = await deps.api.command(
        '/outbound/authentication',
        {
          domain: input.domain,
          spfPass: input.spfPass,
          dkimPass: input.dkimPass,
          dmarcPass: input.dmarcPass,
          postmasterReviewed: input.postmasterReviewed,
          automatedSendingEnabled: input.automatedSendingEnabled,
        },
        value => value,
      );
      return await afterCommand(outcome, loadSending);
    },

    async recordHolidayCalendar(input) {
      // G8's command, not one of this lane's. The calendar is a versioned row whose
      // version is frozen onto every due instant computed under it, which is why it
      // is not a slice of `workspace_settings` — see
      // docs/decisions/g9-two-slices-that-belong-to-other-lanes.md. The settings
      // page owns the surface; G8 owns the write.
      const outcome = await deps.api.command(
        '/sequences/holidays',
        { version: input.version, dates: [...input.dates] },
        value => value,
      );
      // Reloaded through `/settings`, because that is where the current calendar is
      // carried: the page never patches its own copy from a command's answer.
      return await afterCommand(outcome, loadSettings);
    },

    async addCallingNumber(input) {
      // Two commands, because the server keeps them apart: a registration is a claim
      // and the attestation is the person's statement about it, each with its own
      // receipt. The number goes as typed — normalizing it is the server's, and a
      // client that "fixed" a number would be a second implementation of 9.1's rule.
      const registered = await deps.api.command(
        CALLING_NUMBER_API_PATHS.register,
        { e164: input.e164, ...(input.label.trim() === '' ? {} : { label: input.label }) },
        value => callingIdentityChangeResultSchema.parse(value),
      );
      if (!registered.ok || !input.attested) return await afterCommand(registered, loadCallingNumbers);
      const attested = await deps.api.command(
        CALLING_NUMBER_API_PATHS.attest,
        { identityId: registered.value.identity.id, attested: true },
        value => callingIdentityChangeResultSchema.parse(value),
      );
      if (!attested.ok) {
        // The registration committed and the attestation did not: the refusal is the
        // notice, and the list is re-read so the unattested number is on screen with
        // its own Attest button rather than looking as if nothing happened.
        notice = attested.reason;
        await loadCallingNumbers();
        return await snapshot();
      }
      return await afterCommand(attested, loadCallingNumbers);
    },

    async attestCallingNumber(input) {
      // 9.1's verification, in version one: the person saying this is the number they
      // place calls from. `attested: true` is the statement; the server records who made
      // it and when, and decides nothing else from the body.
      const outcome = await deps.api.command(
        CALLING_NUMBER_API_PATHS.attest,
        { identityId: input.identityId, attested: true },
        value => callingIdentityChangeResultSchema.parse(value),
      );
      return await afterCommand(outcome, loadCallingNumbers);
    },

    async retireCallingNumber(input) {
      const outcome = await deps.api.command(
        CALLING_NUMBER_API_PATHS.disable,
        { identityId: input.identityId },
        value => callingIdentityChangeResultSchema.parse(value),
      );
      return await afterCommand(outcome, loadCallingNumbers);
    },

    async recordPosture(input) {
      // Invariant 7: the software records the founder's decision and the sources quoted
      // for it; the server copies the sources from the release, never from this body.
      const body = recordPostureBody(input, businessZoneOf(settings));
      if (body === null) {
        notice = 'posture_date_invalid';
        return await snapshot();
      }
      const outcome = await deps.api.command(POSTURE_API_PATHS.record, body, value => statePostureViewSchema.parse(value));
      const answered = await afterCommand(outcome, loadPostures);
      if (!outcome.ok) return answered;
      notice = 'posture_recorded';
      return await snapshot();
    },

    async revokePosture(input) {
      const outcome = await deps.api.command(POSTURE_API_PATHS.revoke, { postureId: input.postureId }, value =>
        statePostureViewSchema.parse(value),
      );
      const answered = await afterCommand(outcome, loadPostures);
      if (!outcome.ok) return answered;
      notice = 'posture_revoked';
      return await snapshot();
    },
  };
}

function viewOfNumber(row: CallingIdentityDto): CallingNumberView {
  return {
    id: row.id,
    e164: row.e164,
    label: row.label,
    verificationStatus: row.verificationStatus,
    enabled: row.enabled,
    verifiedAt: row.verifiedAt,
    verificationMethod: row.verificationMethod,
    disabledAt: row.disabledAt,
    usedForCalls: row.usedForCalls,
  };
}
