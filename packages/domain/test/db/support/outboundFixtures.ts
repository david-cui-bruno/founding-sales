import type { SessionQueryable } from '../../../db/queryable.ts';
import type { SeededWorkspace, TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import type { SeededMail } from './mailFixtures.ts';
import { makeStepExecution } from '../../../db/testing/stepExecutions.ts';

/**
 * Outbound rows for the two-workspace fixture (specification 12.5 to 12.7,
 * Appendix G 8).
 *
 * Both workspaces get the same sending domain name, a ramp, an open send day, an
 * approved template version and one fence that reached `sent` — and the external
 * identifiers collide on purpose: the same step-execution id, the same deterministic
 * Message-ID header and the same provider message id. Every uniqueness in migration
 * 0010 is per workspace, so all three must be accepted twice and neither workspace
 * may see the other's.
 *
 * The colliding step-execution id is the sharpest of the three. It is the key G8's
 * `prepare` is idempotent on, so a bug that scoped `outbound_messages_one_per_step_execution`
 * by anything less than the workspace would make one workspace's send silently reuse
 * another's fence — and the fence is the thing that decides whether an email goes out.
 *
 * No real person, address or business name appears here. `example.test` is reserved
 * by RFC 6761.
 */

export interface SeededOutboundWorkspace {
  readonly sendingDomainId: string;
  readonly rampId: string;
  readonly sendDayId: string;
  readonly templateVersionId: string;
  readonly templateId: string;
  readonly routeId: string;
  /** A fence that reached `sent`, with its attempt token and header. */
  readonly sentFenceId: string;
  readonly sentAttemptToken: string;
  readonly header: string;
  /** A fence still in `prepared`, for the cases that need one that can still move. */
  readonly preparedFenceId: string;
}

export interface SeededOutbound {
  readonly alpha: SeededOutboundWorkspace;
  readonly beta: SeededOutboundWorkspace;
  /** The sending domain name both workspaces claim as primary. */
  readonly collidingDomain: string;
  /** The step execution id both workspaces' fences name. */
  readonly collidingStepExecutionId: string;
  /** The deterministic Message-ID header both workspaces' fences carry. */
  readonly collidingHeader: string;
  /** The Gmail message id both workspaces' sent fences record. */
  readonly collidingProviderMessageId: string;
}

const COLLIDING_DOMAIN = 'sending.example.test';
const COLLIDING_STEP_EXECUTION_ID = '11111111-2222-4333-8444-555555555555';
const COLLIDING_HEADER = '<fss.11111111-2222-4333-8444-555555555555@sending.example.test>';
const COLLIDING_PROVIDER_MESSAGE_ID = '18f3d1b2c3d4e5f6';

export const FIXTURE_BUSINESS_DATE = '2026-09-02';
export const FIXTURE_SEND_AT = '2026-09-02T13:00:00.000Z';
export const FIXTURE_ZONE = 'America/New_York';
export const FIXTURE_PLACEMENT_RULE = 'email-window.1';

/** An approvable body: it ends with the reply-to-stop line and names no web link. */
export const FIXTURE_BODY =
  'Hello.\n\nSigned off\n1 Example Way\nReply "stop" and I will not email you again.';
export const FIXTURE_SUBJECT = 'A short note about your properties';
const FIXTURE_HASH = 'b'.repeat(64);

async function seedWorkspaceOutbound(
  session: SessionQueryable,
  workspace: SeededWorkspace,
  crm: { readonly firmId: string; readonly contactId: string; readonly opportunityId: string },
  mail: { readonly mailboxId: string },
): Promise<SeededOutboundWorkspace> {
  const domain = await session.query<{ id: string }>(
    `INSERT INTO sending_domains (workspace_id, domain, spf_pass, dkim_pass, dmarc_pass,
                                  authentication_checked_at, authentication_checked_by_user_id,
                                  postmaster_reviewed_at, automated_sending_enabled,
                                  automated_sending_enabled_at)
     VALUES ($1, $2, true, true, true, TIMESTAMPTZ '2026-09-01 09:00:00+00', $3,
             TIMESTAMPTZ '2026-09-01 09:00:00+00', true, TIMESTAMPTZ '2026-09-01 09:00:00+00')
     RETURNING id`,
    [workspace.workspaceId, COLLIDING_DOMAIN, workspace.admin.userId],
  );

  const ramp = await session.query<{ id: string }>(
    `INSERT INTO mailbox_send_ramp (workspace_id, mailbox_id, healthy_sending_days, last_advanced_on)
     VALUES ($1, $2, 3, DATE '2026-09-01') RETURNING id`,
    [workspace.workspaceId, mail.mailboxId],
  );

  const day = await session.query<{ id: string }>(
    `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, automated_sent, cap_granted)
     VALUES ($1, $2, DATE '${FIXTURE_BUSINESS_DATE}', 1, 5) RETURNING id`,
    [workspace.workspaceId, mail.mailboxId],
  );

  const templateId = '33333333-4444-4555-8666-777777777777';
  const template = await session.query<{ id: string }>(
    `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                    content_hash, footer_sign_off,
                                    approved_at, approved_by_user_id)
     VALUES ($1, $2, 1, 'Fixture template', $3, $4, $5, 'Signed off',
             TIMESTAMPTZ '2026-09-01 09:00:00+00', $6)
     RETURNING id`,
    [
      workspace.workspaceId,
      templateId,
      FIXTURE_SUBJECT,
      FIXTURE_BODY,
      FIXTURE_HASH,
      workspace.admin.userId,
    ],
  );

  const route = await session.query<{ id: string; version: number }>(
    'SELECT id, version FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2 LIMIT 1',
    [workspace.workspaceId, crm.firmId],
  );
  const routeId = route.rows[0]?.id ?? '';
  const routeVersion = route.rows[0]?.version ?? 1;

  // Migration 0012's foreign key means a fence names a step execution that exists.
  // Appendix G 8 wants the *same* uuid in both workspaces, and the composite primary
  // key `(workspace_id, id)` is what lets both rows have it.
  const templateVersionId = template.rows[0]?.id ?? '';
  const stepExecution = {
    workspaceId: workspace.workspaceId,
    firmId: crm.firmId,
    opportunityId: crm.opportunityId,
    userId: workspace.salesperson.userId,
    templateVersionId,
  };
  await makeStepExecution(session, { ...stepExecution, id: COLLIDING_STEP_EXECUTION_ID });
  const preparedStepExecutionId = await makeStepExecution(session, stepExecution);

  const commonColumns = `workspace_id, mailbox_id, origin_kind, step_execution_id, firm_id, contact_id,
      opportunity_id, recipient_address, recipient_route_id, recipient_route_version, subject, body,
      template_version_id, rendered_hash, provider_message_id_header, send_at, source_zone,
      placement_rule_version, business_date`;

  // A fence that went all the way. Its attempt token is what a `sent` row must have.
  const sentToken = '44444444-5555-4666-8777-888888888888';
  const sent = await session.query<{ id: string }>(
    `INSERT INTO outbound_messages (${commonColumns}, state, attempt_token, dispatch_started_at,
                                    sent_at, provider_message_id, provider_thread_id)
     VALUES ($1, $2, 'step_execution', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
             TIMESTAMPTZ '${FIXTURE_SEND_AT}', '${FIXTURE_ZONE}', '${FIXTURE_PLACEMENT_RULE}',
             DATE '${FIXTURE_BUSINESS_DATE}',
             'sent', $15, TIMESTAMPTZ '2026-09-02 13:00:01+00',
             TIMESTAMPTZ '2026-09-02 13:00:02+00', $16, $17)
     RETURNING id`,
    [
      workspace.workspaceId,
      mail.mailboxId,
      COLLIDING_STEP_EXECUTION_ID,
      crm.firmId,
      crm.contactId,
      crm.opportunityId,
      `prospect.${workspace.slug}@example.test`,
      routeId,
      routeVersion,
      FIXTURE_SUBJECT,
      FIXTURE_BODY,
      template.rows[0]?.id ?? '',
      FIXTURE_HASH,
      COLLIDING_HEADER,
      sentToken,
      COLLIDING_PROVIDER_MESSAGE_ID,
      `${COLLIDING_PROVIDER_MESSAGE_ID}-thread`,
    ],
  );
  const sentFenceId = sent.rows[0]?.id ?? '';

  await session.query(
    `INSERT INTO outbound_message_events (workspace_id, outbound_message_id, sequence_number,
                                          from_state, to_state, attempt_token, actor)
     VALUES ($1, $2, 1, NULL, 'prepared', NULL, 'fixture'),
            ($1, $2, 2, 'prepared', 'dispatching', $3, 'fixture'),
            ($1, $2, 3, 'dispatching', 'sent', $3, 'fixture')`,
    [workspace.workspaceId, sentFenceId, sentToken],
  );

  // A fence that has not moved, for the cases that need one that still can.
  const prepared = await session.query<{ id: string }>(
    `INSERT INTO outbound_messages (${commonColumns})
     VALUES ($1, $2, 'step_execution', $14, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             $13, TIMESTAMPTZ '${FIXTURE_SEND_AT}', '${FIXTURE_ZONE}', '${FIXTURE_PLACEMENT_RULE}',
             DATE '${FIXTURE_BUSINESS_DATE}')
     RETURNING id`,
    [
      workspace.workspaceId,
      mail.mailboxId,
      crm.firmId,
      crm.contactId,
      crm.opportunityId,
      `prospect.later.${workspace.slug}@example.test`,
      routeId,
      routeVersion,
      FIXTURE_SUBJECT,
      FIXTURE_BODY,
      template.rows[0]?.id ?? '',
      FIXTURE_HASH,
      `<fss.prepared-${workspace.slug}@sending.example.test>`,
      preparedStepExecutionId,
    ],
  );

  return {
    sendingDomainId: domain.rows[0]?.id ?? '',
    rampId: ramp.rows[0]?.id ?? '',
    sendDayId: day.rows[0]?.id ?? '',
    templateVersionId: template.rows[0]?.id ?? '',
    templateId,
    routeId,
    sentFenceId,
    sentAttemptToken: sentToken,
    header: COLLIDING_HEADER,
    preparedFenceId: prepared.rows[0]?.id ?? '',
  };
}

export async function seedOutbound(
  session: SessionQueryable,
  seeded: TwoWorkspaces,
  crm: SeededCrm,
  mail: SeededMail,
): Promise<SeededOutbound> {
  return {
    alpha: await seedWorkspaceOutbound(session, seeded.alpha, crm.alpha, mail.alpha),
    beta: await seedWorkspaceOutbound(session, seeded.beta, crm.beta, mail.beta),
    collidingDomain: COLLIDING_DOMAIN,
    collidingStepExecutionId: COLLIDING_STEP_EXECUTION_ID,
    collidingHeader: COLLIDING_HEADER,
    collidingProviderMessageId: COLLIDING_PROVIDER_MESSAGE_ID,
  };
}
