import {
  alertAcknowledgedResponseSchema,
  allowCallingStatesResultSchema,
  callingIdentityChangeResultSchema,
  callingIdentityListSchema,
  dashboardResponseSchema,
  diagnosticsResponseSchema,
  finishingResponseSchema,
  integrationsSettingsResponseSchema,
  outboundStatusResponseSchema,
  pipelineStagesResponseSchema,
  sendingDomainStatusSchema,
  postureReferenceResponseSchema,
  settingHistoryResponseSchema,
  settingsSnapshotSchema,
  statePostureListResponseSchema,
  statePostureViewSchema,
  type CallingIdentityDto,
  type FinishingResponse,
} from '@fss/contracts';
import type {
  ActiveSettingKey,
  AddCallingNumberInput,
  AdminScreen,
  AdminState,
  AllowStatesInput,
  CallingNumberView,
  PipelineStageRowView,
  PosturesState,
  RecordHolidayCalendarInput,
  RecordSendingAuthenticationInput,
  SaveIntegrationInput,
  SaveSettingInput,
  SetSendingCapInput,
} from '../renderer/settingsContract.ts';
import type { ApiOutcome } from './apiClient.ts';
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

/**
 * The calling-number paths (lane g60), named once so the release suite can compare them
 * with the API's own `CALLING_IDENTITY_PATHS` rather than with a second copy.
 */
export const CALLING_NUMBER_API_PATHS = {
  list: '/calling-identities',
  register: '/calling-identities/register',
  disable: '/calling-identities/disable',
} as const;

/** The postures paths, named once for the release suite to compare with `POSTURE_PATHS`. */
export const POSTURE_API_PATHS = {
  list: '/postures',
  reference: '/postures/reference',
  allow: '/postures/allow',
  revoke: '/postures/revoke',
} as const;

/**
 * The settings snapshot, with the postal address asked for by name.
 *
 * `GET /settings` leaves `postal_address` out unless a caller names it, because the
 * installed 1.0.11 parses the snapshot with its own build of a strict schema and an
 * unknown key would throw away all of its sections (`apps/api/src/routes/settings.ts`).
 * This build knows the key, so it asks for it.
 */
export const SETTINGS_READ_PATH = '/settings?include=postal_address';

/**
 * The call-to-booking settings, with slice C2's transcription and slice P1's month asked
 * for by name: the API
 * leaves it out unless asked, because a desktop built with slice S1 parses this answer
 * with its own strict schema. An API from before C2 ignores the parameter, and the
 * section then has no transcription row.
 */
export const INTEGRATIONS_READ_PATH = '/settings/integrations?include=transcription&include=month';

/**
 * Slice P1's read of what is still finishing after a switch went off. A path of its own,
 * so no answer an installed build parses strictly gains a field; an API from before P1
 * answers 404 and the sections show no finishing line.
 */
export const FINISHING_READ_PATH = '/settings/finishing';

/** The integration settings whose change can leave paid requests finishing (P1 final round, #7). */
const PAID_SWITCH_KEYS: ReadonlySet<string> = new Set(['call_transcription']);

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

/**
 * `/outbound/status` as this Mac reads it (wave 1): the contract's schema with the
 * deleted personal-Gmail guard's fields optional — the domain's `personalGmailGuardPer24h`
 * and `replyOnlyOptOut`, the `guard` decision and `personalGmailRecipients`. Lane W1-C
 * deleted the guard; the server sends constants for these until this build is the one
 * in use, then stops. A strict reader would turn that into "could not read the sending
 * status" on every open, so this one does not need them, and nothing reads them.
 */
export const outboundStatusReadSchema = outboundStatusResponseSchema
  .partial({ guard: true, personalGmailRecipients: true })
  .extend({
    domain: sendingDomainStatusSchema.partial({ personalGmailGuardPer24h: true, replyOnlyOptOut: true }).nullable(),
  });

/**
 * The note a setting change carries when nobody wrote one (wave 1). The note is optional
 * on the Mac; the server's history keeps one per version, so a Save with the field left
 * empty is sent with this rather than refused before it leaves.
 */
export const DEFAULT_CHANGE_NOTE = 'Changed on the Mac';

