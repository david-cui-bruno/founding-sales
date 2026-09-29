import { randomUUID } from 'node:crypto';
import type { Queryable, SessionQueryable } from '@fss/domain/db/queryable.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { RepositoryContext, ScopeActor } from '@fss/domain/db/workspaceScope.ts';
import { makeStepExecution } from '@fss/domain/db/testing/stepExecutions.ts';
import { confirmReplyDisposition } from '@fss/domain/classification/confirmations.ts';
import { updateClassifierSettings } from '@fss/domain/classification/settings.ts';
import { recordClassifierCall, recordModelClassification } from '@fss/domain/classification/store.ts';
import { addFirm, commitImportRow, previewCsvImport } from '@fss/domain/crm/import.ts';
import { changeStage, openOpportunity } from '@fss/domain/crm/pipeline.ts';
import { listRoutes, verifyRoute } from '@fss/domain/crm/routes.ts';
import { createCallback, resolveConfirmedInstant } from '@fss/domain/dial/callbacks.ts';
import { logCallOutcome } from '@fss/domain/dial/calls.ts';
import { registerCallingIdentity } from '@fss/domain/dial/identities.ts';
import { authorizeDialCommand } from '@fss/domain/dial/tickets.ts';
import { completeCanaryRun, insertCanaryRun } from '@fss/domain/jobs/canary.ts';
import { incrementDailyCounter } from '@fss/domain/jobs/counters.ts';
import { raiseCriticalAlert } from '@fss/domain/jobs/criticalAlerts.ts';
import { recordHeartbeat } from '@fss/domain/jobs/heartbeats.ts';
import { claimJobs, completeJob, enqueueJob, killJob, writeProgress } from '@fss/domain/jobs/jobStore.ts';
import { applyClassificationEffects, classifyReply, recordDeterministicClassification } from '@fss/domain/mail/effects.ts';
import type { GmailMessageMetadata } from '@fss/domain/mail/gmailClient.ts';
import { localEnvelopeCipher } from '@fss/domain/mail/envelope.ts';
import { insertOrReviveMailbox, setSyncState } from '@fss/domain/mail/mailboxes.ts';
import { storeRefreshToken } from '@fss/domain/mail/tokens.ts';
import { findMatchCandidates, recordMatches } from '@fss/domain/mail/matching.ts';
import { normalizeMetadata, recordMessage, storeMessageBody } from '@fss/domain/mail/messages.ts';
import { recordingReplyPromoter } from '@fss/domain/mail/replyLane.ts';
import { beginReconciling, claimForDispatch, prepareOutboundMessage, recordSent } from '@fss/domain/outbound/fence.ts';
import { RECONCILE_WINDOW_HOURS } from '@fss/domain/outbound/types.ts';
import { setCallingWindow } from '@fss/domain/policy/callingWindows.ts';
import { openPause } from '@fss/domain/policy/pauses.ts';
import { recordStatePosture } from '@fss/domain/policy/postures.ts';
import { recordHolidayCalendar } from '@fss/domain/sequences/calendars.ts';
import { createDraftVersion, createSequence, publishVersion, saveSteps } from '@fss/domain/sequences/definitions.ts';
import { completeEnrollment, enrollContact, stopEnrollments } from '@fss/domain/sequences/enrollments.ts';
import { readStepExecution } from '@fss/domain/sequences/rows.ts';
import { rescheduleExecution } from '@fss/domain/sequences/shifts.ts';
import { consumeTerminalStops } from '@fss/domain/sequences/terminalStops.ts';
import { updateSetting } from '@fss/domain/settings/store.ts';
import { POSTURE_STATEMENT_KEYS } from '@fss/domain/src/rules/statePosture.ts';
import { SENDING_STOP_LINE } from '@fss/domain/src/rules/templates.ts';
import { canonicalizeHandle } from '@fss/domain/src/rules/suppressionCanonicalization.ts';
import { recordSuppression } from '@fss/domain/suppression/events.ts';
import { claimFinalization } from '@fss/domain/suppression/finalize.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { createTemplateVersion, readTemplateVersion } from '@fss/domain/templates/templates.ts';
import { seedCrm } from '@fss/domain/test/db/support/crmFixtures.ts';
import { seedTwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { seedMail } from '@fss/domain/test/db/support/mailFixtures.ts';
import { seedOutbound } from '@fss/domain/test/db/support/outboundFixtures.ts';
import { seedPolicy } from '@fss/domain/test/db/support/policyFixtures.ts';
import { seedRetention } from '@fss/domain/test/db/support/retentionFixtures.ts';
import { storeFixtureCiGateRecord } from '@fss/domain/test/release/support/releaseRecords.ts';
import { FIXTURE_SIGN_OFF, fixtureBody, seedSequences } from '@fss/domain/test/sequences/support/sequenceFixtures.ts';
import { buildTodaySnapshot, defaultTodaySources } from '@fss/domain/today/build.ts';
import { businessDateOf, listTodayItems } from '@fss/domain/today/snapshots.ts';
import type { TodayItemRow } from '@fss/domain/today/types.ts';
import { snoozeTodayItem } from '@fss/domain/today/snooze.ts';
// Relative, not `@fss/worker/...`: the loader runs inside the base checkout, whose
// `apps/worker/package.json` exports only `"."` and cannot resolve a subpath. The
// `@fss/domain/*` specifiers are safe — that package has always exported `"./*"`.
import { bootstrapWorkspace } from '../../apps/worker/src/tools/fss/bootstrapWorkspace.ts';
import { tableNames } from './snapshot.ts';

/**
 * The representative fixture the upgrade test upgrades (step 3).
 *
 * ## What it is for
 *
 * A migration that is additive on an empty database is additive on nothing. The
 * upgrade test applies 1..N, loads this, applies N+1..M and compares — so the value
 * of the test is exactly the coverage of this file: a table with no row cannot prove
 * that a migration left its rows alone, and a row written by an `INSERT` this file
 * composed cannot prove that the *command* still writes it. Hence the two rules
 * below, which are the whole design.
 *
 * **Through the ordinary commands.** Every business row that has a domain command is
 * written by that command, as the real caller writes it — the same refusals, the same
 * triggers, the same audit rows. Where a piece has no command (a second member, the
 * device row) the shape is copied from `packages/domain/test/db/support/fixtures.ts`,
 * and it is said here that it is.
 *
 * **As `app_runtime`.** The session handed in is the runtime login user's own
 * connection, never the migrator's, so every statement here is subject to the runtime
 * grants. A fixture loaded as the owner would silently pass on a schema whose grants
 * the migration broke, which is one of the two things the upgrade test exists to
 * catch.
 *
 * ## Two readings this file takes, and why
 *
 * **There is no `paused` enrollment state.** The brief asks for "active,
 * paused/manual, completed". Migration 0021 narrows `sequence_enrollments_state_known`
 * to `('active','completed','stopped')`; `review_required` went with it and `paused`
 * never existed. The reachable form of "paused" is `stopped` — `stopEnrollments`
 * writes it with an `EnrollmentEndReason` — so the fixture produces `active`,
 * `stopped` and `completed`, and the manual half of "paused/manual" is a separate
 * fact: the opportunity's control mode, which `confirmReplyDisposition` sets.
 *
 * **"Ordinary commands" and "reuse the existing helpers" are both obeyed.** The
 * `packages/domain/test/db/support/*Fixtures.ts` helpers are raw SQL against their own
 * alpha and beta workspaces. They are reused as the brief says — they are the cheapest
 * honest way to reach the tables no command in this tree writes — but they are run on
 * the **app_runtime session**, so the runtime grants still decide, and no piece the
 * brief names explicitly is left to them: the bootstrapped workspace gets the real
 * command for each of those.
 *
 * ## The loader runs in the base checkout
 *
 * A command is written against one schema. `createFirm` at HEAD records a
 * `firm.created` funnel fact, and `funnel_facts` arrives with migration 0022 — so
 * HEAD's `createFirm` simply cannot run against schema 21, and neither can any part
 * that needs a firm. The coordinator's answer is that this file is executed inside a
 * checkout of the commit whose `REQUIRED_SCHEMA` is N, against *that* checkout's
 * domain code, so every command matches the schema it is writing to.
 *
 * Two things in this file exist because of that, and must stay:
 *
 *   * the worker import is **relative**. The base checkout's
 *     `apps/worker/package.json` exports only `"."`, so `@fss/worker/src/...` does
 *     not resolve there. `@fss/domain/*` is fine: that package has always exported
 *     `"./*": "./*"`.
 *   * a command module that arrived *with* the table it writes is imported
 *     **dynamically, inside the part, after the table probe**. `funnel/facts.ts` did
 *     not exist at the schema-21 commit, and a static import of it would fail the
 *     whole module load rather than skip one part. Every other module this file uses
 *     exists at that commit, and is imported statically.
 *
 * ## Skipping rather than failing
 *
 * `schemaVersion` is N. A part whose tables do not all exist at N is reported
 * `skipped` with the missing table named, and the parts that depend on it skip in
 * turn. Nothing here throws for a schema that is simply older than a feature; a
 * refusal from a command, on the other hand, throws, because a command that refuses a
 * fixture it used to accept is the news the test is looking for. The single exception
 * is the dial ticket, which the brief allows to record its refusal code as a skip.
 */

/** A part of the fixture, and the tables it needs in order to exist. */
export interface FixturePartReport {
  readonly name: string;
  /** 'loaded' | 'skipped' — skipped when a table it needs does not exist at N. */
  readonly outcome: 'loaded' | 'skipped';
  /** Why it was skipped, or '' when it loaded. */
  readonly reason: string;
  /** The tables (or `table.column`) that were absent at N and caused the skip. Empty when loaded. */
  readonly missing: readonly string[];
  readonly ms: number;
}

/** The handles the workflow step (step 10) needs to call into the domain. */
export interface FixtureHandles {
  readonly workspaceId: string;
  readonly adminUserId: string;
  readonly salespersonUserId: string;
  readonly deviceId: string;
  /** Every firm created in the bootstrapped workspace, in creation order. */
  readonly firmIds: readonly string[];
  readonly primaryFirmId: string;
  readonly primaryContactId: string;
  /** A contact that exists only to be deleted by the retention workflow. */
  readonly deletableContactId: string;
  readonly deletableFirmId: string;
  readonly openOpportunityIds: readonly string[];
  readonly closedOpportunityId: string | null;
  readonly templateVersionId: string | null;
  readonly sequenceVersionId: string | null;
  readonly activeEnrollmentId: string | null;
  readonly mailboxId: string | null;
  readonly classifiedMessageId: string | null;
  readonly callingIdentityId: string | null;
  /**
   * A firm the fixture deliberately leaves with no opportunity, no callback and no
   * call log, so the only Today source that can speak for it is the new-firm one.
   * The workflow step pins its card's lane on that.
   */
  readonly newFirmLaneFirmId: string | null;
  /** The fence left in `reconciling`, which the reconciliation enumeration must return. */
  readonly reconcilingFenceId: string | null;
  /** The canonical key of the handle the fixture opted out, as `effective_suppressions` holds it. */
  readonly suppressedHandleKey: string | null;
  /** A canonical handle the fixture never suppressed, for the negative half of that read. */
  readonly unsuppressedHandleKey: string | null;
  /** The business date the Today snapshot was built for, and the instant used. */
  readonly businessDate: string;
  readonly now: string;
}

export interface LoadedFixture {
  readonly handles: FixtureHandles;
  readonly parts: readonly FixturePartReport[];
  /** Tables that exist at N and have no row, with the written reason each is empty. */
  readonly emptyTables: ReadonlyMap<string, string>;
}

/**
 * The instant the whole fixture is written at: Wednesday 16 September 2026, 14:00 UTC,
 * which is 10:00 in `America/New_York`.
 *
 * A fixed instant rather than `now()`, for the reason the retention fixtures give: a
 * fixture that is relative to the clock behaves differently at 23:59. This one is
 * chosen to be inside the weekday calling window, because the dial ticket is
 * authorized at it and a ticket refused `outside_calling_window` would be a fixture
 * whose coverage depended on the hour the test ran.
 */
const NOW = '2026-09-16T14:00:00.000Z';

/** The workspace's business zone, and every firm's, so no zone is ever unresolved. */
const ZONE = 'America/New_York';

/** Rhode Island: `STATE_POSTURE_RULES` carries real citations for it, so a posture is recordable. */
const REGION = 'RI';

/** How many firms the file imports. The brief asks for at least twenty. */
const IMPORTED_FIRMS = 22;

/**
 * The business date the legacy Today card is written for: the business day before the
 * fixture's own instant, so that nothing built for `businessDate` can rewrite it.
 *
 * A card the current build would rebuild is not a legacy row — it is this morning's row.
 * Yesterday's card is never rebuilt by anything, which is exactly why production still
 * holds cards at the algorithm version that was current when they were written.
 */
const LEGACY_BUSINESS_DATE = '2026-09-15';

/**
 * The algorithm version every Today card in this tree carries, and the one the subject
 * branch's 0023 stops producing when it replaces `today_algorithm_version()` with
 * `today.2`. Written literally rather than read from `TODAY_ALGORITHM_VERSION`, because
 * the point of the row is to be pinned at the old value whatever the tree says.
 */
const LEGACY_TODAY_ALGORITHM_VERSION = 'today.1';

/**
 * The postal address the pre-0020 footer block carried.
 *
 * A fictional address: `example.test` is reserved by RFC 6761 and no such street exists
 * in the 02903 ZIP. It is a literal here rather than the `postal_address` setting,
 * because the row it composes is a row written before that setting existed.
 */
const LEGACY_POSTAL_ADDRESS = '1 Example Plaza, Suite 200, Providence, RI 02903';

/**
 * The handle the fixture opts out, and the firm whose contact it belongs to.
 *
 * Firm 21's contact, chosen because nothing else in the fixture writes to, dials or
 * enrols that contact: a suppression on a handle the eligibility gate or the deletion
 * workflow also reasons about would make those steps assert something else by accident.
 * The scope is `handle` rather than `firm` deliberately — a firm-wide do-not-contact
 * takes the firm off the Today list (`newFirmSource`), and the Today assertions are
 * pinned to exact lanes.
 */
const SUPPRESSED_HANDLE = 'dana.21@firm21.example.test';

/**
 * The firm index whose card must come out in the `new_firm` lane.
 *
 * The last imported firm. `opportunitiesPart` opens opportunities for the first six
 * firms and the deletable one only, so this firm has never had an opportunity of any
 * kind, no callback and no call log — which leaves `newFirmSource` as the only source
 * in the build that can produce a task for it.
 */
const NEW_FIRM_LANE_INDEX = IMPORTED_FIRMS - 1;

/**
 * The firm index the reconciling fence is prepared against.
 *
 * Firms 1, 2 and 3 already carry a fence each (the two legacy footers and the prepared
 * one) and `outbound_messages_one_per_step_execution` plus
 * `opportunities_one_open_per_firm` mean a fence needs a firm with an open opportunity
 * of its own that no other fence has used. Index 4 is the last such firm:
 * `openOpportunityIds` holds six entries and index 5 is the deletable firm's.
 */
const RECONCILING_FENCE_FIRM_INDEX = 4;

/**
 * Every part this fixture must contain. Asserted by the caller so that an older or
 * shorter loader in a base checkout cannot quietly reduce what the upgrade test covers
 * (GPT-6 review, P1-6).
 *
 * The order is the order `loadFixture` runs them in, and the names are the names it
 * reports. Both are part of the contract: the caller compares the list it holds against
 * the names the child process reported, and `loadFixture` itself checks that it produced
 * every one of them before it returns.
 */
export { REQUIRED_FIXTURE_PARTS } from './fixtureManifest.ts';
import { REQUIRED_FIXTURE_PARTS } from './fixtureManifest.ts';

/**
 * Why a table that exists at N is legitimately empty. Used to fill `emptyTables`.
 *
 * A reason is a claim that the row could not be written here *and why*, not an excuse:
 * every entry names either the writer that lives outside this tree, or the workflow
 * step that is supposed to write it after the upgrade.
 */
export const EMPTY_TABLE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  // Written by the API process, which this tool does not run.
  sessions: 'apps/api/src/auth/sessions.ts writes it at sign-in; the fixture runs no API.',
  oidc_authorization_requests:
    'apps/api/src/auth/signIn.ts writes a single-use digest per in-flight sign-in; the fixture runs no API.',
  command_receipts:
    'apps/api/src/auth/commands.ts writes one per mutating request; the fixture calls the domain directly, with no request to receipt.',
  // Written by the workflow step that runs after the upgrade, on purpose.
  deletion_requests:
    'The retention workflow (step 10) previews and commits the deletion of deletableFirmId; a row written here would be the thing under test.',
  departures: 'The departure command is part of the workflow step, not of the fixture it runs against.',
  retention_runs: 'The retention sweep is run by the workflow step against the rows this fixture leaves.',
  // A pre-0021 table, present only when N is below 21.
  device_refresh_credentials: 'Dropped by migration 0021; present only at N < 21, and nothing in this tree writes it any more.',
});

