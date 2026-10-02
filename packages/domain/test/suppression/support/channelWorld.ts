import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../../db/workspaceScope.ts';
import type { StepEligibilityInput } from '../../../sequences/eligibility.ts';
import { firstStageId } from '../../db/support/crmFixtures.ts';
import type { SeededWorkspace } from '../../db/support/fixtures.ts';

/**
 * A small world for the channel-stop tests (DESIGN-S3X §2.6): a firm with one contact who
 * holds one address and two numbers, fresh per case so no case sees another's stops.
 *
 * Numbers are in the NANP 555-01XX fictional block, addresses under `example.test`.
 */

export interface ChannelFirm {
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
  readonly address: string;
  readonly phone: string;
  readonly otherPhone: string;
  readonly phoneRouteId: string;
  readonly otherPhoneRouteId: string;
}

let counter = 0;

/** Two distinct fictional numbers per call. */
function nextNumbers(): readonly [string, string] {
  counter += 1;
  const base = (counter * 2) % 100;
  const pad = (n: number): string => String(n).padStart(2, '0');
  // 555-0100..555-0199, cycling through area codes so a long file never repeats a pair.
  const area = 401 + Math.floor((counter * 2) / 100);
  return [`+1${String(area)}55501${pad(base)}`, `+1${String(area)}55501${pad(base + 1)}`];
}

export async function seedChannelFirm(session: SessionQueryable, workspace: SeededWorkspace): Promise<ChannelFirm> {
  const tag = randomUUID().slice(0, 8);
  const firm = await session.query<{ id: string }>(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, website, locality, region_code, postal_code,
                        time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, 'https://channels.example.test', 'Providence', 'RI', '02903',
             'America/New_York', 'medium', 'state_default', 'firm-zone.1')
     RETURNING id`,
    [workspace.workspaceId, `Channel Test ${tag}`, workspace.salesperson.userId],
  );
  const firmId = firm.rows[0]?.id ?? '';
  const contact = await session.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name, title, is_primary)
     VALUES ($1, $2, 'Robin Example', 'Owner', true) RETURNING id`,
    [workspace.workspaceId, firmId],
  );
  const contactId = contact.rows[0]?.id ?? '';
  const address = `robin.${tag}@channels.example.test`;
  await session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
             0.950, 'passed', 'usable', 'route-policy.1')`,
    [workspace.workspaceId, firmId, contactId, address],
  );
  const [phone, otherPhone] = nextNumbers();
  const routeIds: string[] = [];
  for (const e164 of [phone, otherPhone]) {
    const route = await session.query<{ id: string }>(
      `INSERT INTO phone_routes (workspace_id, firm_id, contact_id, e164, source, retrieved_at,
                                 association_confidence, technical_validation, eligibility, eligibility_policy_version)
       VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
               0.900, 'passed', 'usable', 'route-policy.1')
       RETURNING id`,
      [workspace.workspaceId, firmId, contactId, e164],
    );
    routeIds.push(route.rows[0]?.id ?? '');
  }
  const stageId = await firstStageId(session, workspace.workspaceId);
  const opportunity = await session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00') RETURNING id`,
    [workspace.workspaceId, firmId, stageId],
  );
  return {
    firmId,
    contactId,
    opportunityId: opportunity.rows[0]?.id ?? '',
    address,
    phone,
    otherPhone,
    phoneRouteId: routeIds[0] ?? '',
    otherPhoneRouteId: routeIds[1] ?? '',
  };
}

/**
 * One stop, inserted directly with a chosen instant, as a pre-0037 binary or a replay would
 * leave it. `channel` omitted means the INSERT names no channel column at all, which is
 * exactly what an older binary writes (the column default, `all`).
 */
export async function insertStop(
  session: SessionQueryable,
  workspaceId: string,
  stop: {
    readonly scope: 'firm' | 'handle';
    readonly key: string;
    readonly channel?: 'phone' | 'email' | 'all';
    readonly at: string;
    readonly source?: string;
    readonly supersedes?: string;
  },
): Promise<string> {
  const eventId = `test_${randomUUID()}`;
  const supersession = stop.supersedes !== undefined;
  const columns = ['workspace_id', 'event_id', 'scope', 'canonical_key', 'canonicalizer_version', 'source', 'recorded_at'];
  const values: unknown[] = [
    workspaceId,
    eventId,
    stop.scope,
    stop.key.toLowerCase(),
    'e164-lower.1',
    supersession ? 'admin_supersession' : (stop.source ?? 'prospect_opt_out'),
    stop.at,
  ];
  if (supersession) {
    columns.push('supersedes_event_id', 'supersession_reason');
    values.push(stop.supersedes, 'correction');
  }
  if (stop.channel !== undefined) {
    columns.push('channel');
    values.push(stop.channel);
  }
  await session.query(
    `INSERT INTO suppression_events (${columns.join(', ')})
     VALUES (${columns.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    values,
  );
  return eventId;
}

export function userContext(
  db: SessionQueryable,
  workspace: SeededWorkspace,
  role: 'admin' | 'salesperson' = 'salesperson',
): RepositoryContext {
  const userId = role === 'admin' ? workspace.admin.userId : workspace.salesperson.userId;
  return repositoryContext(workspaceScope(workspace.workspaceId, { kind: 'user', userId, role }), db);
}

/**
 * The input `suppressionSource` reads: the firm, the contact and the step's channel. The
 * rest of a step's input is irrelevant to that source, which reads nothing else.
 */
export function stepInput(firm: ChannelFirm, channel: 'email' | 'call_task'): StepEligibilityInput {
  return {
    firmId: firm.firmId,
    contactId: firm.contactId,
    channel,
  } as unknown as StepEligibilityInput;
}
