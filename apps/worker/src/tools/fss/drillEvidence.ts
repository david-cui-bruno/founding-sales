import { randomUUID } from 'node:crypto';
import {
  repositoryContext,
  withTransaction,
  workspaceScope,
  type RepositoryContext,
  type SessionQueryable,
} from '@fss/domain/db';
import { SENDING_STOP_LINE } from '@fss/contracts';
import {
  addEmailRoute,
  addPhoneRoute,
  createContact,
  createFirm,
  listContacts,
  listRoutes,
  openOpportunity,
  readFirm,
  readOpenOpportunity,
  resolveZoneForFirm,
  updateFirm,
  type FirmRow,
  type OpportunityRow,
  type RouteRow,
} from '@fss/domain/crm';
import { confirmReplyDisposition } from '@fss/domain/classification';
import {
  accessForMailbox,
  insertOrReviveMailbox,
  laterHistoryId,
  processMessageIds,
  readMailboxForOwner,
  recordedGmailClient,
  recordedSentMessageId,
  recordedSentThreadId,
  runMailRecovery,
  startRecovery,
  storeRefreshToken,
  type GmailFixtureMessage,
  type MailboxRow,
} from '@fss/domain/mail';
import {
  dispatchOutboundMessage,
  prepareOutboundMessage,
  readFence,
  readPrimarySendingDomain,
  recordAuthenticationChecklist,
  registerSendingDomain,
  setAutomatedSendingEnabled,
} from '@fss/domain/outbound';
import { registerCallingIdentity, verifyCallingIdentity } from '@fss/domain/dial';
import { openPause } from '@fss/domain/policy';
import { readRestoreCounts } from '@fss/domain/restore';
import {
  createDraftVersion,
  createSequence,
  enrollContact,
  listSequenceVersions,
  listSequences,
  publishVersion,
} from '@fss/domain/sequences';
import { readSetting, updateSetting } from '@fss/domain/settings';
import { isSuppressed, recordSuppression } from '@fss/domain/suppression';
import { approveTemplateVersion, createTemplateVersion, listTemplateVersions } from '@fss/domain/templates';
import type { MailWorkerOptions } from '../../handlers/mail.ts';

/**
 * `fss admin drill seed-evidence` — the activity the restore drill has to reconstruct
 * (lane g40).
 *
 * ## The gap this closes
 *
 * `docs/greenfield/restore-drill.md` section 0.1 says what must exist before the
 * restore target is read: an accepted send, a prospect reply, a prospect-originated
 * opt-out, a salesperson's own manual suppression inside its ten-minute window, an
 * ordinary CRM edit, and an applied migration. Until this command nothing in a
 * *deployed* environment could produce any of the first five. The ninth full rehearsal
 * (run 35930664547, 23 September 2026) is where that became visible from outside:
 * create, fill, the deploy path, the workspace bootstrap, the schema-range refusals,
 * the production smoke and the release suite all passed for the first time, and step 22
 * then failed after 67 seconds because the baseline it measured was empty — "the drill
 * baseline has no sends, so reconstructing them would prove nothing". A refusal that is
 * correct, and one a fresh environment could never stop making.
 *
 * ## Why this is the rehearsal's command and never production's
 *
 * Production's drill (runbook section 7, Appendix E) runs against real data and must
 * never be seeded: the whole point of it is that the sends, replies and suppressions
 * it reconstructs are a salesperson's. Two independent guards say so, and neither is a
 * comment:
 *
 *   * the command refuses unless `FSS_DEPENDENCIES` is exactly `recorded`, exactly as
 *     `fss drill` refuses — it reaches the Gmail seam, and a seed that sent live mail
 *     from a command line is not something this tool does;
 *   * `infra/scripts/release-seed-drill-evidence.sh` refuses a production prefix
 *     outright, with `rehearsal_require_prefix`, and has no `--environment production`
 *     escape hatch for an operator to reach for.
 *
 * ## The domain's own entry points, and no row without one
 *
 * Every business fact below is produced by the function that owns its invariant —
 * `createFirm`, `addEmailRoute`, `addPhoneRoute`, `enrollContact`,
 * `prepareOutboundMessage`, `dispatchOutboundMessage`, `processMessageIds`,
 * `recordSuppression`, `confirmReplyDisposition`, `openPause`, `updateSetting`,
 * `registerSendingDomain`, `registerCallingIdentity`, `verifyCallingIdentity`. That
 * matters because the drill then reconstructs rows a real path wrote: a fence seeded
 * with an `INSERT` would prove the restore copied a row, not that at-most-once sending
 * survived it.
 *
 * The `sending_domains` row was g40's one exception, inserted with its booleans left
 * false; lane g57's `registerSendingDomain` is its creator now, and the seed calls it.
 * The last row with no creator was a *verified calling identity*, and lane g59 left the
 * drill's step 1 dial probe unanswered rather than fake one. Lane g60 gave it its
 * creator — a salesperson registers their own number and attests that it is the one they
 * call from — and the seed now takes that path as the rehearsal admin, so the probe has
 * a subject and step 1 can be answered.
 *
 * ## Three phases (lane g59)
 *
 * `before` is g40's evidence plus what the later drill steps need to find in the
 * restored copy; `in-flight` is a send left in doubt just before the restore target, for
 * step 3; `after` runs once the restore is requested and adds the activity the restore
 * loses — a send, a CRM edit, and a prospect's journalled opt-out for steps 2 and 4.
 * Lane g73 adds the send step 3's missing-fence recovery needs: an enrollment made in
 * `before`, whose step the `after` phase sends, so the restored copy holds the step
 * pending with no fence while the Sent folder holds its message.
 * Each phase reports what its recorded mailbox holds (`MailboxRecording`), because the
 * drill's own recorded client, in another task, can know the mailbox only from that.
 *
 * ## Why the recorded Gmail client is built here rather than taken from the deployment
 *
 * `readGmailDeployment` hands a `recorded` deployment one fixed fixture with no
 * messages in it (`apps/worker/src/bootstrap/deployment.ts`), which is right for every
 * other caller and useless for a seed whose whole job is to make a reply and an opt-out
 * arrive. So the seed builds its own `recordedGmailClient` — the same fake, from the
 * same module — and takes the OAuth configuration, the envelope cipher and the
 * suppression journal from the deployment, because those three are what make the
 * evidence real: the token is wrapped by the deployment's own cipher, and the opt-out
 * is journalled to the environment's own object-locked bucket before its row.
 *
 * ## Idempotence
 *
 * Every step reads before it writes and reports `created` or `existing`. The firms are
 * found again by their `record_aliases` external id, the contacts by name, the routes
 * by address, the send by the fence its step execution already has, the two ingested
 * messages by their fixed provider ids, and the manual suppression by
 * `isSuppressed`. A second run of a phase adds nothing.
 */

/**
 * The three phases, in the order the rehearsal runs them (lane g59 added `in-flight`).
 *
 *   * `before` — the workflow's own step, long before the restore target: everything
 *     0.1 lists, plus the prerequisites the later steps of the drill need to exist in
 *     the restored copy (a firm whose opt-out arrives later, a phone route and the
 *     admin's attested calling number, an administrative pause).
 *   * `in-flight` — run by the drill script just before it reads the restore target:
 *     one send whose Gmail call delivered and whose response never came back, so its
 *     fence is `reconciling` when the target is taken and Appendix E step 3 has a fence
 *     the Sent folder proves.
 *   * `after` — run by the drill script once the restore has been requested, so the
 *     restore deterministically loses it: a second send, a second CRM edit, and a
 *     prospect's opt-out, journalled, which is what steps 2 and 4 reconstruct. Lane g73:
 *     and the send of a step the `before` phase enrolled, whose fence the restored copy
 *     therefore never has while its step is still there, pending — Appendix E.3's
 *     "missing fence", which step 3 must tombstone and step 5 must not send again.
 */
export type DrillEvidencePhase = 'before' | 'in-flight' | 'after';

export const DRILL_EVIDENCE_PHASES: readonly DrillEvidencePhase[] = Object.freeze(['before', 'in-flight', 'after']);

export type DrillEvidenceOutcome = 'created' | 'existing';

export interface DrillEvidenceItem {
  /** The step, in the words section 0.1 uses for it. */
  readonly step: string;
  readonly outcome: DrillEvidenceOutcome;
  /** The row this step is about: a firm, a fence, a suppression event, a message. */
  readonly id: string;
}

