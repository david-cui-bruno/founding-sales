import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchOutboundMessage, type SendReport } from '../../outbound/send.ts';
import { createOutboundWorld, type OutboundWorld } from './support/outboundWorld.ts';
import { prepareFor, seedFirm } from './support/dispatchFixtures.ts';

/**
 * A prepared fence that does not describe its own enrollment's work
 * (P0-2 of the GPT-6 review of PR 332).
 *
 * A permission is granted about **a person**, and until this round nothing compared the
 * permission's person with the address that would actually leave: the eligibility source
 * asked about the enrollment's contact while the fence supplied the recipient and the
 * route, and no equality check connected them. Every fence the sequence engine prepares
 * takes its contact from its enrollment and its route from that contact, so none of the
 * shapes below is a state the product produces — which is exactly why each has to be
 * refused rather than explained.
 *
 * Each case takes a fence that would otherwise send (the control at the top proves that),
 * changes one thing, and requires the claim to refuse it with its own reason and to send
 * nothing.
 */

let world: OutboundWorld;

beforeAll(async () => {
  world = await createOutboundWorld();
}, 180_000);

afterAll(async () => {
  await world?.stop();
});

const workspaceId = (): string => world.alpha.workspace.workspaceId;
const context = () => world.systemContext(workspaceId());

async function dispatch(fenceId: string): Promise<{ readonly report: SendReport; readonly sends: number }> {
  const gmail = world.clientWith(world.alpha, {});
  const report = await dispatchOutboundMessage(context(), world.sendDeps(world.alpha, { gmail }), {
    outboundMessageId: fenceId,
  });
  return { report, sends: gmail.sends.length };
}

/** Another person at this firm, with a usable address of their own. */
async function strangerAt(firmId: string): Promise<{ readonly contactId: string; readonly routeId: string; readonly address: string }> {
  const { rows: contacts } = await world.database.session.query<{ id: string }>(
    "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Alex Stranger') RETURNING id",
    [workspaceId(), firmId],
  );
  const contactId = contacts[0]?.id ?? '';
  const address = `stranger.${contactId.slice(0, 8)}@prospect.example.test`;
  const { rows: routes } = await world.database.session.query<{ id: string }>(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility,
                                  eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', now(), 0.900, 'passed', 'usable', 'route-policy.1')
     RETURNING id`,
    [workspaceId(), firmId, contactId, address],
  );
  return { contactId, routeId: routes[0]?.id ?? '', address };
}

describe('a fence that disagrees with its enrollment is refused at the claim', () => {
  it('the control: the fence the engine really prepares does send', async () => {
    const firm = await seedFirm(world, world.alpha, 'malformed-control');
    const { report, sends } = await dispatch(await prepareFor(world, world.alpha, firm));
    expect(report.outcome, JSON.stringify(report)).toBe('sent');
    expect(sends).toBe(1);
  });

  it('names another person than its enrollment', async () => {
    const firm = await seedFirm(world, world.alpha, 'malformed-contact');
    const stranger = await strangerAt(firm.firmId);
    const fenceId = await prepareFor(world, world.alpha, firm, {
      contactId: stranger.contactId,
      emailAddressId: stranger.routeId,
      toAddress: stranger.address,
    });
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail).toBe('contact_mismatch');
    expect(sends).toBe(0);
  });

  it('froze a route belonging to somebody else', async () => {
    const firm = await seedFirm(world, world.alpha, 'malformed-route');
    const stranger = await strangerAt(firm.firmId);
    const fenceId = await prepareFor(world, world.alpha, firm, {
      emailAddressId: stranger.routeId,
      toAddress: stranger.address,
    });
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail).toBe('route_owner_mismatch');
    expect(sends).toBe(0);
  });

  it('would write to an address that is not the route it froze', async () => {
    const firm = await seedFirm(world, world.alpha, 'malformed-address');
    const fenceId = await prepareFor(world, world.alpha, firm);
    // The address is corrected after the fence was prepared, which is a real event: a
    // merge or a correction moves the route's address, and the bytes the fence carries
    // are then addressed to somebody the permission never named.
    await world.database.session.query(
      `UPDATE email_addresses SET address = 'corrected.' || address
        WHERE workspace_id = $1
          AND id = (SELECT recipient_route_id FROM outbound_messages WHERE workspace_id = $1 AND id = $2)`,
      [workspaceId(), fenceId],
    );
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome).toBe('held');
    expect(`${report.refusal ?? ''}:${report.detail ?? ''}`).toContain('recipient_address_mismatch');
    expect(sends).toBe(0);
  });

  it('carries a template version the permission does not permit', async () => {
    const firm = await seedFirm(world, world.alpha, 'malformed-template');
    const fenceId = await prepareFor(world, world.alpha, firm);
    // The permission becomes the scope that names its bytes: one e-mail, one approved
    // template — and a *different* one from the template this fence froze. Since P0-2 the
    // claim asks the permission about the fence's own template version, so this is a
    // fence for bytes nobody agreed to.
    const { rows: other } = await world.database.session.query<{ id: string }>(
      `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                      content_hash, footer_sign_off, approved_at, approved_by_user_id)
       SELECT workspace_id, gen_random_uuid(), 1, 'Another approved note', subject, body,
              encode(sha256(random()::text::bytea), 'hex'), footer_sign_off, now(), approved_by_user_id
         FROM template_versions WHERE workspace_id = $1 AND id = $2
       RETURNING id`,
      [workspaceId(), world.alpha.templateVersionId],
    );
    const agreed = other[0]?.id ?? '';
    const { rows: narrowed } = await world.database.session.query<{ call_log_id: string }>(
      `UPDATE follow_up_permissions p
          SET scope = 'single_email', sequence_version_id = NULL,
              template_version_id = $3, max_steps = 1
        FROM outbound_messages m
        JOIN step_executions e ON e.workspace_id = m.workspace_id AND e.id = m.step_execution_id
        JOIN sequence_enrollments n ON n.workspace_id = e.workspace_id AND n.id = e.enrollment_id
       WHERE p.workspace_id = $1 AND m.workspace_id = $1 AND m.id = $2 AND p.id = n.permission_id
       RETURNING p.call_log_id`,
      [workspaceId(), fenceId, agreed],
    );
    await world.database.session.query(
      `UPDATE call_logs
          SET agreed_follow_up = 'single_email', agreed_sequence_version_id = NULL,
              agreed_template_version_id = $3
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId(), narrowed[0]?.call_log_id ?? '', agreed],
    );

    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome, JSON.stringify(report)).toBe('held');
    expect(`${report.refusal ?? ''}:${report.detail ?? ''}`).toContain('follow_up');
    expect(sends).toBe(0);
  });

  it('points at an execution for another person', async () => {
    const firm = await seedFirm(world, world.alpha, 'malformed-execution');
    const fenceId = await prepareFor(world, world.alpha, firm);
    const stranger = await strangerAt(firm.firmId);
    await world.database.session.query(
      `UPDATE step_executions SET contact_id = $3
        WHERE workspace_id = $1
          AND id = (SELECT step_execution_id FROM outbound_messages WHERE workspace_id = $1 AND id = $2)`,
      [workspaceId(), fenceId, stranger.contactId],
    );
    const { report, sends } = await dispatch(fenceId);
    expect(report.outcome).toBe('held');
    expect(report.refusal).toBe('step_ineligible');
    expect(report.detail).toBe('execution_contact_mismatch');
    expect(sends).toBe(0);
  });
});
