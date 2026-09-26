import { createHash } from 'node:crypto';
import type { GmailFixture, RecordedGmailClient } from '../../../mail/gmailClientFake.ts';
import { prepareOutboundMessage, type OutboundEmailRequest } from '../../../outbound/fence.ts';
import type { ReconcileDeps } from '../../../outbound/reconcile.ts';
import type { OutboundSendDeps } from '../../../outbound/send.ts';
import { createMailWorld, type MailWorld, type MailWorldMailbox } from '../../mail/support/mailWorld.ts';
import { makeStepExecution } from '../../../db/testing/stepExecutions.ts';
import { FIXTURE_WORKER_DIGEST, storeFixtureRecord } from '../../release/support/releaseRecords.ts';

/**
 * A world with mailboxes that can actually send.
 *
 * Built on `createMailWorld`, so both workspaces already have a connected mailbox
 * whose grant went through the real OAuth path and whose Gmail is a recorded fixture.
 * What this adds is the four things the outbound lane needs and the mail lane did not
 * have: a proven-coverage mailbox, an authenticated sending domain, an approved
 * template version, and a firm whose zone is known so the send window has an answer.
 *
 * The clock is injected, and that is not a convenience. `decideSend` re-derives the
 * sending window from the current instant in the firm's zone, so a suite that used
 * the wall clock would pass on a Wednesday morning and skip itself on a Sunday — and
 * a suite that silently skips its own subject is worse than no suite. `OPEN_INSTANT`
 * is a Wednesday at 09:00 UTC and `CLOSED_INSTANT` is the small hours of the same
 * day; the fences use `UTC` as the firm's zone so the arithmetic has one step.
 *
 * No real person, address, business name or credential appears here.
 */

/** Wednesday 23 September 2026, 09:00 UTC. Inside 11.2's Monday-to-Friday window. */
export const OPEN_INSTANT = '2026-09-23T09:00:00.000Z';
/** The same Wednesday at 03:00 UTC. Before the window opens. */
export const CLOSED_INSTANT = '2026-09-23T03:00:00.000Z';
export const FIXTURE_ZONE = 'UTC';
export const FIXTURE_BUSINESS_DATE = '2026-09-23';

export const SENDING_DOMAIN = 'example.test';
/** The rehearsal run this fixture world attests to. A label, never a credential. */
export const RELEASE_GATE_REFERENCE = 'rehearsal-fixture-world';
export const TEMPLATE_SUBJECT = 'A short note about your properties';
export const TEMPLATE_BODY =
  'Hello.\n\nI work with property managers nearby.\n\nSigned off\n' +
  'Reply "stop" and I will not email you again.';

export interface OutboundWorldMailbox extends MailWorldMailbox {
  readonly templateVersionId: string;
  readonly templateContentHash: string;
  readonly routeId: string;
  readonly recipientAddress: string;
}

export interface OutboundWorld extends Omit<MailWorld, 'alpha' | 'beta'> {
  readonly alpha: OutboundWorldMailbox;
  readonly beta: OutboundWorldMailbox;
  /** Deps for the dispatch path, over one mailbox's Gmail fixture. */
  sendDeps(mailbox: OutboundWorldMailbox, overrides?: Partial<OutboundSendDeps>): OutboundSendDeps;
  reconcileDeps(mailbox: OutboundWorldMailbox, overrides?: Partial<ReconcileDeps>): ReconcileDeps;
  /** A Gmail client over the fixture with one field changed, for one behaviour. */
  clientWith(mailbox: MailWorldMailbox, overrides: Partial<GmailFixture>): RecordedGmailClient;
  /** Prepare one fence, with everything defaulted to something lawful. */
  prepare(
    mailbox: OutboundWorldMailbox,
    overrides?: Partial<OutboundEmailRequest>,
  ): Promise<string>;
  /**
   * Release every open hold in a workspace.
   *
   * A fence in doubt holds its firm, which is the product behaving correctly and is
   * asserted where it belongs. It also means a scenario about the *window* would be
   * refused for a hold the previous scenario opened, so a test about one rule clears
   * the others first and says so.
   */
  clearHolds(workspaceId: string): Promise<void>;
  stop(): Promise<void>;
}

function templateHash(templateId: string, version: number, subject: string, body: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'template_content',
        version: 1,
        templateId,
        templateVersion: version,
        subject,
        body,
      }),
      'utf8',
    )
    .digest('hex');
}

