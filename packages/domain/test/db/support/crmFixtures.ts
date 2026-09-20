import type { SessionQueryable } from '../../../db/queryable.ts';
import type { SeededWorkspace, TwoWorkspaces } from './fixtures.ts';

/**
 * CRM rows for the two-workspace fixture (specification 6, Appendix G 8).
 *
 * Every business row a CRM test needs, created in *both* workspaces with colliding
 * external identifiers: the same firm name, the same website, the same contact name,
 * the same normalized email address and the same phone number. Nothing may cross.
 *
 * No real business name, address or number appears here. `example.test` is reserved by
 * RFC 6761 and the number is in the NANP 555-01XX fictional block.
 */

export interface SeededFirm {
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
}

export interface SeededCrm {
  readonly alpha: SeededFirm;
  readonly beta: SeededFirm;
  /** The firm name both workspaces use. */
  readonly collidingFirmName: string;
  /** The email address both workspaces route to, and which two firms inside one may share. */
  readonly collidingEmail: string;
  /** The phone number both workspaces route to. NANP 555-01XX, never dialable. */
  readonly collidingE164: string;
}

const COLLIDING_FIRM_NAME = 'Northwind Test Holdings';
const COLLIDING_EMAIL = 'reception@northwind.example.test';
const COLLIDING_E164 = '+14015550187';

/** The stage a workspace's default pipeline starts at. */
export async function firstStageId(session: SessionQueryable, workspaceId: string): Promise<string> {
  const { rows } = await session.query<{ id: string }>(
    'SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1',
    [workspaceId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the workspace has no seeded pipeline stages');
  return id;
}

/** A seeded stage by its stable key, e.g. `won`. */
export async function stageIdByKey(
  session: SessionQueryable,
  workspaceId: string,
  key: string,
): Promise<string> {
  const { rows } = await session.query<{ id: string }>(
    'SELECT id FROM pipeline_stages WHERE workspace_id = $1 AND key = $2',
    [workspaceId, key],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the workspace has no stage ${key}`);
  return id;
}

async function seedFirm(session: SessionQueryable, workspace: SeededWorkspace): Promise<SeededFirm> {
  const firm = await session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, website, locality, region_code, postal_code,
                        time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, 'https://northwind.example.test', 'Providence', 'RI', '02903',
             'America/New_York', 'medium', 'state_default', 'firm-zone.1')
     RETURNING id`,
    [workspace.workspaceId, COLLIDING_FIRM_NAME, workspace.salesperson.userId],
  );
  const firmId = firm.rows[0]?.id ?? '';

  const contact = await session.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name, title, is_primary)
     VALUES ($1, $2, 'Dana Example', 'Operations Lead', true)
     RETURNING id`,
    [workspace.workspaceId, firmId],
  );
  const contactId = contact.rows[0]?.id ?? '';

  await session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
             0.950, 'passed', 'usable', 'route-policy.1')`,
    [workspace.workspaceId, firmId, contactId, COLLIDING_EMAIL],
  );
  await session.query(
    `INSERT INTO phone_routes (workspace_id, firm_id, contact_id, e164, source, retrieved_at,
                               association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
             0.900, 'passed', 'usable', 'route-policy.1')`,
    [workspace.workspaceId, firmId, contactId, COLLIDING_E164],
  );

  const stageId = await firstStageId(session, workspace.workspaceId);
  const opportunity = await session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00')
     RETURNING id`,
    [workspace.workspaceId, firmId, stageId],
  );
  const opportunityId = opportunity.rows[0]?.id ?? '';

  await session.query(
    `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind, occurred_at)
     VALUES ($1, $2, $3, $4, 'system', TIMESTAMPTZ '2026-09-01 12:00:00+00')`,
    [workspace.workspaceId, opportunityId, firmId, stageId],
  );

  return { firmId, contactId, opportunityId };
}

export async function seedCrm(session: SessionQueryable, seeded: TwoWorkspaces): Promise<SeededCrm> {
  return {
    alpha: await seedFirm(session, seeded.alpha),
    beta: await seedFirm(session, seeded.beta),
    collidingFirmName: COLLIDING_FIRM_NAME,
    collidingEmail: COLLIDING_EMAIL,
    collidingE164: COLLIDING_E164,
  };
}