/** Everything the parts build up, before it is frozen into `FixtureHandles`. */
interface State {
  workspaceId: string;
  adminUserId: string;
  salespersonUserId: string;
  deviceId: string;
  firmIds: string[];
  contactIds: string[];
  primaryFirmId: string;
  primaryContactId: string;
  primaryEmail: string;
  primaryPhoneRouteId: string;
  primaryPhoneRouteVersion: number;
  primaryEmailRouteId: string;
  deletableFirmId: string;
  deletableContactId: string;
  openOpportunityIds: string[];
  closedOpportunityId: string | null;
  templateVersionId: string | null;
  templateContentHash: string | null;
  sequenceVersionId: string | null;
  activeEnrollmentId: string | null;
  mailboxId: string | null;
  mailboxAddress: string;
  classifiedMessageId: string | null;
  callingIdentityId: string | null;
  callLogId: string | null;
  stepExecutionId: string | null;
  newFirmLaneFirmId: string | null;
  reconcilingFenceId: string | null;
  suppressedHandleKey: string | null;
  unsuppressedHandleKey: string | null;
  businessDate: string;
}

/** A part: what it is called, the objects it cannot exist without, and the work. */
interface Part {
  readonly name: string;
  /**
   * Skipped when any of these is absent at N. A `table` or a `table.column`: the
   * second form is for a part that needs a column a later migration added to a table
   * that was already there.
   */
  readonly tables: readonly string[];
  /** Tables the part writes that it does not itself require. Used to explain an empty one. */
  readonly fills?: readonly string[];
  /**
   * Returns a reason to record the part as skipped, or nothing when it loaded. A skip
   * decided here is *not* a missing object — the caller fails the run on it — so the
   * reason names the command's refusal or the earlier part that did not run.
   */
  run: () => Promise<string | undefined>;
}

const userActor = (userId: string, role: 'admin' | 'salesperson'): ScopeActor => ({ kind: 'user', userId, role });

/** A fictional NANP number in the 555-01XX block, which reaches nobody. */
const fictionalNumber = (index: number): string => `+1401555${String(100 + index).padStart(4, '0')}`;