/**
 * What the recorded mailbox holds after a phase (lane g59): its Sent folder and the
 * inbound messages the phase delivered, in the shape `recordedGmailClient` is built from.
 *
 * A recorded Gmail lives in the process that built it, so the drill's client, in
 * another task, would otherwise hold an empty mailbox no real one could be: its Sent
 * search would find nothing to reconcile and its inbox nothing to recover. The runner
 * merges the three phases' recordings and hands the drill the result as
 * `--mailbox-recording-json`, the way it hands over the baseline. Nothing in it comes
 * from the restored database, and nothing in it is a credential.
 */
export interface MailboxRecording {
  readonly emailAddress: string;
  readonly historyId: string;
  readonly sentMessageIds: readonly string[];
  readonly messages: readonly GmailFixtureMessage[];
  /**
   * The Sent folder's messages, with the metadata a listing returns (lane g73): the
   * Message-ID, the recipient, the subject and the instant. Step 3 lists the folder for
   * the sends whose fence the restore lost, and a list of Message-IDs cannot be listed.
   * Built from the fences the phase vouches for, so a re-run records the same thing.
   */
  readonly sentMessages: readonly GmailFixtureMessage[];
}

export interface DrillEvidenceReport {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly phase: DrillEvidencePhase;
  /**
   * The workspace admin the seed acted as. The runner hands it to the drill as
   * `--admin-user`, because Appendix E step 9's advance is attributed to an active admin
   * and the drill task has no other way to name one. A public identifier.
   */
  readonly adminUserId: string;
  readonly mailbox: MailboxRecording;
  readonly items: readonly DrillEvidenceItem[];
  /**
   * The instant the counts below were measured at, and the instant the drill's wait
   * loop compares `LatestRestorableTime` against: evidence that is not yet inside RDS's
   * continuous backup window would be evidence the restore target predates.
   */
  readonly asOf: string;
  readonly sends: number;
  readonly replies: number;
  readonly suppressions: number;
  readonly crm_edits: number;
  readonly migrations: number;
}

export type DrillEvidenceRefusal =
  | 'workspace_unknown'
  | 'admin_unknown'
  | 'phase_unknown'
  | 'step_unproducible';

export type DrillEvidenceResult =
  | { readonly ok: true; readonly value: DrillEvidenceReport }
  | { readonly ok: false; readonly reason: DrillEvidenceRefusal; readonly detail: string };

export interface DrillEvidenceInput {
  readonly session: SessionQueryable;
  /** The deployment's own mail composition: the cipher, the OAuth configuration and the journal. */
  readonly mail: MailWorkerOptions;
  readonly workspaceSlug: string;
  readonly phase: DrillEvidencePhase;
}

/**
 * A step that could not be produced through a real path.
 *
 * Thrown rather than returned so that no partial answer can be reported as a success,
 * and caught at the top into a refusal naming the step. There is no branch anywhere
 * below that reaches for an `INSERT` when a domain function refuses.
 */
class EvidenceRefusal extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`${step}: ${detail}`);
    this.name = 'EvidenceRefusal';
  }
}

/** `.invalid` is reserved by RFC 2606 and resolves nowhere, which is the point. */
const EVIDENCE_DOMAIN = 'drill-evidence.invalid';
const EXTERNAL_ID_PREFIX = 'fss-drill-evidence';
const MAILBOX_ADDRESS = `sales@${EVIDENCE_DOMAIN}`;
const SEQUENCE_NAME = 'Drill evidence';
const TEMPLATE_NAME = 'Drill evidence opening note';
const SIGN_OFF = 'Drill Evidence';
const TEMPLATE_SUBJECT = 'A short note from the drill evidence seed';
/**
 * A body that passes every rule of 11.1 and 12.6: plain text, under the word limit, no
 * URL, no pricing or guarantee language, no "unsubscribe" (which the table's own CHECK
 * refuses), and ending in the sign-off and then the stop line, in that order.
 */
const TEMPLATE_BODY = [
  'Hello,',
  '',
  'I work with teams like yours and wanted to introduce myself. If a short',
  'conversation would be useful, tell me a time that suits you and I will call.',
  '',
  SIGN_OFF,
  SENDING_STOP_LINE,
].join('\n');

/** The reply that classifies `uncertain`: a real question, and not an opt-out. */
const REPLY_BODY = 'What does this cost and how does the integration work?';
/** One of the three sentences `hasExplicitOptOut` recognises, whole and on its own. */
const OPT_OUT_BODY = 'Please stop emailing me.';

const REPLY_MESSAGE_ID = 'fss-drill-evidence-reply-1';
const OPT_OUT_MESSAGE_ID = 'fss-drill-evidence-opt-out-1';
/** Lane g59: the opt-out that arrives after the restore target, from a firm made before it. */
const LATE_OPT_OUT_MESSAGE_ID = 'fss-drill-evidence-opt-out-2';

/**
 * The phone route the dial probe needs half of (lane g59).
 *
 * 555-0100 to 555-0199 is reserved for fiction in the North American plan, and 617 is
 * the MA zone every evidence firm is in. The route is real — `addPhoneRoute`, usable —
 * so the drill's step 1 dial probe finds an assigned firm with a usable phone route.
 */
const DIAL_ROUTE_E164 = '+16175550142';

/**
 * The rehearsal admin's own calling number, the dial probe's other half (lane g60).
 *
 * Fictional, like the route, and a different number: the line a call leaves on is not
 * the line it rings. It becomes verified the way David's does — registered, then
 * attested by its owner — so the drill's step 1 asks `authorizeDial` a question whose
 * only honest answer during a restore is a refusal.
 */
const DRILL_CALLING_NUMBER = '+16175550143';

interface EvidenceFirmSpec {
  readonly key: string;
  readonly name: string;
  readonly website: string;
  readonly contactName: string;
  readonly address: string;
  /** False only for the firm the manual suppression is recorded against. */
  readonly opportunity: boolean;
}

const FIRMS: Readonly<
  Record<'send' | 'optOut' | 'manual' | 'after' | 'lateOptOut' | 'inFlight' | 'restoreLost', EvidenceFirmSpec>
> = Object.freeze({
  send: {
    key: 'send',
    name: 'Drill Evidence Sends',
    website: `https://${EVIDENCE_DOMAIN}`,
    contactName: 'Drill Evidence Primary',
    address: `primary@${EVIDENCE_DOMAIN}`,
    opportunity: true,
  },
  optOut: {
    key: 'opt-out',
    name: 'Drill Evidence Opt Out',
    website: `https://opt-out.${EVIDENCE_DOMAIN}`,
    contactName: 'Drill Evidence Opt Out Contact',
    address: `opt-out@${EVIDENCE_DOMAIN}`,
    opportunity: true,
  },
  manual: {
    key: 'manual',
    name: 'Drill Evidence Manual Suppression',
    website: `https://manual.${EVIDENCE_DOMAIN}`,
    contactName: 'Drill Evidence Manual Contact',
    address: `manual@${EVIDENCE_DOMAIN}`,
    opportunity: false,
  },
  after: {
    key: 'after',
    name: 'Drill Evidence After The Target',
    website: `https://after.${EVIDENCE_DOMAIN}`,
    contactName: 'Drill Evidence After Contact',
    address: `after@${EVIDENCE_DOMAIN}`,
    opportunity: true,
  },
  // Lane g59. Made in the `before` phase so the restored copy knows the prospect; the
  // opt-out arrives in the `after` phase, which the restore loses. An opt-out from a
  // firm the restored database had never heard of would match nothing on recovery.
  lateOptOut: {
    key: 'late-opt-out',
    name: 'Drill Evidence Late Opt Out',
    website: `https://late-opt-out.${EVIDENCE_DOMAIN}`,
    contactName: 'Drill Evidence Late Opt Out Contact',
    address: `late-opt-out@${EVIDENCE_DOMAIN}`,
    opportunity: true,
  },
  // Lane g59. Its own firm and contact, because one live enrollment per contact.
  inFlight: {
    key: 'in-flight',
    name: 'Drill Evidence In Flight',
    website: `https://in-flight.${EVIDENCE_DOMAIN}`,
    contactName: 'Drill Evidence In Flight Contact',
    address: `in-flight@${EVIDENCE_DOMAIN}`,
    opportunity: true,
  },
  // Lane g73. Enrolled in the `before` phase, so the restored copy has the enrollment
  // and its pending step; sent in the `after` phase, so the restored copy has no fence.
  restoreLost: {
    key: 'restore-lost',
    name: 'Drill Evidence Restore Lost Send',
    website: `https://restore-lost.${EVIDENCE_DOMAIN}`,
    contactName: 'Drill Evidence Restore Lost Contact',
    address: `restore-lost@${EVIDENCE_DOMAIN}`,
    opportunity: true,
  },
});

