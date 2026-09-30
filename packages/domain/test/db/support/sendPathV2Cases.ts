import type { SessionQueryable } from '../../../db/queryable.ts';
import type { SeededCrm } from './crmFixtures.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * A failing insert for every constraint migration 0026 adds (send-path v2, slice S0).
 *
 * The constraints 0026 *swaps* under their old names (`mail_message_effects_kind_known`,
 * `mailboxes_kind_known`, `mailboxes_shared_kind_disabled`) keep the cases they already
 * had; the two immutability triggers are not catalogue constraints and are exercised in
 * `test/db/sendPathV2.test.ts`. Each case below breaks exactly one constraint.
 */

interface Fixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly crm: SeededCrm;
}

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

const workspace = (f: Fixture): string => f.seeded.alpha.workspaceId;
const admin = (f: Fixture): string => f.seeded.alpha.admin.userId;
/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000000fd';

/**
 * A `contextual_reply` permission, the scope that may be consumed and needs no other
 * table: booking-reference evidence, a one-step limit, and whatever consumption the case
 * wants to break.
 */
async function consumedPermission(
  f: Fixture,
  consumedAt: string | null,
  consumedReason: string | null,
): Promise<unknown> {
  return await f.session.query(
    `INSERT INTO follow_up_permissions
       (workspace_id, firm_id, contact_id, kind, scope, booking_reference, max_steps,
        expires_at, granted_by_user_id, consumed_at, consumed_reason)
     VALUES ($1, $2, $3, 'request', 'contextual_reply', 'cal-0026-case', 1,
             now() + interval '14 days', $4, $5, $6)`,
    [workspace(f), f.crm.alpha.firmId, f.crm.alpha.contactId, admin(f), consumedAt, consumedReason],
  );
}

export const SEND_PATH_V2_CONSTRAINT_CASES: readonly Case[] = [
  // ------------------------------------------------ follow_up_permissions (0026)
  {
    constraint: 'follow_up_permissions_consumed_reason_known',
    // Consumed, with a reason, but not one of the two words.
    run: async f => await consumedPermission(f, new Date().toISOString(), 'it_felt_right'),
  },
  {
    constraint: 'follow_up_permissions_consumed_reason_iff_consumed',
    // Consumed with no reason: the spend nobody can explain.
    run: async f => await consumedPermission(f, new Date().toISOString(), null),
  },
  {
    constraint: 'follow_up_permissions_consumed_reason_iff_consumed',
    // The other direction: a reason on a permission nothing spent.
    run: async f => await consumedPermission(f, null, 'sent'),
  },

  // ------------------------------------------------- sequence_enrollments (0026)
  {
    constraint: 'sequence_enrollments_migrated_from_fkey',
    run: async f => {
      const { rows: sequence } = await f.session.query<{ id: string }>(
        'INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
        [workspace(f), `0026 lineage ${String(Date.now())}`, admin(f)],
      );
      const { rows: version } = await f.session.query<{ id: string }>(
        `INSERT INTO sequence_versions (workspace_id, sequence_id, version, state, published_at, published_by_user_id)
         VALUES ($1, $2, 1, 'published', now(), $3) RETURNING id`,
        [workspace(f), sequence[0]?.id ?? '', admin(f)],
      );
      const { rows: contact } = await f.session.query<{ id: string }>(
        'INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id',
        [workspace(f), f.crm.alpha.firmId, 'Lineage Case'],
      );
      return await f.session.query(
        `INSERT INTO sequence_enrollments
           (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
            firm_time_zone, holiday_calendar_version, origin_kind, migrated_from_enrollment_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1', 'prospecting', $7)`,
        [
          workspace(f),
          version[0]?.id ?? '',
          f.crm.alpha.opportunityId,
          f.crm.alpha.firmId,
          contact[0]?.id ?? '',
          admin(f),
          ABSENT,
        ],
      );
    },
  },

  // ---------------------------------------------------- crm_domain_events (0026)
  {
    constraint: 'crm_domain_events_stop_carries_marker',
    // A stop-owing event that records nothing it owes: the drain would have nothing to
    // stop, and before 0026 it would have widened into a firm-wide stop.
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, opportunity_id, dedupe_key, actor_kind)
         VALUES ($1, 'opportunity.manual_mode', $2, $3, '0026-unmarked-case', 'system')`,
        [workspace(f), f.crm.alpha.firmId, f.crm.alpha.opportunityId],
      ),
  },
  {
    constraint: 'crm_domain_events_owed_only_on_stops',
    // A marker on a kind that stops nothing would be a stop nobody drains.
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind, owed_enrollment_ids)
         VALUES ($1, 'firm.reassigned', $2, '0026-owed-case', 'system', '{}')`,
        [workspace(f), f.crm.alpha.firmId],
      ),
  },
];