/**
 * Unwrap a command result, or fail the load.
 *
 * A refusal here is not a schema difference and must not be swallowed: the fixture
 * asked for something the domain used to permit, and the upgrade test wants to say so
 * with the refusal in the message rather than to quietly load less.
 */
function value<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }, what: string): T {
  if (!result.ok) throw new Error(`the fixture's ${what} was refused: ${result.reason}`);
  return result.value;
}

/** The single row an insert was supposed to return. */
function row<T>(rows: readonly T[], what: string): T {
  const first = rows[0];
  if (first === undefined) throw new Error(`the fixture's ${what} returned no row`);
  return first;
}

/**
 * Load the representative fixture as `app_runtime`.
 * `session` is a single connection already `SET ROLE`-free — it IS the app_runtime
 * login user's own connection, so every statement is subject to the runtime grants.
 * `schemaVersion` is N: parts whose tables do not exist at N are skipped, not failed.
 */
export async function loadFixture(
  session: SessionQueryable,
  options: { readonly schemaVersion: number },
): Promise<LoadedFixture> {
  const present = new Set(await tableNames(session));
  /** Whether one `table` or `table.column` the parts name is there at N. */
  const absent = async (object: string): Promise<boolean> => {
    const [table, column] = object.split('.');
    if (table === undefined || !present.has(table)) return true;
    if (column === undefined) return false;
    const { rows } = await session.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS present`,
      [table, column],
    );
    return rows[0]?.present !== true;
  };
  const state: State = {
    workspaceId: '',
    adminUserId: '',
    salespersonUserId: '',
    deviceId: '',
    firmIds: [],
    contactIds: [],
    primaryFirmId: '',
    primaryContactId: '',
    primaryEmail: '',
    primaryPhoneRouteId: '',
    primaryPhoneRouteVersion: 1,
    primaryEmailRouteId: '',
    deletableFirmId: '',
    deletableContactId: '',
    openOpportunityIds: [],
    closedOpportunityId: null,
    templateVersionId: null,
    templateContentHash: null,
    sequenceVersionId: null,
    activeEnrollmentId: null,
    mailboxId: null,
    mailboxAddress: 'sales.fixture@example.test',
    classifiedMessageId: null,
    callingIdentityId: null,
    callLogId: null,
    stepExecutionId: null,
    newFirmLaneFirmId: null,
    reconcilingFenceId: null,
    suppressedHandleKey: null,
    unsuppressedHandleKey: null,
    businessDate: '',
  };

  const asAdmin = (): RepositoryContext =>
    repositoryContext(workspaceScope(state.workspaceId, userActor(state.adminUserId, 'admin')), session);
  const asSalesperson = (): RepositoryContext =>
    repositoryContext(workspaceScope(state.workspaceId, userActor(state.salespersonUserId, 'salesperson')), session);
  const asWorker = (): RepositoryContext =>
    repositoryContext(workspaceScope(state.workspaceId, { kind: 'system', component: 'worker' }), session);

  const parts: Part[] = [
    bootstrapPart(session, state),
    salespersonPart(session, state),
    configurationPart(asAdmin),
    firmsPart(session, asAdmin, asSalesperson, state),
    routesPart(asSalesperson, state),
    opportunitiesPart(asSalesperson, state),
    templatePart(asAdmin, state),
    sequencePart(asAdmin, state),
    enrollmentPart(asSalesperson, state),
    mailboxPart(asSalesperson, state),
    outboundPart(session, asSalesperson, state),
    legacyFooterWithoutAddressPart(session, asSalesperson, state),
    legacyFooterWithAddressPart(session, asSalesperson, state),
    preparedFencePart(session, asSalesperson, state),
    reconcilingFencePart(session, asSalesperson, state),
    dialPart(asSalesperson, state),
    inboundMailPart(asSalesperson, state),
    classificationPart(asSalesperson, state),
    legacyTodayCardPart(session, asSalesperson, state),
    todayPart(asSalesperson, state),
    jobsPart(session, state),
    funnelPart(asSalesperson, state),
    releasePart(session),
    operationsPart(session, asAdmin, asWorker, state),
    shiftPart(asWorker, state),
    pausePart(asAdmin),
    handleSuppressionPart(session, asSalesperson, state),
    sharedWorkspacesPart(session),
  ];

  const reports: FixturePartReport[] = [];
  /** Table to the skipped part that would have written it. Explains an empty table below. */
  const unwritten = new Map<string, string>();
  const note = (part: Part, reason: string): void => {
    for (const object of [...part.tables, ...(part.fills ?? [])]) {
      // A `table.column` entry explains the table it belongs to, not a key of its own.
      const table = object.split('.')[0] ?? object;
      if (!unwritten.has(table)) unwritten.set(table, `the '${part.name}' part was skipped: ${reason}`);
    }
  };

  for (const part of parts) {
    const started = Date.now();
    const missing: string[] = [];
    for (const object of part.tables) if (await absent(object)) missing.push(object);
    if (missing.length > 0) {
      const reason = `schema ${String(options.schemaVersion)} has no ${missing.join(', ')}`;
      note(part, reason);
      reports.push({ name: part.name, outcome: 'skipped', reason, missing, ms: Date.now() - started });
      continue;
    }
    const skipped = await part.run();
    if (skipped !== undefined) note(part, skipped);
    reports.push({
      name: part.name,
      outcome: skipped === undefined ? 'loaded' : 'skipped',
      reason: skipped ?? '',
      // Empty on purpose when a part skipped for anything other than a missing object:
      // the caller fails the run on such a skip, which is what it is for.
      missing: [],
      ms: Date.now() - started,
    });
  }

  // The loader's own half of the manifest check (GPT-6 review, P1-6). The caller compares
  // the names it was sent against `REQUIRED_FIXTURE_PARTS`; this compares the names this
  // run actually produced, so a part deleted from the list above fails here rather than
  // thinning the upgrade test's coverage in silence. A *skipped* part still counts: a skip
  // is reported, reasoned about and, for anything but a missing object, failed by the
  // caller — it is a missing name that nobody would notice.
  const produced = new Set(reports.map(report => report.name));
  const absentParts = REQUIRED_FIXTURE_PARTS.filter(name => !produced.has(name));
  if (absentParts.length > 0) {
    throw new Error(`the fixture did not produce its required parts: ${absentParts.join(', ')}`);
  }

  return {
    handles: {
      workspaceId: state.workspaceId,
      adminUserId: state.adminUserId,
      salespersonUserId: state.salespersonUserId,
      deviceId: state.deviceId,
      firmIds: [...state.firmIds],
      primaryFirmId: state.primaryFirmId,
      primaryContactId: state.primaryContactId,
      deletableContactId: state.deletableContactId,
      deletableFirmId: state.deletableFirmId,
      openOpportunityIds: [...state.openOpportunityIds],
      closedOpportunityId: state.closedOpportunityId,
      templateVersionId: state.templateVersionId,
      sequenceVersionId: state.sequenceVersionId,
      activeEnrollmentId: state.activeEnrollmentId,
      mailboxId: state.mailboxId,
      classifiedMessageId: state.classifiedMessageId,
      callingIdentityId: state.callingIdentityId,
      newFirmLaneFirmId: state.newFirmLaneFirmId,
      reconcilingFenceId: state.reconcilingFenceId,
      suppressedHandleKey: state.suppressedHandleKey,
      unsuppressedHandleKey: state.unsuppressedHandleKey,
      businessDate: state.businessDate,
      now: NOW,
    },
    parts: reports,
    emptyTables: await emptyTablesOf(session, unwritten),
  };
}

/**
 * Every table that exists and holds no row, with the reason it is empty.
 *
 * Three sources, in this order: the written catalogue below, which holds the permanent
 * facts; the part that would have written the table and was skipped at this N, which
 * is a reason only this run knows; and `NO REASON GIVEN`, which is the caller's cue
 * that a table nobody has accounted for is empty.
 */
async function emptyTablesOf(
  session: SessionQueryable,
  unwritten: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, string>> {
  const empty = new Map<string, string>();
  for (const table of await tableNames(session)) {
    const { rows } = await session.query<{ present: boolean }>(`SELECT EXISTS (SELECT 1 FROM "${table}") AS present`);
    if (rows[0]?.present === true) continue;
    empty.set(table, EMPTY_TABLE_REASONS[table] ?? unwritten.get(table) ?? 'NO REASON GIVEN');
  }
  return empty;
}

// ---------------------------------------------------------------- the parts

/** The workspace, its first admin, its membership, its audit row and its sending domain. */
function bootstrapPart(session: SessionQueryable, state: State): Part {
  return {
    name: 'workspace',
    tables: ['workspaces', 'users', 'workspace_memberships', 'audit_events', 'pipeline_stages'],
    run: async () => {
      const report = await bootstrapWorkspace(session, {
        slug: 'fixture-workspace',
        displayName: 'Fixture Workspace',
        adminEmail: 'admin@fixture.example.test',
        timeZone: ZONE,
        sendingDomain: 'fixture.example.test',
      });
      if (!report.ok) throw new Error(`the workspace bootstrap was refused: ${report.reason}: ${report.detail}`);
      state.workspaceId = report.value.workspace.id;
      state.adminUserId = report.value.admin.userId;
      return undefined;
    },
  };
}

/**
 * The second member and their Mac.
 *
 * There is no domain command for either: `bootstrapWorkspace` writes the *first*
 * admin, a second member arrives through a sign-in the API serves, and a device is
 * paired by the desktop. The shapes are copied from
 * `packages/domain/test/db/support/fixtures.ts`, which is the one place in this tree
 * that knows them.
 */
function salespersonPart(session: SessionQueryable, state: State): Part {
  return {
    name: 'salesperson',
    tables: ['users', 'workspace_memberships', 'devices'],
    run: async () => {
      const user = await session.query<{ id: string }>(
        'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
        [`sub-${randomUUID()}`, 'sales@fixture.example.test', 'Sam Example'],
      );
      state.salespersonUserId = row(user.rows, 'salesperson user').id;
      await session.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')`,
        [state.workspaceId, state.salespersonUserId],
      );
      const device = await session.query<{ id: string }>(
        `INSERT INTO devices (workspace_id, user_id, device_label, secret_hash)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [state.workspaceId, state.salespersonUserId, "Sam's MacBook", 'd'.repeat(64)],
      );
      state.deviceId = row(device.rows, 'salesperson device').id;
      return undefined;
    },
  };
}

/** The configuration an admin maintains: posture, window, holidays, classifier, settings. */
function configurationPart(asAdmin: () => RepositoryContext): Part {
  return {
    name: 'configuration',
    tables: ['state_postures', 'calling_windows', 'workspace_holiday_calendars', 'classifier_settings', 'workspace_settings'],
    run: async () => {

      value(
        await recordStatePosture(asAdmin(), {
          state: REGION,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          confirmedStatements: [...POSTURE_STATEMENT_KEYS],
          note: 'The fixture posture: every statement confirmed, so a dial can be authorized.',
        }),
        'state posture',
      );
      value(
        await setCallingWindow(asAdmin(), { startMinute: 9 * 60, endMinute: 17 * 60, weekdays: [1, 2, 3, 4, 5] }),
        'calling window',
      );
      value(
        await recordHolidayCalendar(asAdmin(), { version: 'holidays.fixture.1', dates: ['2026-12-25', '2027-01-01'] }),
        'holiday calendar',
      );
      value(await updateClassifierSettings(asAdmin(), { enabled: true, dailyCallCap: 100 }), 'classifier settings');
      value(
        await updateSetting(asAdmin(), { settingKey: 'business_time_zone', value: { timeZone: ZONE } }),
        'business time zone setting',
      );
      return undefined;
    },
  };
}

/**
 * Twenty-two firms with an address, a website and a contact, plus the firm that
 * exists to be deleted.
 *
 * The CSV import is the path that writes all four things in one go — firm, postal
 * columns, contact, and both routes — and it is a real command with a real preview, so
 * the fixture's firms are firms an admin could have imported. `owner_user_id` names the
 * salesperson on every row, because the rest of the fixture (enrollment, dial, Today)
 * acts as that person and the CRM refuses a colleague's firm.
 *
 * Each row is committed in its own transaction, which is what `commitImportRow`'s
 * savepoint expects: in the API `runCommand` supplies it.
 */
function firmsPart(
  session: SessionQueryable,
  asAdmin: () => RepositoryContext,
  asSalesperson: () => RepositoryContext,
  state: State,
): Part {
  return {
    name: 'firms',
    // The two columns are named because the import writes them and a postal address is
    // half the point of this part: a schema without them would take the rows and lose
    // the address silently, which is worse than a skip that says so.
    tables: ['firms', 'firms.address_line', 'firms.website', 'contacts', 'email_addresses', 'phone_routes'],
    fills: ['record_aliases'],
    run: async () => {

      const header =
        'firm_name,website,address_line,locality,region_code,postal_code,time_zone,external_id,owner_user_id,contact_name,contact_title,contact_email,contact_phone';
      const lines = [header];
      for (let index = 0; index < IMPORTED_FIRMS; index += 1) {
        const suffix = String(index + 1).padStart(2, '0');
        lines.push(
          [
            `Fixture Holdings ${suffix}`,
            `https://firm${suffix}.example.test`,
            `${String(100 + index)} Example Street`,
            'Providence',
            REGION,
            '02903',
            ZONE,
            `fixture-external-${suffix}`,
            state.salespersonUserId,
            `Dana Example ${suffix}`,
            'Operations Lead',
            `dana.${suffix}@firm${suffix}.example.test`,
            fictionalNumber(index),
          ].join(','),
        );
      }

      const preview = value(await previewCsvImport(asAdmin(), { csv: lines.join('\n') }), 'CSV import preview');
      for (const previewed of preview.rows) {
        const committed = await withTransaction(session, async () => await commitImportRow(asAdmin(), previewed));
        const capture = value(committed, `import of row ${String(previewed.rowNumber)}`);
        state.firmIds.push(capture.firmId);
        if (capture.contactId !== null) state.contactIds.push(capture.contactId);
      }

      // The firm the deletion workflow removes. Added through the Add firm form's own
      // command rather than the import, so both capture paths are exercised, and as the
      // salesperson, because that is who Add firm belongs to.
      const deletable = value(
        await addFirm(asSalesperson(), {
          firm: { name: 'Fixture Deletable Holdings', website: 'https://deletable.example.test', timeZone: ZONE },
          contact: {
            fullName: 'Robin Example',
            title: 'Owner',
            email: 'robin@deletable.example.test',
            phone: fictionalNumber(IMPORTED_FIRMS),
          },
        }),
        'Add firm',
      );
      state.deletableFirmId = deletable.firmId;
      state.deletableContactId = deletable.contactId ?? '';
      state.firmIds.push(deletable.firmId);

      state.primaryFirmId = state.firmIds[0] ?? '';
      state.primaryContactId = state.contactIds[0] ?? '';
      state.primaryEmail = 'dana.01@firm01.example.test';
      // The firm whose Today lane the workflow step pins. Recorded here rather than
      // guessed there: which firms stay opportunity-free is a fact about this loader,
      // and a workflow that worked it out for itself would re-derive the lane rule it
      // is supposed to be checking.
      state.newFirmLaneFirmId = state.firmIds[NEW_FIRM_LANE_INDEX] ?? null;
      // The handle the suppression workflow must *not* find. The primary contact's
      // address, canonicalised the way the suppression set spells it, so the negative
      // half of that read compares like with like.
      const unsuppressed = canonicalizeHandle(state.primaryEmail);
      state.unsuppressedHandleKey = unsuppressed.ok ? unsuppressed.handle.value : null;
      return undefined;
    },
  };
}