/**
 * The sequence the restore-lost enrollment is in (lane g73): one email step, due thirty
 * days after enrolment.
 *
 * Delayed so that nothing but the `after` phase sends it. A rehearsal's worker is
 * running against the source while the phases run, and a step due at once would be the
 * worker's to prepare — its fence would then exist before the restore point, and the
 * restored copy would hold a `prepared` or `held` fence rather than none. 720 hours is
 * well under the schema's 8,760 and far past any rehearsal. The `after` phase prepares
 * and dispatches the step directly, as every seeded send does.
 */
const LOST_SEND_SEQUENCE = Object.freeze({ name: 'Drill evidence, restore-lost send', delayHours: 720 });

/**
 * The name the ordinary CRM edit sets, per phase.
 *
 * A display-name change is 0.1's own example of "an ordinary CRM edit with no protected
 * effect": `updateFirm` writes one `firm.updated` audit row, emits no domain event,
 * opens no hold and reassigns nobody. Two different names so that the after phase's
 * edit is a second edit rather than the same one written twice — and so that a re-run
 * of either phase finds the name already set and writes nothing.
 */
const CRM_EDIT_NAMES: Readonly<Record<'before' | 'after', string>> = Object.freeze({
  before: `${FIRMS.send.name} — before the restore target`,
  after: `${FIRMS.send.name} — after the restore target`,
});

const RELEASE_GATE_REFERENCE = 'rehearsal-drill-evidence';

/**
 * An instant inside the email window of the fence's own zone.
 *
 * `decideSend` re-derives 11.2's window from the clock it is given rather than from the
 * fence's `send_at`, so a rehearsal that ran at three on a Sunday morning would be
 * refused `outside_email_window` and produce no send at all. The seed therefore names
 * the clock, deterministically: nine in the morning UTC on the most recent weekday. It
 * is the same seam `packages/domain/test/outbound/support/outboundWorld.ts` uses, and
 * it moves nothing else — `sent_at` is still database `now()`, written by `recordSent`.
 */
export function windowInstant(from: Date): Date {
  const at = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 9, 0, 0));
  while (at.getUTCDay() === 0 || at.getUTCDay() === 6) at.setUTCDate(at.getUTCDate() - 1);
  return at;
}

const businessDateOf = (at: Date): string => at.toISOString().slice(0, 10);

interface Workspace {
  readonly id: string;
  readonly slug: string;
  readonly adminUserId: string;
}

async function readWorkspace(session: SessionQueryable, slug: string): Promise<Workspace> {
  const { rows } = await session.query<{ id: string }>('SELECT id FROM workspaces WHERE slug = $1', [slug]);
  const workspace = rows[0];
  if (workspace === undefined) {
    throw new EvidenceRefusal(
      'workspace',
      `no workspace has the slug '${slug}'; run fss admin workspace bootstrap first`,
    );
  }
  // The admin the bootstrap made, and the only member a fresh environment has. It is
  // the assignee of every firm below and the actor of every admin-only command, so a
  // workspace with no active admin is a refusal rather than a seed that half ran.
  const { rows: members } = await session.query<{ user_id: string }>(
    `SELECT user_id FROM workspace_memberships
      WHERE workspace_id = $1 AND role = 'admin' AND status = 'active'
      ORDER BY created_at, user_id
      LIMIT 1`,
    [workspace.id],
  );
  const admin = members[0];
  if (admin === undefined) {
    throw new EvidenceRefusal('workspace', `workspace '${slug}' has no active admin membership to act as`);
  }
  return { id: workspace.id, slug, adminUserId: admin.user_id };
}

interface SeededFirm {
  readonly firm: FirmRow;
  readonly contactId: string;
  readonly routeId: string;
  /** `email_addresses.address`, lower-cased by `addEmailRoute` on the way in. */
  readonly routeAddress: string;
  readonly opportunity: OpportunityRow | null;
  readonly outcome: DrillEvidenceOutcome;
}

/**
 * The address of an email route.
 *
 * `RouteRow` is the shared shape of a phone route and an email one, so the address
 * arrives through its index signature as `unknown`. Narrowed here, once, rather than
 * asserted at each of the four call sites.
 */
function routeAddress(route: RouteRow): string {
  const value = route['value'];
  if (typeof value !== 'string' || value.length === 0) {
    throw new EvidenceRefusal('route', 'the email route carries no address');
  }
  return value;
}

/** The firm's row, found by the external id every run writes, or created with it. */
async function ensureFirm(
  context: RepositoryContext,
  workspace: Workspace,
  spec: EvidenceFirmSpec,
): Promise<SeededFirm> {
  const externalId = `${EXTERNAL_ID_PREFIX}:${spec.key}`;
  const { rows } = await context.db.query<{ firm_id: string }>(
    `SELECT firm_id FROM record_aliases
      WHERE workspace_id = $1 AND record_kind = 'firm' AND alias_kind = 'external_id' AND alias_value = $2`,
    [workspace.id, externalId],
  );
  const found = rows[0];
  let firm: FirmRow | null = found === undefined ? null : await readFirm(context, found.firm_id);
  const outcome: DrillEvidenceOutcome = firm === null ? 'created' : 'existing';
  if (firm === null) {
    const created = await createFirm(context, {
      name: spec.name,
      website: spec.website,
      assignedUserId: workspace.adminUserId,
      externalId,
      // A single-zone state, so `resolveZoneForFirm` below has a recorded answer to
      // short-circuit on and the enrollment never sees `firm_zone_unknown`.
      regionCode: 'MA',
      countryCode: 'US',
    });
    if (!created.ok) throw new EvidenceRefusal('firm', `createFirm refused with ${created.reason}`);
    firm = created.value;
  }
  if (firm.time_zone === null) {
    const zone = await resolveZoneForFirm(context, { firmId: firm.id, recordedZone: 'America/New_York' });
    if (!zone.ok) throw new EvidenceRefusal('firm', `resolveZoneForFirm refused with ${zone.reason}`);
    const reread = await readFirm(context, firm.id);
    if (reread === null) throw new EvidenceRefusal('firm', 'the firm vanished between its creation and its zone');
    firm = reread;
  }

  const contacts = await listContacts(context, firm.id);
  let contactId = contacts.find(contact => contact.full_name === spec.contactName)?.id;
  if (contactId === undefined) {
    const contact = await createContact(context, {
      firmId: firm.id,
      fullName: spec.contactName,
      isPrimary: true,
    });
    if (!contact.ok) throw new EvidenceRefusal('contact', `createContact refused with ${contact.reason}`);
    contactId = contact.value.id;
  }

  const routes = await listRoutes(context, 'email', firm.id);
  let route = routes.find(entry => entry['value'] === spec.address);
  if (route === undefined) {
    // `usable` is the one eligibility a fence may freeze and the mail matcher may treat
    // as a participant, and `decideRouteEligibility` wants three things for it: a
    // technical validation that `passed`, a trusted source, and an association
    // confidence that is a *number* — a trusted source with none is still `candidate`,
    // because "we did not measure" is not the same answer as "we measured and it is
    // certain". A salesperson typing the address of the person they are writing to is
    // the one case where it genuinely is.
    const added = await addEmailRoute(context, {
      firmId: firm.id,
      contactId,
      address: spec.address,
      source: 'salesperson',
      technicalValidation: 'passed',
      associationConfidence: 1,
    });
    if (!added.ok) throw new EvidenceRefusal('route', `addEmailRoute refused with ${added.reason}`);
    // `addRoute` returns the columns a phone route and an email one share, and the
    // address is not one of them — `listRoutes` is what aliases each kind's value
    // column. Re-read, so the address below is the row's own rather than the caller's
    // copy of what it asked for.
    const reread = await listRoutes(context, 'email', firm.id);
    route = reread.find(entry => entry.id === added.value.id);
    if (route === undefined) throw new EvidenceRefusal('route', 'the email route was not readable after it was added');
  }
  if (route.eligibility !== 'usable') {
    throw new EvidenceRefusal('route', `the email route is ${route.eligibility} rather than usable`);
  }

  let opportunity: OpportunityRow | null = null;
  if (spec.opportunity) {
    opportunity = await readOpenOpportunity(context, firm.id);
    if (opportunity === null) {
      const opened = await openOpportunity(context, { firmId: firm.id });
      if (!opened.ok) throw new EvidenceRefusal('opportunity', `openOpportunity refused with ${opened.reason}`);
      opportunity = opened.value;
    }
  }

  return { firm, contactId, routeId: route.id, routeAddress: routeAddress(route), opportunity, outcome };
}

interface Template {
  readonly id: string;
  readonly contentHash: string;
  readonly outcome: DrillEvidenceOutcome;
}