export function changeNoteOf(typed: string): string {
  const trimmed = typed.trim();
  return trimmed === '' ? DEFAULT_CHANGE_NOTE : trimmed;
}

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
  /** Drop the snapshot on an identity transition (1.0.13, P0-A). */
  forget(): Promise<AdminState>;
  state(): Promise<AdminState>;
  show(input: { readonly screen: AdminScreen }): Promise<AdminState>;
  saveSetting(input: SaveSettingInput): Promise<AdminState>;
  /** Settings → Calling & calendar: one of the four call-to-booking settings. */
  saveIntegration(input: SaveIntegrationInput): Promise<AdminState>;
  openHistory(input: { readonly settingKey: ActiveSettingKey }): Promise<AdminState>;
  loadDashboard(input: { readonly from: string; readonly to: string }): Promise<AdminState>;
  retireStage(input: { readonly stageKey: string }): Promise<AdminState>;
  acknowledgeAlert(input: { readonly alertId: string }): Promise<AdminState>;
  setSendingCap(input: SetSendingCapInput): Promise<AdminState>;
  recordSendingAuthentication(input: RecordSendingAuthenticationInput): Promise<AdminState>;
  recordHolidayCalendar(input: RecordHolidayCalendarInput): Promise<AdminState>;
  addCallingNumber(input: AddCallingNumberInput): Promise<AdminState>;
  retireCallingNumber(input: { readonly identityId: string }): Promise<AdminState>;
  allowStates(input: AllowStatesInput): Promise<AdminState>;
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
  let stages: PipelineStageRowView[] = [];
  let history: AdminState['history'] = null;
  let sendingAdmin: AdminState['sendingAdmin'] = null;
  let sendingReadError: AdminState['sendingReadError'] = null;
  let callingNumbers: AdminState['callingNumbers'] = null;
  let postures: PosturesState | null = null;
  let integrations: AdminState['integrations'] = null;
  let integrationsNotice: string | null = null;
  let paidFinishing: AdminState['paidFinishing'] = null;
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
      integrations = null;
      integrationsNotice = null;
      paidFinishing = null;
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
      integrations,
      integrationsNotice,
      paidFinishing,
    };
  };

  const isAdmin = async (): Promise<boolean> => (await currentRole()).role === 'admin';

  /** Transcription and reply reading from a `/settings/finishing` answer, or null when it did not answer. */
  const paidFinishingOf = (
    finishing: ApiOutcome<FinishingResponse>,
  ): AdminState['paidFinishing'] =>
    finishing.ok
      ? {
          ...(finishing.value.transcription === undefined ? {} : { transcription: finishing.value.transcription }),
          ...(finishing.value.classification === undefined ? {} : { classification: finishing.value.classification }),
        }
      : null;

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
    const status = await deps.api.read('/outbound/status', value => outboundStatusReadSchema.parse(value), {});
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
        const one = await deps.api.read('/outbound/status', value => outboundStatusReadSchema.parse(value), {
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
            },
      ramps: collected,
      finishing: null,
    };
    // Slice P1: "Sending is off. 1 message already submitted is finishing." A failed read is
    // no line, never a notice: the section above already read.
    const finishing = await deps.api.read(FINISHING_READ_PATH, value => finishingResponseSchema.parse(value));
    if (finishing.ok) sendingAdmin = { ...sendingAdmin, finishing: finishing.value.sending };
    // The same answer carries transcription and reply reading (fix round 2), for the
    // Calling & calendar section: no second request.
    paidFinishing = paidFinishingOf(finishing);
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
    callingNumbers = answer.ok ? [...answer.value.identities].map(viewOfNumber) : null;
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
      records: listed.ok ? [...listed.value.postures] : null,
      readError: !reference.ok ? reference.reason : !listed.ok ? listed.reason : null,
    };
  };

  /**
   * The four call-to-booking settings and whether their credentials are in place (slice S1),
   * for an admin: a salesperson cannot change them, so the section is absent for one. A
   * failure is the section's grey line and Retry, never a page notice.
   */
  const loadIntegrations = async (): Promise<void> => {
    if (!(await isAdmin())) {
      integrations = null;
      return;
    }
    const answer = await deps.api.read(INTEGRATIONS_READ_PATH, value => integrationsSettingsResponseSchema.parse(value));
    integrations = answer.ok ? answer.value : null;
  };

  const loadSettings = async (): Promise<void> => {
    const answer = await deps.api.read(SETTINGS_READ_PATH, value => settingsSnapshotSchema.parse(value));
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
    await loadIntegrations();
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
    /**
     * Forget everything this bridge is holding (1.0.13, P0-A).
     *
     * Called on every identity transition, from `registerWindows`. Nothing here is the
     * next person's to read, and a snapshot kept across a sign-out is the last person's
     * work shown to somebody else.
     */
    async forget() {
      screen = 'settings';
      notice = null;
      settings = null;
      dashboard = null;
      diagnostics = null;
      stages = [];
      history = null;
      sendingAdmin = null;
      sendingReadError = null;
      callingNumbers = null;
      postures = null;
      integrations = null;
      integrationsNotice = null;
      roleSeen = null;
      return await snapshot();
    },

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
        { settingKey: input.settingKey, value: input.value, changeNote: changeNoteOf(input.changeNote) },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async saveIntegration(input) {
      const outcome = await deps.api.command(
        '/settings/update',
        { settingKey: input.settingKey, value: input.value, changeNote: DEFAULT_CHANGE_NOTE },
        value => value,
      );
      if (!outcome.ok) {
        // The section's own sentence, not the page banner: the refusal belongs to the row.
        integrationsNotice = outcome.reason.slice(0, 80);
        return await snapshot();
      }
      integrationsNotice = null;
      await loadIntegrations();
      if (PAID_SWITCH_KEYS.has(input.settingKey)) {
        // A paid switch changed (P1 final round, #7): what it still has in flight is read
        // again now, so turning it off shows the finishing line at once.
        paidFinishing = paidFinishingOf(await deps.api.read(FINISHING_READ_PATH, value => finishingResponseSchema.parse(value)));
      }
      return await snapshot();
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
      // One command since wave 2 (S4.3): the register attests the number it adds, so it
      // is verified, enabled and usable for calls at once and there is nothing left for
      // the person to tick. The number goes as typed — normalizing it is the server's,
      // and a client that "fixed" a number would be a second implementation of 9.1's rule.
      const outcome = await deps.api.command(
        CALLING_NUMBER_API_PATHS.register,
        { e164: input.e164, ...(input.label.trim() === '' ? {} : { label: input.label }) },
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

    async allowStates(input) {
      // Invariant 7: the software records the founder's decision and the sources quoted
      // for it; the server copies the statements and the citations from the release,
      // never from this body. One confirmation covers every state named (wave 2, S4.2).
      const outcome = await deps.api.command(
        POSTURE_API_PATHS.allow,
        {
          states: [...input.states],
          confirmed: true,
          ...(input.note.trim() === '' ? {} : { note: input.note.trim() }),
        },
        value => allowCallingStatesResultSchema.parse(value),
      );
      const answered = await afterCommand(outcome, loadPostures);
      if (!outcome.ok) return answered;
      notice = outcome.value.added.length === 0 ? 'posture_already_allowed' : 'posture_recorded';
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