/**
 * The primary firm's two routes, verified.
 *
 * An imported route is a `candidate` — a spreadsheet has passed no validation — and a
 * candidate cannot be dialed. `verifyRoute` with a passed technical validation is what
 * makes the number usable, and it bumps the version, which is the version the dial
 * ticket then has to name. (`confirmPhoneRoute`, the operator's one-click form of the
 * same write, was deleted as a dead export on 29 Sep 2026 — PR 312 — after this
 * fixture was written against it; hotfix of main 5ac10740.)
 */
function routesPart(asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'routes',
    tables: ['phone_routes', 'email_addresses'],
    run: async () => {
      if (state.primaryFirmId === '') return 'the firms part did not run';
      const phone = (await listRoutes(asSalesperson(), 'phone', state.primaryFirmId))[0];
      const email = (await listRoutes(asSalesperson(), 'email', state.primaryFirmId))[0];
      if (phone === undefined || email === undefined) throw new Error('the primary firm has no imported routes');

      const confirmed = value(
        await verifyRoute(asSalesperson(), {
          routeKind: 'phone',
          routeId: phone.id,
          technicalValidation: 'passed',
          associationConfidence: 1,
        }),
        'phone route verification',
      );
      state.primaryPhoneRouteId = confirmed.id;
      state.primaryPhoneRouteVersion = Number(confirmed.version);

      const verified = value(
        await verifyRoute(asSalesperson(), {
          routeKind: 'email',
          routeId: email.id,
          technicalValidation: 'passed',
          associationConfidence: 0.95,
        }),
        'email route verification',
      );
      state.primaryEmailRouteId = verified.id;
      return undefined;
    },
  };
}

/** Open opportunities across the stages, and one closed Lost with its reason. */
function opportunitiesPart(asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'opportunities',
    tables: ['opportunities', 'opportunity_stage_events', 'crm_domain_events'],
    fills: ['sequence_event_cursors'],
    run: async () => {
      if (state.primaryFirmId === '') return 'the firms part did not run';
      // Seven firms get an opportunity: five stay open on five different stages, one is
      // closed Lost with a reason, and the deletable firm keeps one so the deletion
      // workflow has business history to stop.
      const stages = ['contacting', 'engaged', 'qualified', 'proposal'];
      const firms = [...state.firmIds.slice(0, 6), state.deletableFirmId];
      const opened: string[] = [];
      for (const firmId of firms) {
        const opportunity = value(await openOpportunity(asSalesperson(), { firmId }), 'opening an opportunity');
        opened.push(opportunity.id);
      }
      for (const [index, stageKey] of stages.entries()) {
        const opportunityId = opened[index + 1];
        if (opportunityId === undefined) continue;
        value(await changeStage(asSalesperson(), { opportunityId, toStageKey: stageKey }), `a move to ${stageKey}`);
      }
      const closing = opened[5];
      if (closing !== undefined) {
        value(
          await changeStage(asSalesperson(), {
            opportunityId: closing,
            toStageKey: 'lost',
            reason: 'The firm has an incumbent provider under contract until next year.',
          }),
          'the Lost close',
        );
        state.closedOpportunityId = closing;
      }
      state.openOpportunityIds = opened.filter(id => id !== closing);
      return undefined;
    },
  };
}

/** One approved template version, written and approved by the admin in one command. */
function templatePart(asAdmin: () => RepositoryContext, state: State): Part {
  return {
    name: 'template',
    tables: ['template_versions'],
    run: async () => {
      const created = value(
        await createTemplateVersion(asAdmin(), {
          name: 'Fixture first touch',
          subject: 'A short note about your properties',
          // The known-good body: it ends with exactly one stop line, which is what the
          // fence's `footer_not_composed` guard checks, and names no web link.
          body: fixtureBody('Hello.\n\nI work with firms like yours and had one question.'),
          footer: { signOff: FIXTURE_SIGN_OFF },
          requiredVariables: [],
          approve: true,
        }),
        'template version',
      );
      state.templateVersionId = created.id;
      state.templateContentHash = created.contentHash;
      return undefined;
    },
  };
}