async function ensureTemplate(context: RepositoryContext): Promise<Template> {
  const versions = await listTemplateVersions(context);
  const existing = versions.find(version => version.name === TEMPLATE_NAME && version.approvedAt !== null);
  if (existing !== undefined) {
    return { id: existing.id, contentHash: existing.contentHash, outcome: 'existing' };
  }
  const created = await createTemplateVersion(context, {
    name: TEMPLATE_NAME,
    subject: TEMPLATE_SUBJECT,
    body: TEMPLATE_BODY,
    footer: { signOff: SIGN_OFF },
    requiredVariables: [],
  });
  if (!created.ok) throw new EvidenceRefusal('template', `createTemplateVersion refused with ${created.reason}`);
  const approved = await approveTemplateVersion(context, { templateVersionId: created.value.id });
  if (!approved.ok) {
    throw new EvidenceRefusal(
      'template',
      `approveTemplateVersion refused with ${approved.reason}: ${(approved.issues ?? []).join(', ')}`,
    );
  }
  return { id: approved.value.id, contentHash: approved.value.contentHash, outcome: 'created' };
}

interface Sequence {
  readonly versionId: string;
  readonly outcome: DrillEvidenceOutcome;
}

async function ensureSequence(
  context: RepositoryContext,
  templateVersionId: string,
  spec: { readonly name: string; readonly delayHours: number } = { name: SEQUENCE_NAME, delayHours: 0 },
): Promise<Sequence> {
  const sequences = await listSequences(context);
  const found = sequences.find(sequence => sequence.name === spec.name);
  if (found !== undefined) {
    const versions = await listSequenceVersions(context, found.id);
    const published = versions.find(version => version.state === 'published');
    if (published !== undefined) return { versionId: published.id, outcome: 'existing' };
  }
  let sequenceId = found?.id;
  if (sequenceId === undefined) {
    const created = await createSequence(context, { name: spec.name });
    if (!created.ok) throw new EvidenceRefusal('sequence', `createSequence refused with ${created.reason}`);
    sequenceId = created.value.id;
  }
  // One email step with no delay, so the first execution `enrollContact` writes is due
  // at the instant the enrollment starts. The seed dispatches its fence directly rather
  // than waiting for the scheduler, so nothing here depends on that; it is still the
  // honest shape for a one-step sequence.
  const draft = await createDraftVersion(context, {
    sequenceId,
    steps: [{ ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: spec.delayHours }, templateVersionId }],
  });
  if (!draft.ok) throw new EvidenceRefusal('sequence', `createDraftVersion refused with ${draft.reason}`);
  const published = await publishVersion(context, { sequenceVersionId: draft.value.sequenceVersionId });
  if (!published.ok) throw new EvidenceRefusal('sequence', `publishVersion refused with ${published.reason}`);
  return { versionId: published.value.id, outcome: 'created' };
}

async function ensureSendingDomain(
  context: RepositoryContext,
  adminUserId: string,
): Promise<DrillEvidenceOutcome> {
  let primary = await readPrimarySendingDomain(context);
  const outcome: DrillEvidenceOutcome = primary === null ? 'created' : 'existing';
  if (primary === null) {
    // Through `registerSendingDomain`, the creator lane g57 added: until it existed this
    // was the one row in this file written with SQL, because nothing in
    // `packages/domain/outbound` could create it. It leaves the three authentication
    // booleans at their defaults — false — so `sending_domains_passes_are_checked` and
    // `sending_domains_enable_requires_authentication` are satisfied by the two domain
    // calls below rather than by the registration.
    const registered = await registerSendingDomain(context, { domain: EVIDENCE_DOMAIN, registeredBy: 'operator' });
    if (!registered.ok) {
      throw new EvidenceRefusal('sending_domain', `registerSendingDomain refused with ${registered.reason}`);
    }
    primary = await readPrimarySendingDomain(context);
    if (primary === null) throw new EvidenceRefusal('sending_domain', 'the workspace has no primary sending domain');
  }
  const checklist = await recordAuthenticationChecklist(context, {
    domain: primary.domain,
    adminUserId,
    spfPass: true,
    dkimPass: true,
    dmarcPass: true,
    postmasterReviewed: true,
  });
  if (!checklist.ok) {
    throw new EvidenceRefusal('sending_domain', `recordAuthenticationChecklist refused with ${checklist.reason}`);
  }
  const enabled = await setAutomatedSendingEnabled(context, { domain: primary.domain, enabled: true });
  if (!enabled.ok) {
    throw new EvidenceRefusal('sending_domain', `setAutomatedSendingEnabled refused with ${enabled.reason}`);
  }
  return outcome;
}

async function ensureSendingAttestation(context: RepositoryContext): Promise<DrillEvidenceOutcome> {
  const current = await readSetting(context, 'sending_enabled');
  const value = current.value as { enabled?: unknown } | null;
  if (value !== null && typeof value === 'object' && value.enabled === true) return 'existing';
  const updated = await updateSetting(context, {
    settingKey: 'sending_enabled',
    value: { enabled: true, releaseGateReference: RELEASE_GATE_REFERENCE },
    changeNote: 'the drill evidence seed, so the rehearsal has an accepted send to reconstruct',
  });
  if (!updated.ok) throw new EvidenceRefusal('sending_attestation', `updateSetting refused with ${updated.reason}`);
  return 'created';
}

interface Mailbox {
  readonly row: MailboxRow;
  readonly outcome: DrillEvidenceOutcome;
}

/**
 * A connected mailbox whose coverage is proved by the recovery that proves it.
 *
 * `insertOrReviveMailbox` leaves `sync_state = 'baseline_pending'`, which the send gate
 * refuses with `coverage_incomplete` — correctly. So the baseline recovery is run here,
 * over an empty fixture, and it is that run which sets the state to `ready`, advances
 * the cursor and releases the hold. Nothing writes `sync_state` by hand.
 */
async function ensureMailbox(
  context: RepositoryContext,
  session: SessionQueryable,
  workspace: Workspace,
  mail: MailWorkerOptions,
  gmail: MailWorkerOptions['gmail'],
): Promise<Mailbox> {
  let row = await readMailboxForOwner(context, workspace.adminUserId);
  const outcome: DrillEvidenceOutcome = row === null ? 'created' : 'existing';
  if (row === null) {
    row = await insertOrReviveMailbox(context, {
      ownerUserId: workspace.adminUserId,
      emailAddress: MAILBOX_ADDRESS,
      providerAccountId: `${EXTERNAL_ID_PREFIX}-account`,
      baselineFromAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    });
  }
  // The refresh token is re-wrapped on **every** run, not only when the mailbox is
  // created. In a deployed rehearsal the envelope is the environment's KMS key on the
  // recorded seam (lane g59), which every task shares, so the drill can unwrap what
  // this stored; on a laptop with no key id the wrapper is `localDataKeyWrapper`, whose
  // master key is per process, and re-wrapping is what keeps a re-run of the seed able to
  // read its own mailbox. `storeRefreshToken` is an upsert — a re-consent replaces the
  // ciphertext — and the value is generated here and is never a credential:
  // `recordedGmailClient` does not read it.
  await storeRefreshToken(context, {
    mailboxId: row.id,
    plaintext: `${EXTERNAL_ID_PREFIX}-${randomUUID()}`,
    cipher: mail.cipher,
  });
  if (row.syncState !== 'ready') {
    const deps = {
      gmail,
      oauth: mail.oauth,
      cipher: mail.cipher,
      journal: mail.journal,
      replyPromoter: mail.replyPromoter,
    };
    const mailbox = row;
    await withTransaction(session, async () => await startRecovery(context, { mailbox, reason: 'baseline' }));
    const report = await withTransaction(
      session,
      async () => await runMailRecovery(context, deps, { mailboxId: mailbox.id, generation: mailbox.generation }),
    );
    if (report.outcome !== 'completed') {
      throw new EvidenceRefusal('mailbox', `the baseline recovery answered '${report.outcome}' rather than completing`);
    }
    const reread = await readMailboxForOwner(context, workspace.adminUserId);
    if (reread === null) throw new EvidenceRefusal('mailbox', 'the mailbox vanished during its baseline recovery');
    row = reread;
  }
  if (row.syncState !== 'ready') {
    throw new EvidenceRefusal('mailbox', `the mailbox is ${row.syncState} after its baseline recovery`);
  }
  return { row, outcome };
}

interface AcceptedSend {
  readonly outboundMessageId: string;
  readonly messageIdHeader: string;
  readonly outcome: DrillEvidenceOutcome;
}

