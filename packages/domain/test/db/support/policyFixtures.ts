import type { SessionQueryable } from '../../../db/queryable.ts';
import type { SeededCrm } from './crmFixtures.ts';
import type { SeededWorkspace, TwoWorkspaces } from './fixtures.ts';

/**
 * The policy and dialing rows the G4 tests start from (specification 9.1, 9.2, 10.1).
 *
 * Built in *both* workspaces, with the same calling number and the same state, so
 * every assertion about a refusal is also an assertion that the other workspace's
 * identical row did not answer it (section 6, Appendix G 8).
 *
 * The numbers are in the NANP 555-01XX fictional block and reach nobody. The state is
 * Rhode Island because `seedCrm` puts its firms in Providence, and because
 * `STATE_POSTURE_RULES` in `@fss/domain` carries a real reference text for it.
 */

export interface SeededPolicy {
  readonly alpha: SeededPolicyWorkspace;
  readonly beta: SeededPolicyWorkspace;
  /** A Wednesday, 10:00 in America/New_York: inside the weekday calling window. */
  readonly insideWindow: string;
  /** The same Wednesday at 03:00 local: outside it. */
  readonly outsideWindow: string;
}

export interface SeededPolicyWorkspace {
  /** Verified, enabled, owned by the workspace's salesperson. */
  readonly callingIdentityId: string;
  /** Verified, enabled, owned by the workspace's *admin*, so "owned by the actor" is testable. */
  readonly otherCallingIdentityId: string;
  /** The reserved future shared line: no owner, permanently disabled. */
  readonly sharedLineIdentityId: string;
  readonly postureId: string;
  readonly phoneRouteId: string;
  readonly phoneRouteVersion: number;
  readonly e164: string;
}

export const POSTURE_STATE = 'RI';
const IDENTITY_E164 = '+14015550100';
const ADMIN_IDENTITY_E164 = '+14015550101';
const SHARED_LINE_E164 = '+14015550102';

/** 2026-09-16 is a Wednesday; 14:00 UTC is 10:00 in America/New_York. */
export const INSIDE_WINDOW = '2026-09-16T14:00:00.000Z';
export const OUTSIDE_WINDOW = '2026-09-16T07:00:00.000Z';

async function seedOne(
  session: SessionQueryable,
  workspace: SeededWorkspace,
  firmId: string,
): Promise<SeededPolicyWorkspace> {
  const identity = await session.query<{ id: string }>(
    `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled)
     VALUES ($1, $2, $3, 'verified', true) RETURNING id`,
    [workspace.workspaceId, workspace.salesperson.userId, IDENTITY_E164],
  );
  const otherIdentity = await session.query<{ id: string }>(
    `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled)
     VALUES ($1, $2, $3, 'verified', true) RETURNING id`,
    [workspace.workspaceId, workspace.admin.userId, ADMIN_IDENTITY_E164],
  );
  const sharedLine = await session.query<{ id: string }>(
    `INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled)
     VALUES ($1, NULL, $2, 'verified', false) RETURNING id`,
    [workspace.workspaceId, SHARED_LINE_E164],
  );

  const posture = await session.query<{ id: string }>(
    `INSERT INTO state_postures
       (workspace_id, state, revision, effective_from, effective_to, review_at,
        rules_revision, confirmed_statements, sources, confirmed_by_user_id)
     VALUES ($1, $2, 1, TIMESTAMPTZ '2026-01-01 00:00:00+00', NULL, TIMESTAMPTZ '2027-01-01 00:00:00+00',
             2, ARRAY['businessToBusiness','registrationStatusChecked','stateDncSubscriptionChecked','consentRuleConfirmed']::text[],
             $3::jsonb, $4)
     RETURNING id`,
    [
      workspace.workspaceId,
      POSTURE_STATE,
      JSON.stringify([
        {
          title: 'R.I. Gen. Laws § 5-61-1, Telephone Sales Solicitation Act (definition of telephone solicitation)',
          url: 'https://webserver.rilegislature.gov/Statutes/TITLE5/5-61/5-61-1.htm',
        },
      ]),
      workspace.admin.userId,
    ],
  );

  const route = await session.query<{ id: string; version: number; e164: string }>(
    `SELECT id, version, e164 FROM phone_routes WHERE workspace_id = $1 AND firm_id = $2 LIMIT 1`,
    [workspace.workspaceId, firmId],
  );
  const row = route.rows[0];
  if (row === undefined) throw new Error('the seeded firm has no phone route');

  return {
    callingIdentityId: identity.rows[0]?.id ?? '',
    otherCallingIdentityId: otherIdentity.rows[0]?.id ?? '',
    sharedLineIdentityId: sharedLine.rows[0]?.id ?? '',
    postureId: posture.rows[0]?.id ?? '',
    phoneRouteId: row.id,
    phoneRouteVersion: row.version,
    e164: row.e164,
  };
}

export async function seedPolicy(
  session: SessionQueryable,
  seeded: TwoWorkspaces,
  crm: SeededCrm,
): Promise<SeededPolicy> {
  return {
    alpha: await seedOne(session, seeded.alpha, crm.alpha.firmId),
    beta: await seedOne(session, seeded.beta, crm.beta.firmId),
    insideWindow: INSIDE_WINDOW,
    outsideWindow: OUTSIDE_WINDOW,
  };
}