/** A sequence, its draft, its steps and its publication — each through its own command. */
function sequencePart(asAdmin: () => RepositoryContext, state: State): Part {
  return {
    name: 'sequence',
    tables: ['sequences', 'sequence_versions', 'sequence_steps'],
    run: async () => {
      if (state.templateVersionId === null) return 'the template part did not run';
      const sequence = value(
        await createSequence(asAdmin(), { name: 'Fixture founding outreach', description: 'The fixture cadence.' }),
        'sequence',
      );
      const draft = value(
        await createDraftVersion(asAdmin(), {
          sequenceId: sequence.id,
          steps: [
            {
              ordinal: 1,
              channel: 'email',
              delay: { unit: 'elapsed', hours: 0 },
              templateVersionId: state.templateVersionId,
            },
            { ordinal: 2, channel: 'call_task', delay: { unit: 'business_days', days: 2 }, onNoAnswer: 'retry_call' },
          ],
        }),
        'sequence draft',
      );
      // Saved again before publication, so the edit path writes as well as the create
      // path: `saveSteps` is what the editor calls on every keystroke-ending save.
      value(
        await saveSteps(asAdmin(), {
          sequenceVersionId: draft.sequenceVersionId,
          steps: [
            {
              ordinal: 1,
              channel: 'email',
              delay: { unit: 'elapsed', hours: 0 },
              templateVersionId: state.templateVersionId,
            },
            { ordinal: 2, channel: 'call_task', delay: { unit: 'business_days', days: 3 }, onNoAnswer: 'retry_call' },
          ],
        }),
        'the saved steps',
      );
      const published = value(
        await publishVersion(asAdmin(), { sequenceVersionId: draft.sequenceVersionId }),
        'sequence publication',
      );
      state.sequenceVersionId = published.id;
      return undefined;
    },
  };
}

/**
 * Three enrollments, one in each state the schema has.
 *
 * `stopped` is the reachable form of the brief's "paused": migration 0021 narrows
 * `sequence_enrollments_state_known` to `('active','completed','stopped')` and there
 * is no state in between. One live enrollment per contact, so each is a different
 * firm's contact.
 */
function enrollmentPart(asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'enrollments',
    tables: ['sequence_enrollments', 'step_executions'],
    run: async () => {
      if (state.primaryFirmId === '') return 'the firms part did not run';
      if (state.sequenceVersionId === null) return 'the sequence part did not run';
      const versionId = state.sequenceVersionId;
      const enrolled: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const firmId = state.firmIds[index];
        const contactId = state.contactIds[index];
        const opportunityId = state.openOpportunityIds[index];
        if (firmId === undefined || contactId === undefined || opportunityId === undefined) continue;
        const outcome = value(
          await enrollContact(asSalesperson(), {
            sequenceVersionId: versionId,
            opportunityId,
            firmId,
            contactId,
          }),
          'an enrollment',
        );
        enrolled.push(outcome.enrollmentId);
      }
      state.activeEnrollmentId = enrolled[0] ?? null;
      const stopping = enrolled[1];
      if (stopping !== undefined) {
        await stopEnrollments(asSalesperson(), { enrollmentId: stopping, reason: 'admin_stop' });
      }
      const completing = enrolled[2];
      if (completing !== undefined) await completeEnrollment(asSalesperson(), completing);
      return undefined;
    },
  };
}

/** The salesperson's connected mailbox, synced to `ready`. */
function mailboxPart(asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'mailbox',
    tables: ['mailboxes', 'mailbox_tokens'],
    run: async () => {
      const mailbox = await insertOrReviveMailbox(asSalesperson(), {
        ownerUserId: state.salespersonUserId,
        emailAddress: state.mailboxAddress,
        providerAccountId: state.mailboxAddress,
        baselineFromAt: '2026-09-01T00:00:00.000Z',
      });
      await setSyncState(asSalesperson(), {
        mailboxId: mailbox.id,
        syncState: 'ready',
        baselineCompletedAt: '2026-09-02T00:00:00.000Z',
      });
      // The grant itself, envelope-encrypted. `localEnvelopeCipher` is the wrapper a
      // local deployment uses; production wraps the data key with KMS, and the row
      // written here has the same shape either way.
      await storeRefreshToken(asSalesperson(), {
        mailboxId: mailbox.id,
        plaintext: 'fixture-refresh-token',
        cipher: localEnvelopeCipher(),
      });
      state.mailboxId = mailbox.id;
      return undefined;
    },
  };
}

/**
 * One outbound message with sent evidence, through the fence rather than through Gmail.
 *
 * `dispatchOutboundMessage` needs a Gmail client; the three fence transitions do not,
 * and they are what leaves the evidence: a `sent` row with an attempt token, a provider
 * message id, and the three append-only `outbound_message_events` rows behind it.
 */
function outboundPart(session: SessionQueryable, asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'outbound',
    tables: ['outbound_messages', 'outbound_message_events', 'step_executions'],
    run: async () => {
      if (state.primaryFirmId === '') return 'the firms part did not run';
      if (state.templateVersionId === null || state.templateContentHash === null) return 'the template part did not run';
      if (state.mailboxId === null) return 'the mailbox part did not run';

      const template = await readTemplateVersion(asSalesperson(), state.templateVersionId);
      if (template === null) throw new Error('the approved template version disappeared');

      // The fence's origin. `makeStepExecution` is the one place that knows the five
      // rows a step execution needs; the brief asks for it to be reused rather than
      // copied.
      const stepExecutionId = await makeStepExecution(session, {
        workspaceId: state.workspaceId,
        firmId: state.primaryFirmId,
        // The firm's own open opportunity, because `opportunities_one_open_per_firm`
        // means the helper cannot make a second one for a firm the fixture has opened.
        ...(state.openOpportunityIds[0] === undefined ? {} : { opportunityId: state.openOpportunityIds[0] }),
        userId: state.salespersonUserId,
        templateVersionId: state.templateVersionId,
        zone: ZONE,
      });
      state.stepExecutionId = stepExecutionId;

      const prepared = value(
        await prepareOutboundMessage(asSalesperson(), {
          stepExecutionId,
          firmId: state.primaryFirmId,
          contactId: state.primaryContactId,
          ownerUserId: state.salespersonUserId,
          templateVersionId: state.templateVersionId,
          templateContentHash: template.contentHash,
          emailAddressId: state.primaryEmailRouteId,
          toAddress: state.primaryEmail,
          subject: template.subject,
          body: template.body,
          sendAt: NOW,
          sourceZone: ZONE,
          businessDate: '2026-09-16',
        }),
        'the outbound fence',
      );
      const claim = value(
        await claimForDispatch(asSalesperson(), { outboundMessageId: prepared.outboundMessageId, businessDate: '2026-09-16' }),
        'the dispatch claim',
      );
      value(
        await recordSent(asSalesperson(), {
          outboundMessageId: prepared.outboundMessageId,
          attemptToken: claim.attemptToken,
          providerMessageId: '18f5a0b1c2d3e4f5',
          providerThreadId: '18f5a0b1c2d3e400',
        }),
        'the sent evidence',
      );
      return undefined;
    },
  };
}

/**
 * The prerequisites every fence part shares, or the part that did not run.
 *
 * A fence needs a firm to be addressed to, an approved template version to name, and a
 * connected mailbox to be sent from; `prepareOutboundMessage` refuses without all three.
 */
function fencePrerequisite(state: State): string | undefined {
  if (state.primaryFirmId === '') return 'the firms part did not run';
  if (state.templateVersionId === null || state.templateContentHash === null) return 'the template part did not run';
  if (state.mailboxId === null) return 'the mailbox part did not run';
  return undefined;
}

/** The subject every fixture fence carries: the approved template version's own. */
const FENCE_SUBJECT = 'A short note about your properties';

/**
 * Write one `prepared` fence with the bytes the caller hands over, through the fence
 * command itself.
 *
 * The body is the caller's because that is precisely the seam these parts exercise:
 * `prepareOutboundMessage` freezes whatever bytes it is given (it checks only that they
 * end in exactly one stop line, `sendBodyIssue`), and the thing that no longer produces
 * the older shapes is `composeSendBody` one step upstream. So a legacy body still goes in
 * through the real command, with the real refusals, the real events and the real
 * `rendered_hash` — no direct INSERT is needed or wanted here.
 *
 * Each fence needs an origin of its own: `outbound_messages_one_per_step_execution` means
 * one fence per step execution. `makeStepExecution` mints one against an existing open
 * opportunity, because `opportunities_one_open_per_firm` forbids it opening a second.
 */
async function prepareFixtureFence(
  session: SessionQueryable,
  asSalesperson: () => RepositoryContext,
  state: State,
  input: {
    readonly firmIndex: number;
    readonly toAddress: string;
    readonly body: string;
    readonly what: string;
    /**
     * Handed the fence's id when one was written. A callback rather than a return
     * value because the return of this function is the *skip reason*, and a part that
     * needs to drive the fence further needs both.
     */
    readonly capture?: ((outboundMessageId: string) => void) | undefined;
  },
): Promise<string | undefined> {
  const prerequisite = fencePrerequisite(state);
  if (prerequisite !== undefined) return prerequisite;
  const templateVersionId = state.templateVersionId;
  const templateContentHash = state.templateContentHash;
  if (templateVersionId === null || templateContentHash === null) return 'the template part did not run';

  const firmId = state.firmIds[input.firmIndex];
  const opportunityId = state.openOpportunityIds[input.firmIndex];
  if (firmId === undefined || opportunityId === undefined) return 'the fixture has no spare firm for this fence';

  const stepExecutionId = await makeStepExecution(session, {
    workspaceId: state.workspaceId,
    firmId,
    opportunityId,
    userId: state.salespersonUserId,
    templateVersionId,
    zone: ZONE,
  });
  const prepared = value(
    await prepareOutboundMessage(asSalesperson(), {
      stepExecutionId,
      firmId,
      ownerUserId: state.salespersonUserId,
      templateVersionId,
      templateContentHash,
      toAddress: input.toAddress,
      subject: FENCE_SUBJECT,
      body: input.body,
      sendAt: NOW,
      sourceZone: ZONE,
      businessDate: '2026-09-16',
    }),
    input.what,
  );
  input.capture?.(prepared.outboundMessageId);
  return undefined;
}