interface SendMaterials {
  readonly gmail: MailWorkerOptions['gmail'];
  readonly oauth: MailWorkerOptions['oauth'];
  readonly cipher: MailWorkerOptions['cipher'];
}

/**
 * A prepared fence for the seeded firm's contact, through the one path that makes a
 * fence legal.
 *
 * The enrollment is what makes the fence legal: `outbound_messages_exactly_one_origin`
 * requires a step execution, and `enrollContact` is the only exported function that
 * writes one — it and the enrollment are a single statement so that neither can exist
 * without the other.
 */
/**
 * The seeded contact's first step execution, enrolling the contact when it has none.
 *
 * `enrollContact` is the only exported writer of a step execution, and it writes the
 * enrollment and the first step in one statement. Found again by contact on a re-run.
 */
async function ensureStepExecution(
  context: RepositoryContext,
  session: SessionQueryable,
  workspace: Workspace,
  seeded: SeededFirm,
  sequenceVersionId: string,
  step = 'send',
): Promise<{ readonly id: string; readonly outcome: DrillEvidenceOutcome }> {
  const opportunity = seeded.opportunity;
  if (opportunity === null) throw new EvidenceRefusal(step, 'the sending firm has no open opportunity');

  const { rows: executions } = await session.query<{ id: string }>(
    `SELECT e.id FROM step_executions AS e
       JOIN sequence_enrollments AS n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
      WHERE e.workspace_id = $1 AND e.contact_id = $2
      ORDER BY e.created_at, e.id
      LIMIT 1`,
    [workspace.id, seeded.contactId],
  );
  const found = executions[0]?.id;
  if (found !== undefined) return { id: found, outcome: 'existing' };
  const enrolled = await withTransaction(
    session,
    async () =>
      await enrollContact(context, {
        sequenceVersionId,
        opportunityId: opportunity.id,
        firmId: seeded.firm.id,
        contactId: seeded.contactId,
        assignedUserId: workspace.adminUserId,
      }),
  );
  if (!enrolled.ok) throw new EvidenceRefusal(step, `enrollContact refused with ${enrolled.reason}`);
  return { id: enrolled.value.firstExecutionId, outcome: 'created' };
}

async function prepareSeededFence(
  context: RepositoryContext,
  session: SessionQueryable,
  workspace: Workspace,
  seeded: SeededFirm,
  template: Template,
  sequenceVersionId: string,
  at: Date,
): Promise<string> {
  const opportunity = seeded.opportunity;
  if (opportunity === null) throw new EvidenceRefusal('send', 'the sending firm has no open opportunity');
  const stepExecutionId = (await ensureStepExecution(context, session, workspace, seeded, sequenceVersionId)).id;

  const prepared = await prepareOutboundMessage(context, {
    stepExecutionId,
    firmId: seeded.firm.id,
    contactId: seeded.contactId,
    opportunityId: opportunity.id,
    ownerUserId: workspace.adminUserId,
    templateVersionId: template.id,
    templateContentHash: template.contentHash,
    emailAddressId: seeded.routeId,
    toAddress: seeded.routeAddress,
    subject: TEMPLATE_SUBJECT,
    body: TEMPLATE_BODY,
    sendAt: at.toISOString(),
    sourceZone: 'UTC',
    businessDate: businessDateOf(at),
  });
  if (!prepared.ok) throw new EvidenceRefusal('send', `prepareOutboundMessage refused with ${prepared.reason}`);
  return prepared.value.outboundMessageId;
}

/** Dispatch one prepared fence through the real path, with the clock and switch the seed names. */
async function dispatchSeededFence(
  context: RepositoryContext,
  send: SendMaterials,
  outboundMessageId: string,
  at: Date,
): Promise<Awaited<ReturnType<typeof dispatchOutboundMessage>>> {
  return await dispatchOutboundMessage(
    context,
    {
      gmail: send.gmail,
      oauth: send.oauth,
      cipher: send.cipher,
      actor: 'fss-drill-evidence',
      // The window is re-derived from this clock (11.2), and 16.2's deployment half is
      // named here rather than read from `FSS_SENDING_ENABLED`: the recorded client
      // sends nowhere, and a seed that depended on the rehearsal's sending switch would
      // refuse for a reason that has nothing to do with the drill. The workspace half
      // is a real `updateSetting` above, and `live` is refused before any of this runs.
      now: () => at,
      deploymentSendingEnabled: true,
    },
    { outboundMessageId },
  );
}

/** One fence, driven through the real dispatch path until its state is `sent`. */
async function ensureAcceptedSend(
  context: RepositoryContext,
  session: SessionQueryable,
  workspace: Workspace,
  seeded: SeededFirm,
  template: Template,
  sequenceVersionId: string,
  send: SendMaterials,
  at: Date,
): Promise<AcceptedSend> {
  const { rows: already } = await session.query<{ id: string; provider_message_id_header: string }>(
    `SELECT id, provider_message_id_header FROM outbound_messages
      WHERE workspace_id = $1 AND contact_id = $2 AND state = 'sent'
      ORDER BY sent_at
      LIMIT 1`,
    [workspace.id, seeded.contactId],
  );
  const found = already[0];
  if (found !== undefined) {
    return {
      outboundMessageId: found.id,
      messageIdHeader: found.provider_message_id_header,
      outcome: 'existing',
    };
  }

  const outboundMessageId = await prepareSeededFence(context, session, workspace, seeded, template, sequenceVersionId, at);
  const report = await dispatchSeededFence(context, send, outboundMessageId, at);
  if (report.outcome !== 'sent') {
    throw new EvidenceRefusal(
      'send',
      `dispatchOutboundMessage answered '${report.outcome}'${report.refusal === undefined ? '' : ` (${report.refusal})`}`,
    );
  }
  const fence = await readFence(context, outboundMessageId);
  if (fence === null || fence.state !== 'sent') {
    throw new EvidenceRefusal('send', 'the fence did not reach the sent state');
  }
  return {
    outboundMessageId: fence.id,
    messageIdHeader: fence.providerMessageIdHeader,
    outcome: 'created',
  };
}

/**
 * One send left in doubt at the restore target (lane g59, Appendix E step 3).
 *
 * Appendix B's fifth scenario, through the real dispatch path: Gmail accepted the
 * message and the response never came back. The recorded client's
 * `indeterminate_but_delivered` does exactly that — the message goes into its Sent
 * folder, and `dispatchOutboundMessage` hears "indeterminate", so the fence enters
 * `reconciling` and opens its `send_unknown_reconciling` hold. Nothing here sets a
 * state. The restored copy then holds a fence in doubt whose Message-ID the Sent folder
 * proves delivered, which is the one thing step 3 reconciles and the one thing a send
 * that reached `sent` in one pass can never give it.
 *
 * It runs just before the restore target is read, because step 3 looks at fences
 * dispatched from the restore point minus ten minutes.
 */
async function ensureInDoubtSend(
  context: RepositoryContext,
  session: SessionQueryable,
  workspace: Workspace,
  seeded: SeededFirm,
  template: Template,
  sequenceVersionId: string,
  send: SendMaterials,
  at: Date,
): Promise<AcceptedSend> {
  const { rows: already } = await session.query<{ id: string; provider_message_id_header: string }>(
    `SELECT id, provider_message_id_header FROM outbound_messages
      WHERE workspace_id = $1 AND contact_id = $2 AND state IN ('dispatching', 'reconciling', 'sent')
      ORDER BY created_at
      LIMIT 1`,
    [workspace.id, seeded.contactId],
  );
  const found = already[0];
  if (found !== undefined) {
    return { outboundMessageId: found.id, messageIdHeader: found.provider_message_id_header, outcome: 'existing' };
  }

  const outboundMessageId = await prepareSeededFence(context, session, workspace, seeded, template, sequenceVersionId, at);
  const report = await dispatchSeededFence(context, send, outboundMessageId, at);
  if (report.outcome !== 'reconciling') {
    throw new EvidenceRefusal(
      'in_doubt_send',
      `dispatchOutboundMessage answered '${report.outcome}' where a delivered send with a dropped response enters reconciling`,
    );
  }
  const fence = await readFence(context, outboundMessageId);
  if (fence === null || fence.state !== 'reconciling') {
    throw new EvidenceRefusal('in_doubt_send', 'the fence did not enter the reconciling state');
  }
  return { outboundMessageId: fence.id, messageIdHeader: fence.providerMessageIdHeader, outcome: 'created' };
}

/**
 * A usable phone route on the sending firm, through `addPhoneRoute` (lane g59).
 *
 * Half of what the drill's step 1 dial probe needs; `ensureCallingIdentity` below is
 * the other half.
 */