export async function createOutboundWorld(): Promise<OutboundWorld> {
  const world = await createMailWorld();

  // The release record the world's attestation names. A deployment fact
  // rather than a workspace one, so it is stored once, and its worker digest is the one
  // `sendDeps` says this worker is running. Without it every send would hold with
  // `workspace_sending_not_attested` for a reason no cap, window or suppression
  // scenario is about.
  await storeFixtureRecord(world.database.session, RELEASE_GATE_REFERENCE);

  const prepareMailbox = async (mailbox: MailWorldMailbox): Promise<OutboundWorldMailbox> => {
    const context = mailbox.context;
    const workspaceId = mailbox.workspace.workspaceId;

    // 12.3's coverage, proven. `createMailWorld` leaves a mailbox baseline_pending,
    // which is correct for a fresh grant and is exactly what the gate refuses.
    await context.db.query(
      `UPDATE mailboxes
          SET sync_state = 'ready',
              baseline_from_at = now() - interval '30 days',
              baseline_completed_at = now() - interval '1 hour',
              -- A watermark may not exist without a cursor: claiming coverage with
              -- nothing to have read it from is the state 0009 makes unrepresentable.
              history_id = coalesce(history_id, '1000'),
              history_id_updated_at = coalesce(history_id_updated_at, now()),
              coverage_watermark_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, mailbox.mailboxId],
    );

    // `completeGmailGrant` opens a `coverage_incomplete` hold on the owner and the
    // baseline is what releases it. These mailboxes have their coverage set above, so
    // the hold comes off here too — leaving it would make every send in this world
    // refuse for a reason the world itself invented.
    await context.db.query(
      `UPDATE active_holds SET released_at = now()
        WHERE workspace_id = $1 AND reason_code = 'coverage_incomplete' AND released_at IS NULL`,
      [workspaceId],
    );

    // An established mailbox: forty healthy sending days, so 12.7's schedule gives it
    // fifty a day. A brand-new mailbox is capped at five, which is correct and is
    // asserted in the cap scenario — but it would otherwise make the *fifth* send of
    // an unrelated scenario fail for a reason that scenario is not about.
    await context.db.query(
      `INSERT INTO mailbox_send_ramp (workspace_id, mailbox_id, healthy_sending_days, last_advanced_on)
       VALUES ($1, $2, 40, current_date - 1)
       ON CONFLICT (workspace_id, mailbox_id) DO UPDATE SET healthy_sending_days = 40`,
      [workspaceId, mailbox.mailboxId],
    );

    await context.db.query(
      `INSERT INTO sending_domains (workspace_id, domain, is_primary, spf_pass, dkim_pass, dmarc_pass,
                                    authentication_checked_at, authentication_checked_by_user_id,
                                    postmaster_reviewed_at, automated_sending_enabled,
                                    automated_sending_enabled_at)
       VALUES ($1, $2, true, true, true, true, now(), $3, now(), true, now())
       ON CONFLICT (workspace_id, domain) DO NOTHING`,
      [workspaceId, SENDING_DOMAIN, mailbox.workspace.admin.userId],
    );

    // 16.2's second switch, which G12 wired into the send gate: the admin attestation
    // naming the rehearsal gate whose digests match the deployment. A world without it
    // could not send at all, and every scenario here that is about a cap, a window or a
    // suppression would refuse for a reason it is not about. `sendDeps` supplies the
    // deployment half for the same reason.
    //
    // This *is* the vacuous-pass trap for the outbound suite and it is deliberate:
    // removing these two lines makes the suite fail. See
    // `packages/domain/test/outbound/attestation.test.ts`, which sets both halves
    // itself rather than relying on this.
    await context.db.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
       VALUES ($1, 'sending_enabled', 1, $2::jsonb, 'fixture: the rehearsal gate this world stands for', $3)
       ON CONFLICT (workspace_id, setting_key, version) DO NOTHING`,
      [
        workspaceId,
        JSON.stringify({ enabled: true, releaseGateReference: RELEASE_GATE_REFERENCE }),
        mailbox.workspace.admin.userId,
      ],
    );

    const templateId = '22222222-3333-4444-8555-666666666666';
    const contentHash = templateHash(templateId, 1, TEMPLATE_SUBJECT, TEMPLATE_BODY);
    const template = await context.db.query<{ id: string }>(
      `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                      content_hash, footer_sign_off,
                                      approved_at, approved_by_user_id)
       VALUES ($1, $2, 1, 'Opening note', $3, $4, $5, 'Signed off', now(), $6)
       RETURNING id`,
      [workspaceId, templateId, TEMPLATE_SUBJECT, TEMPLATE_BODY, contentHash, mailbox.workspace.admin.userId],
    );

    const firm = mailbox.workspace.slug === 'alpha' ? world.crm.alpha : world.crm.beta;
    const route = await context.db.query<{ id: string; address: string }>(
      'SELECT id, address FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2 LIMIT 1',
      [workspaceId, firm.firmId],
    );

    return {
      ...mailbox,
      templateVersionId: template.rows[0]?.id ?? '',
      templateContentHash: contentHash,
      routeId: route.rows[0]?.id ?? '',
      recipientAddress: route.rows[0]?.address ?? '',
    };
  };

  const alpha = await prepareMailbox(world.alpha);
  const beta = await prepareMailbox(world.beta);

  const firmOf = (mailbox: OutboundWorldMailbox) =>
    mailbox.workspace.slug === 'alpha' ? world.crm.alpha : world.crm.beta;

  const sendDeps = (
    mailbox: OutboundWorldMailbox,
    overrides: Partial<OutboundSendDeps> = {},
  ): OutboundSendDeps => {
    const sync = world.syncDeps(mailbox);
    return {
      gmail: sync.gmail,
      oauth: sync.oauth,
      cipher: sync.cipher,
      actor: 'test-worker',
      now: () => new Date(OPEN_INSTANT),
      // 16.2's deployment half. `decideSend` defaults it to false — fail closed — so a
      // world that omitted it would hold every send with
      // `workspace_sending_not_attested` and prove nothing about caps or windows.
      deploymentSendingEnabled: true,
      // The worker image this world runs, which the stored record names.
      workerImageDigest: FIXTURE_WORKER_DIGEST,
      ...overrides,
    };
  };

  const reconcileDeps = (
    mailbox: OutboundWorldMailbox,
    overrides: Partial<ReconcileDeps> = {},
  ): ReconcileDeps => {
    const sync = world.syncDeps(mailbox);
    return {
      gmail: sync.gmail,
      oauth: sync.oauth,
      cipher: sync.cipher,
      actor: 'test-reconciler',
      // No injected clock by default. Reconciliation compares against instants the
      // *database* wrote — a dispatch that has gone quiet, an observation window that
      // has run out — so it has to reason in the same clock those were written in.
      // The send gate is the opposite: its rule is about the wall clock in the firm's
      // zone, so it takes one.
      ...overrides,
    };
  };

  return {
    ...world,
    alpha,
    beta,
    sendDeps,
    reconcileDeps,
    clientWith: world.clientWith,
    clearHolds: async workspaceId => {
      await world.database.session.query(
        'UPDATE active_holds SET released_at = now() WHERE workspace_id = $1 AND released_at IS NULL',
        [workspaceId],
      );
    },
    prepare: async (mailbox, overrides = {}) => {
      const firm = firmOf(mailbox);
      const zone = overrides.sourceZone ?? FIXTURE_ZONE;
      // Migration 0012's foreign key: the fence names a step execution that exists.
      // An override is honoured rather than replaced, because the scenario that puts
      // the same id in two workspaces is about exactly that id.
      const requested = overrides.stepExecutionId;
      // The enrollment describes the same work as the fence: the dispatch
      // re-asks the step's eligibility and refuses a fence whose firm, opportunity or
      // owner is not its enrollment's, so a firm override reaches the enrollment too.
      const firmId = overrides.firmId ?? firm.firmId;
      const opportunityId = overrides.opportunityId ?? (firmId === firm.firmId ? firm.opportunityId : undefined);
      const stepExecutionId = await makeStepExecution(world.database.session, {
        workspaceId: mailbox.workspace.workspaceId,
        firmId,
        ...(opportunityId === undefined || opportunityId === null ? {} : { opportunityId }),
        userId: mailbox.workspace.salesperson.userId,
        templateVersionId: mailbox.templateVersionId,
        ...(typeof requested === 'string' ? { id: requested } : {}),
      });
      const enrollment = await world.database.session.query<{ enrollment_id: string; opportunity_id: string }>(
        `SELECT e.enrollment_id, n.opportunity_id
           FROM step_executions e
           JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
          WHERE e.workspace_id = $1 AND e.id = $2`,
        [mailbox.workspace.workspaceId, stepExecutionId],
      );
      const request: OutboundEmailRequest = {
        stepExecutionId,
        // The fence names its enrollment, as `runEmailStep`'s request always does.
        enrollmentId: enrollment.rows[0]?.enrollment_id ?? null,
        firmId,
        contactId: firm.contactId,
        opportunityId: enrollment.rows[0]?.opportunity_id ?? firm.opportunityId,
        ownerUserId: mailbox.workspace.salesperson.userId,
        templateVersionId: mailbox.templateVersionId,
        templateContentHash: mailbox.templateContentHash,
        emailAddressId: mailbox.routeId,
        toAddress: mailbox.recipientAddress,
        subject: TEMPLATE_SUBJECT,
        body: TEMPLATE_BODY,
        sendAt: OPEN_INSTANT,
        sourceZone: zone,
        businessDate: FIXTURE_BUSINESS_DATE,
        ...overrides,
      };
      const prepared = await prepareOutboundMessage(
        world.systemContext(mailbox.workspace.workspaceId),
        request,
      );
      if (!prepared.ok) throw new Error(`the fixture could not prepare a fence: ${prepared.reason}`);
      return prepared.value.outboundMessageId;
    },
    stop: world.stop,
  };
}