/**
 * A stored body whose footer block is the sign-off and the stop line, and no address.
 *
 * Production holds rows in this shape and nothing composes it deliberately any more: the
 * footer stopped being part of the approved body at 0020 and became something a send
 * composes from the workspace's `postal_address` setting, inside the claiming transaction
 * (`packages/domain/outbound/footer.ts`). A row like this is what
 * `reconcileFenceFooter` meets on an unsent fence prepared by the previous release, and
 * it is what every CHECK a later migration adds to `outbound_messages.body` will be
 * validated against.
 *
 * Two readings, both recorded here. The name is the coordinator's and is kept verbatim,
 * but the migrations read the other way round: 0015 *dropped*
 * `template_versions.footer_postal_address`, so it is the rows written **before 0015**
 * that carry an address and the rows between 0015 and 0020 that do not. The pair of
 * shapes covered is the same either way — with an address line and without — and this is
 * the one without.
 */
function legacyFooterWithoutAddressPart(
  session: SessionQueryable,
  asSalesperson: () => RepositoryContext,
  state: State,
): Part {
  return {
    name: 'legacy footer (pre-0015, no postal address)',
    tables: ['outbound_messages', 'outbound_message_events', 'step_executions'],
    run: async () =>
      await prepareFixtureFence(session, asSalesperson, state, {
        firmIndex: 1,
        toAddress: 'legacy.nofooter.address@firm02.example.test',
        body: fixtureBody('Hello.\n\nA note written before the footer moved out of the approved body.'),
        what: 'the pre-0015 footer fence',
      }),
  };
}

/**
 * The same, with the postal-address line in the block: sign-off, address, stop line.
 *
 * The address is a literal rather than the `postal_address` setting, because the row is a
 * row written before that setting existed — and deliberately *not* one this workspace has
 * ever recorded, which is what makes it the interesting case: `composeSendBody` can only
 * rebuild a block from something the database recorded, so a body like this is held
 * `footer_ambiguous` rather than rewritten. That is a shape no current code path writes
 * and one an upgrade still has to carry.
 */
function legacyFooterWithAddressPart(
  session: SessionQueryable,
  asSalesperson: () => RepositoryContext,
  state: State,
): Part {
  return {
    name: 'legacy footer (pre-0020, with postal address)',
    tables: ['outbound_messages', 'outbound_message_events', 'step_executions'],
    run: async () =>
      await prepareFixtureFence(session, asSalesperson, state, {
        firmIndex: 2,
        toAddress: 'legacy.postal.address@firm03.example.test',
        body:
          'Hello.\n\nA note written while the postal address was still part of the footer.' +
          `\n\n${FIXTURE_SIGN_OFF}\n${LEGACY_POSTAL_ADDRESS}\n${SENDING_STOP_LINE}`,
        what: 'the pre-0020 footer fence',
      }),
  };
}

/**
 * A fence sitting in `prepared` with its frozen envelope, as a part of its own.
 *
 * The `outbound` part prepares a fence and then drives it to `sent`, so without this
 * there is no row left in the state every dispatch starts from — and `prepared` is the
 * state with the most to lose: it is the one a migration can still move, the one
 * `claimForDispatch` takes with `FOR UPDATE`, and the one `reconcileFenceFooter`
 * recomposes. It is written by the real command, which is the one that freezes the
 * envelope.
 */
function preparedFencePart(
  session: SessionQueryable,
  asSalesperson: () => RepositoryContext,
  state: State,
): Part {
  return {
    name: 'prepared fence',
    tables: ['outbound_messages', 'outbound_message_events', 'step_executions'],
    run: async () =>
      await prepareFixtureFence(session, asSalesperson, state, {
        firmIndex: 3,
        toAddress: 'prepared.fence@firm04.example.test',
        body: fixtureBody('Hello.\n\nThis one is still waiting for its dispatch window.'),
        what: 'the prepared fence',
      }),
  };
}

/**
 * A fence left in `reconciling`, owed an observation the moment the upgrade finishes.
 *
 * Without it the reconciliation workflow enumerates an empty set and reports success,
 * which proves nothing at all (GPT-6 review of PR 314, P1-3): `listFencesToReconcile`
 * and `listMailboxesToReconcile` would answer zero on a schema whose
 * `outbound_messages` the migration had broken just as happily as on a healthy one.
 * So the fixture leaves exactly one fence the sweep must find, and the workflow
 * asserts that id comes back.
 *
 * Driven through the three real commands, `prepared → dispatching → reconciling`.
 * `beginReconciling` is the transition a worker that lost its lease performs and the
 * one the sweep performs on an abandoned `dispatching` fence; it leaves
 * `reconcile_last_attempt_at` null, which is what makes the fence owed *now* rather
 * than after a backoff.
 *
 * No mailbox row of its own: `listMailboxesToReconcile` is a `DISTINCT` over the
 * fences' own `mailbox_id`, so the mailbox part's mailbox is the one it returns, and a
 * second mailbox here would only mean a second grant to encrypt.
 */
function reconcilingFencePart(
  session: SessionQueryable,
  asSalesperson: () => RepositoryContext,
  state: State,
): Part {
  return {
    name: 'reconciling fence',
    tables: ['outbound_messages', 'outbound_message_events', 'step_executions', 'mailboxes'],
    run: async () => {
      let outboundMessageId: string | null = null;
      const skipped = await prepareFixtureFence(session, asSalesperson, state, {
        firmIndex: RECONCILING_FENCE_FIRM_INDEX,
        toAddress: 'reconciling.fence@firm05.example.test',
        body: fixtureBody('Hello.\n\nThis one went out into the dark and nobody knows whether it left.'),
        what: 'the reconciling fence',
        capture: id => {
          outboundMessageId = id;
        },
      });
      if (skipped !== undefined) return skipped;
      // Narrowed through a local: the callback above assigns it, which TypeScript's
      // control-flow analysis cannot see through.
      const fenceId: string | null = outboundMessageId;
      if (fenceId === null) throw new Error('the reconciling fence was prepared without an id');

      value(
        await claimForDispatch(asSalesperson(), { outboundMessageId: fenceId, businessDate: '2026-09-16' }),
        'the reconciling fence\'s dispatch claim',
      );
      value(
        await beginReconciling(asSalesperson(), {
          outboundMessageId: fenceId,
          detail: 'the fixture leaves one fence owed an observation, so the sweep has something to enumerate',
          windowHours: RECONCILE_WINDOW_HOURS,
        }),
        'the move to reconciling',
      );
      state.reconcilingFenceId = fenceId;
      return undefined;
    },
  };
}

/**
 * One opted-out handle, so `effective_suppressions` has something to answer about.
 *
 * `effective_suppressions` is the view 10.2 makes authoritative for email and dialing,
 * and no workflow read it before (GPT-6 review of PR 314, P0-4): a migration that
 * replaced it with one returning nothing passed. A view carries no rows of its own, so
 * neither the content hash nor the table shape in step 4 can see that happen either —
 * only a read can.
 *
 * `prospect_opt_out` rather than `salesperson_manual`: it is terminal the instant it
 * commits, so it opens no `manual_suppression_review` hold and enqueues no finalizer
 * job, and therefore cannot change what the eligibility or dashboard steps decide.
 * Written through `recordSuppression`, which is the only writer the table has, inside
 * a transaction so the journal and the row commit together the way the command does in
 * production.
 */
function handleSuppressionPart(
  session: SessionQueryable,
  asSalesperson: () => RepositoryContext,
  state: State,
): Part {
  return {
    name: 'handle suppression',
    tables: ['suppression_events', 'suppression_finalizations'],
    run: async () => {
      const recorded = await withTransaction(
        session,
        async () =>
          await recordSuppression(asSalesperson(), {
            scope: 'handle',
            value: SUPPRESSED_HANDLE,
            source: 'prospect_opt_out',
            commandId: 'fixture-handle-opt-out',
            journal: recordingSuppressionJournal(),
          }),
      );
      state.suppressedHandleKey = value(recorded, 'the handle suppression').canonicalKey;
      return undefined;
    },
  };
}

/**
 * Yesterday's Today card, pinned at algorithm version `today.1`.
 *
 * Built for `LEGACY_BUSINESS_DATE` through `buildTodaySnapshot` — the ordinary command,
 * the one the 05:00 job calls — because a card is only ever produced by the build, and a
 * hand-written card would prove nothing about the trigger that maintains its counts.
 *
 * The version itself is then set directly, and that is the honest exception. There is no
 * command that writes `today_snapshots.algorithm_version`: the column takes its value
 * from the `today_algorithm_version()` database function, which the subject branch's 0023
 * replaces with `today.2`. So the moment the upgrade the test is exercising has run,
 * nothing in the tree can produce a `today.1` row any more — which is exactly why
 * production's existing `today.1` cards need to be in the fixture before it runs. Setting
 * it explicitly also means the row is pinned at the old version whatever the base
 * checkout's function happens to return.
 */