async function ensureDialRoute(context: RepositoryContext, seeded: SeededFirm): Promise<{ id: string; outcome: DrillEvidenceOutcome }> {
  const routes = await listRoutes(context, 'phone', seeded.firm.id);
  const existing = routes.find(route => route['value'] === DIAL_ROUTE_E164);
  if (existing !== undefined) return { id: existing.id, outcome: 'existing' };
  const added = await addPhoneRoute(context, {
    firmId: seeded.firm.id,
    contactId: seeded.contactId,
    e164: DIAL_ROUTE_E164,
    source: 'salesperson',
    technicalValidation: 'passed',
    associationConfidence: 1,
  });
  if (!added.ok) throw new EvidenceRefusal('dial_route', `addPhoneRoute refused with ${added.reason}`);
  if (added.value.eligibility !== 'usable') {
    throw new EvidenceRefusal('dial_route', `the phone route is ${added.value.eligibility} rather than usable`);
  }
  return { id: added.value.id, outcome: 'created' };
}

/**
 * The rehearsal admin's attested calling number, through the path a salesperson takes
 * (lane g60): `registerCallingIdentity`, then `verifyCallingIdentity` in the owner's own
 * scope, so it is recorded as an `owner_attestation` by the admin, with the instant.
 *
 * It is the attestation a person makes in the desktop's "Your calling number" section,
 * made here by the seed on the rehearsal admin's behalf — which is what every other row
 * this seed writes is, too: the fictional admin's activity, through the functions that
 * own each invariant. It is not an `INSERT` of a verified row, which migration 0016's
 * `calling_identities_verification_recorded` would refuse anyway. Both calls are
 * idempotent, so a re-run reports `existing`.
 */
async function ensureCallingIdentity(
  context: RepositoryContext,
  session: SessionQueryable,
): Promise<{ id: string; outcome: DrillEvidenceOutcome }> {
  const registered = await withTransaction(
    session,
    async () => await registerCallingIdentity(context, { e164: DRILL_CALLING_NUMBER, label: 'Drill evidence' }),
  );
  if (!registered.ok) {
    throw new EvidenceRefusal('calling_identity', `registerCallingIdentity refused with ${registered.reason}`);
  }
  const attested = await withTransaction(
    session,
    async () => await verifyCallingIdentity(context, { identityId: registered.value.identity.id }),
  );
  if (!attested.ok) {
    throw new EvidenceRefusal('calling_identity', `verifyCallingIdentity refused with ${attested.reason}`);
  }
  const identity = attested.value.identity;
  if (!identity.enabled || identity.verificationStatus !== 'verified') {
    throw new EvidenceRefusal('calling_identity', 'the attested calling identity is not verified and enabled');
  }
  const created = registered.value.outcome === 'created' || attested.value.outcome === 'verified';
  return { id: identity.id, outcome: created ? 'created' : 'existing' };
}

/**
 * An administrative pause on the opt-out firm's opportunity, through `openPause`
 * (lane g59).
 *
 * Appendix E step 9 has to show that advancing the generation releases the restore
 * holds and *nothing else* (4.3), and a drill with no other hold in force cannot show
 * it: the step refuses `selectivity_untestable`. restore-drill.md names an
 * administrative pause among the holds that must still be in force afterwards. It is
 * made long before the target, nothing in steps 2 to 8 touches it, and it is not an
 * unresolved exception, so the step 8 report does not refuse step 9 on its account.
 */
async function ensureAdministrativePause(
  context: RepositoryContext,
  session: SessionQueryable,
  workspace: Workspace,
  seeded: SeededFirm,
): Promise<{ id: string; outcome: DrillEvidenceOutcome }> {
  const opportunity = seeded.opportunity;
  if (opportunity === null) throw new EvidenceRefusal('administrative_pause', 'the paused firm has no open opportunity');
  const { rows } = await session.query<{ id: string }>(
    `SELECT id FROM administrative_pauses
      WHERE workspace_id = $1 AND scope_kind = 'opportunity' AND scope_key = $2 AND released_at IS NULL
      ORDER BY created_at LIMIT 1`,
    [workspace.id, opportunity.id],
  );
  const existing = rows[0];
  if (existing !== undefined) return { id: existing.id, outcome: 'existing' };
  const opened = await withTransaction(
    session,
    async () =>
      await openPause(context, {
        scopeKind: 'opportunity',
        scopeKey: opportunity.id,
        reasonNote: 'the drill evidence seed: a hold step 9 must leave in force',
        commandId: `${EXTERNAL_ID_PREFIX}:administrative-pause`,
      }),
  );
  if (!opened.ok) throw new EvidenceRefusal('administrative_pause', `openPause refused with ${opened.reason}`);
  return { id: opened.value.id, outcome: 'created' };
}

/** One inbound message, in the shape the recorded client answers metadata and body from. */
function inboundMessage(input: {
  readonly id: string;
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string | undefined;
  readonly at: Date;
  readonly historyId: string;
}): GmailFixtureMessage {
  const headers: Record<string, string> = {
    From: input.from,
    To: MAILBOX_ADDRESS,
    Subject: input.subject,
    Date: input.at.toUTCString(),
    'Message-ID': `<${input.id}@${EVIDENCE_DOMAIN}>`,
  };
  if (input.inReplyTo !== undefined) {
    headers['In-Reply-To'] = input.inReplyTo;
    headers['References'] = input.inReplyTo;
  }
  return {
    id: input.id,
    threadId: `thread-${input.id}`,
    internalDateEpochMilliseconds: input.at.getTime(),
    labelIds: ['INBOX'],
    headers,
    body: input.body,
    historyId: input.historyId,
  };
}

interface IngestedMessage {
  readonly mailMessageId: string;
  readonly outcome: DrillEvidenceOutcome;
}

interface IngestedRow {
  readonly id: string;
  readonly internalDate: Date;
}

async function readIngested(
  session: SessionQueryable,
  workspaceId: string,
  providerMessageId: string,
): Promise<IngestedRow | null> {
  const { rows } = await session.query<{ id: string; internal_date: Date }>(
    'SELECT id, internal_date FROM mail_messages WHERE workspace_id = $1 AND provider_message_id = $2',
    [workspaceId, providerMessageId],
  );
  const row = rows[0];
  return row === undefined ? null : { id: row.id, internalDate: row.internal_date };
}

/**
 * One inbound message the seed owns: pushed onto the recorded mailbox and marked for
 * ingestion when it is new, or rebuilt at the instant it was ingested when a re-run
 * finds it, so the phase's recording is the same either way.
 */
async function deliverInbound(
  session: SessionQueryable,
  workspaceId: string,
  mailbox: { readonly messages: GmailFixtureMessage[]; readonly pending: string[]; readonly recorded: GmailFixtureMessage[] },
  spec: Omit<Parameters<typeof inboundMessage>[0], 'at'> & { readonly at: Date },
): Promise<IngestedRow | null> {
  const existing = await readIngested(session, workspaceId, spec.id);
  const message = inboundMessage({ ...spec, at: existing?.internalDate ?? spec.at });
  mailbox.recorded.push(message);
  if (existing === null) {
    mailbox.messages.push(message);
    mailbox.pending.push(spec.id);
  }
  return existing;
}

/**
 * The Sent folder's messages for the Message-IDs a phase vouches for (lane g73), built
 * from their fences: the Gmail ids the recorded client gives a message with that id, the
 * recipient and subject the fence froze, and the instant it left — `sent_at`, or the
 * dispatch instant of a send left in doubt. From the fences rather than from the
 * client, so a re-run that sent nothing records exactly what the first run did.
 */
async function sentFolderOf(
  session: SessionQueryable,
  workspaceId: string,
  headers: readonly string[],
): Promise<readonly GmailFixtureMessage[]> {
  if (headers.length === 0) return [];
  const { rows } = await session.query<{
    provider_message_id_header: string;
    recipient_address: string;
    subject: string;
    at: Date;
  }>(
    `SELECT provider_message_id_header, recipient_address, subject, coalesce(sent_at, dispatch_started_at) AS at
       FROM outbound_messages
      WHERE workspace_id = $1 AND provider_message_id_header = ANY($2::text[])
        AND coalesce(sent_at, dispatch_started_at) IS NOT NULL
      ORDER BY provider_message_id_header`,
    [workspaceId, [...headers]],
  );
  return rows.map(row => ({
    id: recordedSentMessageId(row.provider_message_id_header),
    threadId: recordedSentThreadId(row.provider_message_id_header),
    internalDateEpochMilliseconds: row.at.getTime(),
    labelIds: ['SENT'],
    headers: {
      'Message-ID': row.provider_message_id_header,
      To: row.recipient_address,
      Subject: row.subject,
    },
    historyId: '1',
  }));
}