function legacyTodayCardPart(
  session: SessionQueryable,
  asSalesperson: () => RepositoryContext,
  state: State,
): Part {
  return {
    name: 'legacy today card (today.1)',
    tables: ['today_snapshots', 'today_snapshots.algorithm_version', 'today_items'],
    run: async () => {
      if (state.primaryFirmId === '') return 'the firms part did not run';
      // Before the `today` part, and for an earlier date than it builds: a card the
      // current build would rebuild is this morning's card, not a legacy one, and no
      // snooze exists yet to change what the build writes.
      await buildTodaySnapshot(asSalesperson(), {
        businessDate: LEGACY_BUSINESS_DATE,
        now: NOW,
        sources: defaultTodaySources(),
      });
      const pinned = await session.query<{ firm_id: string }>(
        `UPDATE today_snapshots SET algorithm_version = $3
          WHERE workspace_id = $1 AND snapshot_date = $2::date
        RETURNING firm_id`,
        [state.workspaceId, LEGACY_BUSINESS_DATE, LEGACY_TODAY_ALGORITHM_VERSION],
      );
      if (pinned.rows.length === 0) throw new Error('the legacy Today build produced no card to pin');
      return undefined;
    },
  };
}

/**
 * A calling identity, a dial ticket, a call log and a callback.
 *
 * The ticket is the most heavily conditioned row in the schema — suppression, an owned
 * and verified identity, a usable route at the exact version, the firm's assignment and
 * zone, a state posture, the local calling window and every applicable hold — so its
 * refusal code is reported as a skip rather than thrown, as the brief allows. `at` is
 * the fixture's fixed instant, which is 10:00 on a Wednesday in the firm's zone.
 */
function dialPart(asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'dial',
    tables: ['calling_identities', 'dial_tickets', 'call_logs', 'callbacks'],
    run: async () => {

      if (state.primaryFirmId === '') return 'the firms part did not run';
      const identity = value(
        await registerCallingIdentity(asSalesperson(), { e164: '+14015550199', label: 'Fixture line' }),
        'the calling identity',
      );
      state.callingIdentityId = identity.identity.id;

      const ticket = await authorizeDialCommand(asSalesperson(), {
        firmId: state.primaryFirmId,
        contactId: state.primaryContactId,
        routeId: state.primaryPhoneRouteId,
        routeVersion: state.primaryPhoneRouteVersion,
        callingIdentityId: identity.identity.id,
        deviceId: state.deviceId,
        commandId: randomUUID(),
        at: NOW,
      });
      if (!ticket.ok) return `the dial ticket was refused: ${ticket.reason}`;

      const logged = value(
        await logCallOutcome(asSalesperson(), {
          firmId: state.primaryFirmId,
          contactId: state.primaryContactId,
          routeId: state.primaryPhoneRouteId,
          ticketId: ticket.value.ticketId,
          callingIdentityId: identity.identity.id,
          outcome: 'no_answer',
          occurredAt: NOW,
          note: 'Nobody answered; trying again later in the week.',
          journal: recordingSuppressionJournal(),
        }),
        'the call log',
      );
      state.callLogId = logged.callLogId;

      // A callback on a firm that is not the primary one, so the Today build has work
      // that did not come from the call above.
      const other = state.firmIds[1];
      if (other !== undefined) {
        value(
          await createCallback(asSalesperson(), {
            firmId: other,
            assignedUserId: state.salespersonUserId,
            localDate: '2026-09-16',
            localTime: '15:30',
            sourceTimeZone: ZONE,
          }),
          'the callback',
        );
      }
      return undefined;
    },
  };
}

/**
 * Synced messages: one reply that matches and is classified, and one that matches
 * nothing and stays metadata only.
 *
 * The path is the sync pipeline's, step by step — normalize, record, match, body, the
 * deterministic classification and its effects — because those six calls are what
 * `mail.sync` does with a page of ids, and a fixture that inserted the rows directly
 * would not exercise the match rules the migration might move.
 */
function inboundMailPart(asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'inbound mail',
    tables: ['mail_messages', 'mail_message_matches', 'mail_message_bodies', 'mail_message_classifications', 'mail_message_effects'],
    run: async () => {
      if (state.mailboxId === null) return 'the mailbox part did not run';
      const mailboxId = state.mailboxId;

      if (state.primaryFirmId === '') return 'the firms part did not run';
      const metadataOf = (from: string, providerId: string, subject: string): GmailMessageMetadata => ({
        id: providerId,
        threadId: `${providerId}-thread`,
        internalDateEpochMilliseconds: Date.parse(NOW),
        labelIds: ['INBOX'],
        headers: {
          From: from,
          To: state.mailboxAddress,
          Subject: subject,
          'Message-ID': `<${providerId}@mail.example.test>`,
        },
        attachments: [],
        sizeEstimate: 2048,
      });

      // The reply from the primary firm's contact. It matches by participant, because
      // the imported contact's address is a route of that firm.
      const replyMetadata = normalizeMetadata(metadataOf(state.primaryEmail, 'fixture-reply-1', 'Re: A short note'));
      const reply = await recordMessage(asSalesperson(), { mailboxId, metadata: replyMetadata });
      const candidates = await findMatchCandidates(asSalesperson(), {
        mailboxId,
        messageId: reply.message.id,
        metadata: replyMetadata,
      });
      if (candidates.length === 0) throw new Error('the fixture reply matched no opportunity');
      await recordMatches(asSalesperson(), { messageId: reply.message.id, candidates });
      const bodyText = 'Thanks for writing. Could you call me next week to talk it through?';
      await storeMessageBody(asSalesperson(), { messageId: reply.message.id, text: bodyText, truncated: false });

      const classification = classifyReply({
        id: reply.message.id,
        headers: { from: state.primaryEmail, subject: 'Re: A short note' },
        bodyParts: [{ text: bodyText, truncated: false }],
      });
      await recordDeterministicClassification(asSalesperson(), {
        messageId: reply.message.id,
        classification,
      });
      await applyClassificationEffects(asSalesperson(), {
        message: reply.message,
        classification,
        candidates,
        journal: recordingSuppressionJournal(),
        replyPromoter: recordingReplyPromoter(),
      });
      state.classifiedMessageId = reply.message.id;

      // A message from nobody this workspace knows: recorded, unmatched, metadata only,
      // which is the row the thirty-day sweep is supposed to take.
      const strangerMetadata = normalizeMetadata(
        metadataOf('stranger@unknown.example.test', 'fixture-unmatched-1', 'A newsletter'),
      );
      await recordMessage(asSalesperson(), { mailboxId, metadata: strangerMetadata });
      return undefined;
    },
  };
}

/** The model layer, its cost record, and a person's confirmation of the reply. */
function classificationPart(asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'classification',
    tables: ['mail_message_classifications', 'mail_classification_calls', 'mail_reply_confirmations'],
    run: async () => {
      if (state.classifiedMessageId === null) return 'the inbound mail part did not run';
      const messageId = state.classifiedMessageId;

      await recordModelClassification(asSalesperson(), {
        messageId,
        suggestion: {
          class: 'human',
          disposition: 'follow_up_later',
          confidence: 0.82,
          supportingExcerpt: 'Could you call me next week',
          callbackProposal: { localDateTime: '2026-09-23 10:00', timeZone: ZONE },
          modelVersion: 'claude-opus-5',
          promptVersion: 'g7b.replies.1',
        },
        effort: 'low',
        deterministicSignals: [{ rule: 'human_reply', evidence: 'no automation headers' }],
      });
      await recordClassifierCall(asSalesperson(), {
        messageId,
        call: {
          modelName: 'claude-opus-5',
          promptVersion: 'g7b.replies.1',
          effort: 'low',
          requestSent: true,
          outcome: 'accepted',
          inputTokens: 900,
          cachedInputTokens: 700,
          outputTokens: 80,
          latencyMs: 640,
          stopReason: 'end_turn',
          refusalCategory: null,
        },
      });

      const instant = resolveConfirmedInstant({ localDate: '2026-09-23', localTime: '10:00', sourceTimeZone: ZONE });
      if (!instant.ok) throw new Error(`the fixture callback instant is unresolvable: ${instant.reason}`);
      value(
        await confirmReplyDisposition(asSalesperson(), {
          messageId,
          disposition: 'follow_up_later',
          callback: { localDate: '2026-09-23', localTime: '10:00', sourceTimeZone: ZONE, dueAt: instant.dueAt },
          journal: recordingSuppressionJournal(),
        }),
        'the reply confirmation',
      );
      return undefined;
    },
  };
}

/** Today, built for the fixture's own business date, with one task snoozed. */
function todayPart(asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'today',
    tables: ['today_snapshots', 'today_items', 'today_snoozes'],
    run: async () => {

      if (state.primaryFirmId === '') return 'the firms part did not run';
      state.businessDate = await businessDateOf(asSalesperson(), NOW);
      await buildTodaySnapshot(asSalesperson(), {
        businessDate: state.businessDate,
        now: NOW,
        sources: defaultTodaySources(),
      });

      // `listTodayItems` is per firm, so the search walks the firms the build could
      // have produced work for and takes the first manual task it finds.
      let snoozable: TodayItemRow | undefined;
      for (const firmId of state.firmIds) {
        const items = await listTodayItems(asSalesperson(), { businessDate: state.businessDate, firmId });
        snoozable = items.find(item => item.status === 'open' && !item.automated);
        if (snoozable !== undefined) break;
      }
      if (snoozable === undefined) throw new Error('the Today build produced no manual task to snooze');
      value(
        await snoozeTodayItem(asSalesperson(), {
          itemId: snoozable.id,
          reason: 'Waiting on the prospect to come back from leave.',
          // Measured from the wall clock rather than from `NOW`: `snoozeTodayItem`
          // refuses `snooze_return_not_future` against the database's own clock, so a
          // fixed instant in 2026 would be a fixture that stopped loading in 2027.
          returnAt: new Date(Date.now() + 86_400_000).toISOString(),
        }),
        'the snooze',
      );
      return undefined;
    },
  };
}