/** The recording a phase reports: the Sent folder it can vouch for and the messages it delivered. */
function recordingOf(
  sent: Iterable<string>,
  messages: readonly GmailFixtureMessage[],
  sentMessages: readonly GmailFixtureMessage[],
): MailboxRecording {
  const sentMessageIds = [...new Set(sent)].sort();
  // The mailbox's current id is the latest of its messages', compared as Gmail's uint64
  // ids and never through `Number` (lane g76).
  const historyId = messages.reduce((latest, message) => laterHistoryId(latest, message.historyId), '1');
  return {
    emailAddress: MAILBOX_ADDRESS,
    historyId,
    sentMessageIds,
    messages: [...messages],
    sentMessages: [...sentMessages],
  };
}

export async function seedDrillEvidence(input: DrillEvidenceInput): Promise<DrillEvidenceResult> {
  const { session, mail, phase } = input;
  if (!DRILL_EVIDENCE_PHASES.includes(phase)) {
    return {
      ok: false,
      reason: 'phase_unknown',
      detail: `--phase takes ${DRILL_EVIDENCE_PHASES.join(', ')}, not '${String(phase)}'`,
    };
  }

  const items: DrillEvidenceItem[] = [];
  const note = (step: string, outcome: DrillEvidenceOutcome, id: string): void => {
    items.push({ step, outcome, id });
  };

  try {
    const workspace = await readWorkspace(session, input.workspaceSlug);
    // Two scopes, and the difference is the point. The admin's own scope is what the
    // admin-only commands require (`isAdminScope` refuses a system actor) and what
    // `confirmReplyDisposition` needs a `confirmed_by_user_id` from. The worker's scope
    // is what ingests mail, because that is who ingests mail in production: a prospect's
    // opt-out recorded with a user id would be attributed to a person who did not ask
    // for it.
    const admin = repositoryContext(
      workspaceScope(workspace.id, { kind: 'user', userId: workspace.adminUserId, role: 'admin' }),
      session,
    );
    const worker = repositoryContext(
      workspaceScope(workspace.id, { kind: 'system', component: 'worker' }),
      session,
    );

    // The fixture this seed owns, with a mutable message list: `recordedGmailClient`
    // re-reads it on every call, so the reply and the opt-out become visible only once
    // the send that they answer has happened.
    const messages: GmailFixtureMessage[] = [];
    const gmail = recordedGmailClient({
      emailAddress: MAILBOX_ADDRESS,
      historyId: '1',
      messages,
      refreshToken: `${EXTERNAL_ID_PREFIX}-fixture`,
    });
    // What this phase's recording will say the mailbox holds (lane g59).
    const inbox = { messages, pending: [] as string[], recorded: [] as GmailFixtureMessage[] };
    const vouchedSent: string[] = [];

    const at = windowInstant(new Date());

    const template = await ensureTemplate(admin);
    note('template', template.outcome, template.id);
    const sequence = await ensureSequence(admin, template.id);
    note('sequence', sequence.outcome, sequence.versionId);
    note('sending_domain', await ensureSendingDomain(admin, workspace.adminUserId), EVIDENCE_DOMAIN);
    note('sending_attestation', await ensureSendingAttestation(admin), 'sending_enabled');
    const mailbox = await ensureMailbox(worker, session, workspace, mail, gmail);
    note('mailbox', mailbox.outcome, mailbox.row.id);

    const pipeline = {
      gmail,
      oauth: mail.oauth,
      cipher: mail.cipher,
      journal: mail.journal,
      replyPromoter: mail.replyPromoter,
    };
    const ingestPending = async (step: string): Promise<void> => {
      if (inbox.pending.length === 0) return;
      const access = await accessForMailbox(worker, pipeline, mailbox.row.id);
      if (!access.ok) throw new EvidenceRefusal(step, `the mailbox grant answered '${access.reason}'`);
      const messageIds = inbox.pending.splice(0);
      await withTransaction(
        session,
        async () =>
          await processMessageIds(worker, pipeline, {
            mailbox: mailbox.row,
            access: access.access,
            messageIds,
          }),
      );
    };

    if (phase === 'in-flight') {
      // ---- the send left in doubt at the restore target (lane g59) ----------
      //
      // Its own client, because the difference is the client's behaviour: this one
      // delivers and drops the response. Same mailbox, same grant, same address.
      const inFlight = await ensureFirm(admin, workspace, FIRMS.inFlight);
      note('in_flight_firm', inFlight.outcome, inFlight.firm.id);
      const dropping = recordedGmailClient({
        emailAddress: MAILBOX_ADDRESS,
        historyId: '1',
        messages,
        refreshToken: `${EXTERNAL_ID_PREFIX}-fixture`,
        sendBehaviour: 'indeterminate_but_delivered',
      });
      const doubt = await ensureInDoubtSend(
        worker,
        session,
        workspace,
        inFlight,
        template,
        sequence.versionId,
        { gmail: dropping, oauth: mail.oauth, cipher: mail.cipher },
        at,
      );
      note('in_doubt_send', doubt.outcome, doubt.outboundMessageId);
      // Delivered by definition of this phase: on the first run the client's own Sent
      // folder says so, and on a re-run the fence it made is the same message.
      vouchedSent.push(...dropping.sentMessageIds, doubt.messageIdHeader);
    } else {
      const spec = phase === 'before' ? FIRMS.send : FIRMS.after;
      const sending = await ensureFirm(admin, workspace, spec);
      note('firm', sending.outcome, sending.firm.id);
      note('contact', sending.outcome, sending.contactId);

      const send = await ensureAcceptedSend(
        worker,
        session,
        workspace,
        sending,
        template,
        sequence.versionId,
        { gmail, oauth: mail.oauth, cipher: mail.cipher },
        at,
      );
      note('accepted_send', send.outcome, send.outboundMessageId);
      vouchedSent.push(...gmail.sentMessageIds, send.messageIdHeader);

      if (phase === 'before') {
        // ---- the prospect reply, and the opt-out ------------------------------
        //
        // Both go through `processMessageIds`, which is the same function `runMailSync`
        // and `runMailRecovery` call: metadata, matching, body, deterministic
        // classification, effects. Nothing here decides what a message means.
        const optOut = await ensureFirm(admin, workspace, FIRMS.optOut);
        note('opt_out_firm', optOut.outcome, optOut.firm.id);

        const replyExisting = await deliverInbound(session, workspace.id, inbox, {
          id: REPLY_MESSAGE_ID,
          from: sending.routeAddress,
          subject: `Re: ${TEMPLATE_SUBJECT}`,
          body: REPLY_BODY,
          inReplyTo: send.messageIdHeader,
          at,
          historyId: '10',
        });
        const optOutExisting = await deliverInbound(session, workspace.id, inbox, {
          id: OPT_OUT_MESSAGE_ID,
          from: optOut.routeAddress,
          subject: 'Re: hello',
          body: OPT_OUT_BODY,
          at,
          historyId: '11',
        });
        await ingestPending('reply');

        const reply: IngestedMessage = {
          mailMessageId: replyExisting?.id ?? (await readIngested(session, workspace.id, REPLY_MESSAGE_ID))?.id ?? '',
          outcome: replyExisting === null ? 'created' : 'existing',
        };
        if (reply.mailMessageId === '') throw new EvidenceRefusal('reply', 'the reply was not recorded by the pipeline');
        note('prospect_reply', reply.outcome, reply.mailMessageId);

        const optOutMessage: IngestedMessage = {
          mailMessageId:
            optOutExisting?.id ?? (await readIngested(session, workspace.id, OPT_OUT_MESSAGE_ID))?.id ?? '',
          outcome: optOutExisting === null ? 'created' : 'existing',
        };
        if (optOutMessage.mailMessageId === '') {
          throw new EvidenceRefusal('opt_out', 'the opt-out was not recorded by the pipeline');
        }
        if (!(await isSuppressed(worker, { scope: 'handle', canonicalKey: optOut.routeAddress }))) {
          throw new EvidenceRefusal('opt_out', 'the opt-out was ingested and journalled no suppression');
        }
        note('prospect_opt_out', optOutMessage.outcome, optOutMessage.mailMessageId);

        // ---- the reply that sets the opportunity manual -----------------------
        //
        // 0.1 asks for "a reply that set an opportunity manual", and an ingested reply on
        // its own does not: 12.4 is explicit that only deterministic proof or a person's
        // confirmation may. `confirmReplyDisposition` is that person's act, it is the only
        // exported path to it, and it needs the admin's scope because
        // `mail_reply_confirmations.confirmed_by_user_id` references a membership.
        if (reply.outcome === 'created') {
          const confirmed = await withTransaction(
            session,
            async () =>
              await confirmReplyDisposition(admin, {
                messageId: reply.mailMessageId,
                disposition: 'interested',
                journal: mail.journal,
              }),
          );
          if (!confirmed.ok) {
            throw new EvidenceRefusal('reply_manual', `confirmReplyDisposition refused with ${confirmed.reason}`);
          }
        }
        note('opportunity_manual', reply.outcome, sending.opportunity?.id ?? '');

        // ---- the salesperson's own manual suppression -------------------------
        //
        // `salesperson_manual` is the one source with a correction window, and the window
        // is what 0.1 asks for: the event is effective from commit and correctable for ten
        // minutes, so a drill run minutes later reconstructs an event that is still open.
        const manual = await ensureFirm(admin, workspace, FIRMS.manual);
        note('manual_suppression_firm', manual.outcome, manual.firm.id);
        const suppressedAlready = await isSuppressed(admin, { scope: 'handle', canonicalKey: manual.routeAddress });
        if (suppressedAlready === null) {
          const recorded = await withTransaction(
            session,
            async () =>
              await recordSuppression(admin, {
                scope: 'handle',
                value: manual.routeAddress,
                firmId: manual.firm.id,
                source: 'salesperson_manual',
                commandId: `${EXTERNAL_ID_PREFIX}:manual-suppression`,
                journal: mail.journal,
              }),
          );
          if (!recorded.ok) {
            throw new EvidenceRefusal('manual_suppression', `recordSuppression refused with ${recorded.reason}`);
          }
          // The window is the whole point of this kind of evidence, so its absence is a
          // refusal rather than a seed that reported success: a suppression with no
          // deadline is a terminal one, which is what a *prospect's* request is, and the
          // drill would then be reconstructing the same kind twice.
          if (recorded.value.correctionDeadline === null) {
            throw new EvidenceRefusal(
              'manual_suppression',
              'a salesperson manual suppression carried no correction window',
            );
          }
          note('manual_suppression', 'created', recorded.value.eventId);
        } else {
          // A replay of the same deterministic event id reports `correctionDeadline: null`
          // because it recorded nothing — the window belongs to the event, not to this
          // call — so the re-run reads the event that is already there rather than asking
          // for one it will not get.
          note('manual_suppression', 'existing', suppressedAlready.eventId);
        }

        // ---- what the later steps of the drill need in the restored copy (g59) --
        //
        // The prospect whose opt-out arrives after the target: known before it, so the
        // restored database can match the opt-out step 4 recovers.
        const lateOptOut = await ensureFirm(admin, workspace, FIRMS.lateOptOut);
        note('late_opt_out_firm', lateOptOut.outcome, lateOptOut.firm.id);
        // The step 1 dial probe's subject: a usable phone route on a firm assigned to
        // the admin, and the admin's own attested calling number (lane g60).
        const dialRoute = await ensureDialRoute(admin, sending);
        note('dial_route', dialRoute.outcome, dialRoute.id);
        const callingIdentity = await ensureCallingIdentity(admin, session);
        note('calling_identity', callingIdentity.outcome, callingIdentity.id);
        // A hold step 9 has to leave in force (4.3).
        const pause = await ensureAdministrativePause(admin, session, workspace, optOut);
        note('administrative_pause', pause.outcome, pause.id);
        // Lane g73: the enrollment whose step the `after` phase sends. Its step is
        // pending in the restored copy and its fence is not, which is the case
        // Appendix E.3's missing-fence recovery exists for.
        const restoreLost = await ensureFirm(admin, workspace, FIRMS.restoreLost);
        note('restore_lost_firm', restoreLost.outcome, restoreLost.firm.id);
        const lostSequence = await ensureSequence(admin, template.id, LOST_SEND_SEQUENCE);
        note('restore_lost_sequence', lostSequence.outcome, lostSequence.versionId);
        const lostStep = await ensureStepExecution(
          worker,
          session,
          workspace,
          restoreLost,
          lostSequence.versionId,
          'restore_lost_enrollment',
        );
        note('restore_lost_enrollment', lostStep.outcome, lostStep.id);
      } else {
        // ---- the send whose fence the restore loses and whose step it keeps (g73) --
        //
        // The step the `before` phase enrolled, prepared and dispatched now through the
        // real path and the recorded client, so its message is in the Sent folder and its
        // fence only in the source. The restored copy holds the step pending with no
        // fence: step 3 must find the message, tombstone the step, and step 5 must not
        // send it again.
        const restoreLost = await ensureFirm(admin, workspace, FIRMS.restoreLost);
        const lostSequence = await ensureSequence(admin, template.id, LOST_SEND_SEQUENCE);
        const lostSend = await ensureAcceptedSend(
          worker,
          session,
          workspace,
          restoreLost,
          template,
          lostSequence.versionId,
          { gmail, oauth: mail.oauth, cipher: mail.cipher },
          at,
        );
        note('restore_lost_send', lostSend.outcome, lostSend.outboundMessageId);
        vouchedSent.push(lostSend.messageIdHeader);

        // ---- the prospect opt-out the restore loses (lane g59) ----------------
        //
        // After the restore has been requested, so the restored copy never sees it. It
        // goes through the same pipeline as the one above, so its two suppressions are
        // journalled before their rows, and that journal is what step 2 replays; the
        // message itself is what step 4's recovery finds in the inbox. It arrives now,
        // not at the send clock's nine in the morning: step 4 recovers from the restore
        // point minus ten minutes, and a message dated hours earlier would be outside it.
        const lateOptOut = await ensureFirm(admin, workspace, FIRMS.lateOptOut);
        note('late_opt_out_firm', lateOptOut.outcome, lateOptOut.firm.id);
        const lateExisting = await deliverInbound(session, workspace.id, inbox, {
          id: LATE_OPT_OUT_MESSAGE_ID,
          from: lateOptOut.routeAddress,
          subject: 'Re: hello',
          body: OPT_OUT_BODY,
          at: new Date(),
          historyId: '12',
        });
        await ingestPending('late_opt_out');
        const lateMessage = lateExisting?.id ?? (await readIngested(session, workspace.id, LATE_OPT_OUT_MESSAGE_ID))?.id;
        if (lateMessage === undefined) {
          throw new EvidenceRefusal('late_opt_out', 'the opt-out was not recorded by the pipeline');
        }
        if (!(await isSuppressed(worker, { scope: 'handle', canonicalKey: lateOptOut.routeAddress }))) {
          throw new EvidenceRefusal('late_opt_out', 'the opt-out was ingested and journalled no suppression');
        }
        note('late_opt_out', lateExisting === null ? 'created' : 'existing', lateMessage);
      }

      // ---- the ordinary CRM edit -------------------------------------------
      const editPhase = phase === 'before' ? 'before' : 'after';
      const editTarget = phase === 'before' ? sending : await ensureFirm(admin, workspace, FIRMS.send);
      const wanted = CRM_EDIT_NAMES[editPhase];
      if (editTarget.firm.name === wanted) {
        note('crm_edit', 'existing', editTarget.firm.id);
      } else {
        const edited = await updateFirm(admin, { firmId: editTarget.firm.id, patch: { name: wanted } });
        if (!edited.ok) throw new EvidenceRefusal('crm_edit', `updateFirm refused with ${edited.reason}`);
        note('crm_edit', 'created', edited.value.id);
      }
    }

    // The same counting code `fss admin counts` calls, so the numbers a seed reports
    // and the numbers the drill's baseline refusal reads cannot drift apart.
    const counts = await readRestoreCounts(session);
    return {
      ok: true,
      value: {
        workspaceId: workspace.id,
        workspaceSlug: workspace.slug,
        phase,
        adminUserId: workspace.adminUserId,
        mailbox: recordingOf(
          vouchedSent,
          inbox.recorded,
          await sentFolderOf(session, workspace.id, [...new Set(vouchedSent)]),
        ),
        items,
        asOf: counts.asOf,
        sends: counts.sends,
        replies: counts.replies,
        suppressions: counts.suppressions,
        crm_edits: counts.crm_edits,
        migrations: counts.migrations,
      },
    };
  } catch (error) {
    if (error instanceof EvidenceRefusal) {
      const reason: DrillEvidenceRefusal = error.step === 'workspace' ? 'workspace_unknown' : 'step_unproducible';
      return { ok: false, reason, detail: `${error.step}: ${error.detail}` };
    }
    throw error;
  }
}