/**
 * Jobs in every state the queue has: queued, running under a live lease, done, dead.
 *
 * The queued one is enqueued with a `runAt` in the future, so the claim below cannot
 * take it — a fixture whose "queued" job was claimed by its own next statement would
 * have three states, not four.
 */
function jobsPart(session: SessionQueryable, state: State): Part {
  return {
    name: 'jobs',
    tables: ['jobs'],
    run: async () => {
      const db: Queryable = session;

      await enqueueJob(db, {
        workspaceId: state.workspaceId,
        kind: 'today.build',
        idempotencyKey: 'fixture:today:queued',
        payload: { businessDate: state.businessDate },
        // Far enough ahead of the database's clock that the claim below cannot take it,
        // for as long as this fixture is in use.
        runAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      });

      const running = await enqueueJob(db, {
        workspaceId: state.workspaceId,
        kind: 'mail.sync',
        idempotencyKey: 'fixture:mail-sync:running',
        payload: { mailboxId: state.mailboxId ?? 'none' },
      });
      const done = await enqueueJob(db, {
        workspaceId: state.workspaceId,
        kind: 'mail.reconcile',
        idempotencyKey: 'fixture:mail-reconcile:done',
        payload: { mailboxId: state.mailboxId ?? 'none' },
      });
      const dead = await enqueueJob(db, {
        workspaceId: state.workspaceId,
        kind: 'mail.recover',
        idempotencyKey: 'fixture:mail-recover:dead',
        payload: { mailboxId: state.mailboxId ?? 'none' },
      });

      // Three kinds nothing else in the fixture enqueues. `route.validate` would not
      // do: verifying the email route enqueues one per address, and the claim below —
      // which is ordered by `run_at` — would take those instead of these.
      const claims = await claimJobs(db, {
        owner: 'fixture-worker',
        kinds: ['mail.sync', 'mail.reconcile', 'mail.recover'],
        limit: 3,
        // Long enough that the lease is still live when the upgrade runs, which is the
        // point of the "leased/running" row.
        leaseSeconds: 3600,
      });
      const byId = new Map(claims.map(claim => [claim.id, claim]));
      if (![running.jobId, done.jobId, dead.jobId].every(id => byId.has(id))) {
        throw new Error('the claim did not take the three jobs the fixture enqueued for it');
      }

      const runningClaim = byId.get(running.jobId);
      if (runningClaim !== undefined) {
        await writeProgress(db, {
          jobId: runningClaim.id,
          workspaceId: runningClaim.workspaceId,
          fencingToken: runningClaim.fencingToken,
          progress: { cursor: 'history-42' },
        });
      }
      const doneClaim = byId.get(done.jobId);
      if (doneClaim !== undefined) await completeJob(db, doneClaim);
      const deadClaim = byId.get(dead.jobId);
      if (deadClaim !== undefined) {
        await killJob(db, deadClaim, { code: 'chunking_unsupported', detail: 'the fixture buries one job on purpose' });
      }
      return undefined;
    },
  };
}

/** Funnel facts: the counts the dashboard reads, one per stage of the funnel it has. */
function funnelPart(asSalesperson: () => RepositoryContext, state: State): Part {
  return {
    name: 'funnel facts',
    tables: ['funnel_facts'],
    run: async () => {
      if (state.primaryFirmId === '') return 'the firms part did not run';
      // Imported here rather than at the top of the file: the module arrived with
      // migration 0022's table, and at an earlier N the probe above skips the part
      // before anything tries to load a file that is not in that checkout.
      const { recordFunnelFact } = await import('@fss/domain/funnel/facts.ts');
      const firmId = state.primaryFirmId;
      await recordFunnelFact(asSalesperson(), {
        kind: 'firm.created',
        source: 'crm',
        dedupeKey: firmId,
        firmId,
        detail: { origin: 'csv_import' },
      });
      if (state.callLogId !== null) {
        await recordFunnelFact(asSalesperson(), {
          kind: 'call.placed',
          source: 'telephony',
          dedupeKey: state.callLogId,
          firmId,
          detail: { outcome: 'no_answer' },
        });
      }
      const opportunityId = state.openOpportunityIds[0];
      if (opportunityId !== undefined) {
        await recordFunnelFact(asSalesperson(), {
          kind: 'mail.warm_sent',
          source: 'outbound',
          dedupeKey: `${firmId}:1`,
          firmId,
          opportunityId,
          detail: { step: 1 },
        });
      }
      return undefined;
    },
  };
}

/** One release record, stored through `putReleaseRecord` as the CI gate stores it. */
function releasePart(session: SessionQueryable): Part {
  return {
    name: 'release record',
    tables: ['release_records'],
    run: async () => {
      await storeFixtureCiGateRecord(session, '9900112233');
      return undefined;
    },
  };
}

/**
 * The operational rows: counters, heartbeats, the canary, an alert, the terminal-stop
 * cursor and one schedule shift.
 *
 * Each is written by the function that owns it rather than by an insert here, because
 * each of these tables has a shape a migration could move (a generated column, a
 * partial unique index) and the owning function is what a release would break.
 */
function operationsPart(
  session: SessionQueryable,
  asAdmin: () => RepositoryContext,
  asWorker: () => RepositoryContext,
  state: State,
): Part {
  return {
    name: 'operations',
    tables: ['daily_counters', 'heartbeats', 'canary_runs', 'critical_alerts', 'sequence_event_cursors'],
    run: async () => {

      await incrementDailyCounter(
        asAdmin(),
        {
          subjectKind: 'mailbox',
          subjectKey: state.mailboxAddress,
          counterKind: 'automated_sends',
          businessTimeZone: ZONE,
          at: NOW,
        },
        75,
      );
      await recordHeartbeat(session, { component: 'worker', instanceKey: 'fixture-worker', expectedIntervalSeconds: 60 });
      const canary = await insertCanaryRun(session, state.workspaceId, NOW);
      await completeCanaryRun(session, state.workspaceId, canary.quarterHour, 'fixture-worker');
      await raiseCriticalAlert(session, {
        workspaceId: state.workspaceId,
        alertKey: 'fixture_condition',
        severity: 'warning',
        detail: { raisedBy: 'the upgrade fixture' },
      });

      // The Lost close emitted an `opportunity.terminal_stop`; consuming it writes the
      // subscriber's cursor, which is the only writer `sequence_event_cursors` has.
      await consumeTerminalStops(asWorker(), { limit: 10 });

      return undefined;
    },
  };
}

/**
 * One schedule shift, and the append-only row that records it.
 *
 * Its own part rather than a line of `operations`, so that when the step execution it
 * moves does not exist the empty `step_execution_shifts` has a reason naming the part
 * that would have written it.
 */
function shiftPart(asWorker: () => RepositoryContext, state: State): Part {
  return {
    name: 'schedule shift',
    tables: ['step_execution_shifts', 'step_executions'],
    run: async () => {
      if (state.stepExecutionId === null) return 'the outbound part did not run';
      const execution = await readStepExecution(asWorker(), state.stepExecutionId);
      if (execution === null) return 'the fixture step execution is not readable';
      await rescheduleExecution(asWorker(), {
        execution,
        toDueAt: new Date(Date.parse(execution.dueAt) + 3_600_000).toISOString(),
        reason: 'send_window',
      });
      return undefined;
    },
  };
}

/** One administrative pause, opened last so its hold blocks nothing the fixture still needs. */
function pausePart(asAdmin: () => RepositoryContext): Part {
  return {
    name: 'administrative pause',
    tables: ['administrative_pauses', 'active_holds'],
    run: async () => {
      value(
        await openPause(asAdmin(), {
          scopeKind: 'channel',
          channel: 'email',
          reasonNote: 'The fixture pauses the email lane so a pause and its hold both exist.',
        }),
        'the administrative pause',
      );
      return undefined;
    },
  };
}

/**
 * The two-workspace helpers, run on the app_runtime session.
 *
 * These reach the tables no command in this tree writes — a Pub/Sub notification, a
 * mailbox recovery, an evidence item, a suppression tombstone, a mailbox watch — and
 * they do it in their own alpha and beta workspaces. That is fine and is the point of
 * the coverage requirement being per table: a second and third workspace also make
 * every "nothing crosses" assertion in the upgraded schema meaningful.
 */
function sharedWorkspacesPart(session: SessionQueryable): Part {
  return {
    name: 'shared two-workspace fixtures',
    tables: [
      'mailbox_watches',
      'gmail_push_notifications',
      'mailbox_recoveries',
      'evidence_items',
      'suppression_events',
      'sending_domains',
      'mailbox_send_ramp',
      'mailbox_send_days',
      'suppression_finalizations',
    ],
    run: async () => {

      const seeded = await seedTwoWorkspaces(session);
      const crm = await seedCrm(session, seeded);
      const mail = await seedMail(session, seeded, crm);
      await seedOutbound(session, seeded, crm, mail);
      await seedPolicy(session, seeded, crm);
      const retention = await seedRetention(session, seeded, crm, mail);
      await seedSequences(session, seeded);

      // The ten-minute window's terminal marker, against a tombstone the retention
      // fixture wrote: `suppression_finalizations` has no other writer.
      const alpha = repositoryContext(
        workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
        session,
      );
      await claimFinalization(alpha, { eventId: retention.alpha.tombstoneEventId, outcome: 'finalized' });
      return undefined;
    },
  };
}
