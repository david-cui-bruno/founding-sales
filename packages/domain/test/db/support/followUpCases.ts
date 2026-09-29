import type { SessionQueryable } from '../../../db/queryable.ts';
import type { SeededCrm } from './crmFixtures.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * A failing insert for every constraint migration 0025 adds.
 *
 * The coverage test at the bottom of `constraints.test.ts` asks the catalog for the
 * enforced set and fails when one has no case, so this file is not optional and its
 * length is the migration's, not a choice.
 *
 * Each case breaks exactly **one** constraint and deliberately satisfies the others on
 * the same row. PostgreSQL evaluates a table's CHECKs in **name order** and reports the
 * first that fails, which is why — for example — the
 * `follow_up_permissions_scope_known` case has to name a `sequence_id`-free scope that
 * still satisfies `follow_up_permissions_sequence_iff_agreed` (`sc` sorts after `se`, so
 * the sequence rule would otherwise fire first).
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
const firm = (f: Fixture): string => f.crm.alpha.firmId;
const contact = (f: Fixture): string => f.crm.alpha.contactId;
const admin = (f: Fixture): string => f.seeded.alpha.admin.userId;
/** A member of the *other* workspace: a real user id that breaks a scoped membership FK. */
const stranger = (f: Fixture): string => f.seeded.beta.admin.userId;
/** A valid uuid that is never a row. */
const ABSENT = '00000000-0000-4000-8000-0000000000fe';

const COLUMNS = `workspace_id, firm_id, contact_id, kind, scope, call_log_id, mail_message_id,
  booking_reference, sequence_id, granted_at, expires_at, granted_by_user_id, granted_by_rule,
  consumed_at, revoked_at, note`;

/**
 * A permission row that satisfies everything, for a case to break one column of.
 *
 * The evidence is a `booking_reference` by default, because it is the one piece of
 * evidence that needs no other table — and `follow_up_permissions_has_evidence` only
 * asks that there is one. The scope is `single_email`, which needs no sequence.
 */
async function permission(f: Fixture, overrides: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
  const row: Record<string, unknown> = {
    workspace_id: workspace(f),
    firm_id: firm(f),
    contact_id: contact(f),
    kind: 'request',
    scope: 'single_email',
    call_log_id: null,
    mail_message_id: null,
    booking_reference: 'cal-test-0001',
    sequence_id: null,
    granted_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    granted_by_user_id: admin(f),
    granted_by_rule: null,
    consumed_at: null,
    revoked_at: null,
    note: null,
    ...overrides,
  };
  const names = COLUMNS.split(',').map(name => name.trim());
  return await f.session.query(
    `INSERT INTO follow_up_permissions (${names.join(', ')})
     VALUES (${names.map((_, index) => `$${String(index + 1)}`).join(', ')})`,
    names.map(name => row[name] ?? null),
  );
}

/** One stored permission, to hang an enrollment or a duplicate key off. */
async function seedPermission(f: Fixture): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO follow_up_permissions
       (workspace_id, firm_id, contact_id, kind, scope, booking_reference, expires_at, granted_by_user_id)
     VALUES ($1, $2, $3, 'booking', 'booking_communications', 'cal-seed-0001',
             now() + interval '30 days', $4)
     RETURNING id`,
    [workspace(f), firm(f), contact(f), admin(f)],
  );
  return rows[0]?.id ?? '';
}

/** A published one-step version, so an enrollment case has something live to name. */
async function seedVersion(f: Fixture): Promise<string> {
  const { rows: sequences } = await f.session.query<{ id: string }>(
    `INSERT INTO sequences (workspace_id, name, created_by_user_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [workspace(f), `Follow-up cases ${String(Date.now())}`, admin(f)],
  );
  const sequenceId = sequences[0]?.id ?? '';
  const { rows: versions } = await f.session.query<{ id: string }>(
    `INSERT INTO sequence_versions (workspace_id, sequence_id, version, state, published_at, published_by_user_id)
     VALUES ($1, $2, 1, 'published', now(), $3) RETURNING id`,
    [workspace(f), sequenceId, admin(f)],
  );
  return versions[0]?.id ?? '';
}

/** A contact of this firm that has no live enrollment, for the enrollment cases. */
async function seedContact(f: Fixture): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3) RETURNING id`,
    [workspace(f), firm(f), `Follow-up Case ${String(Date.now())}`],
  );
  return rows[0]?.id ?? '';
}

/** An enrollment row that satisfies everything, for a case to break one column of. */
async function enrollment(f: Fixture, overrides: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
  const versionId = await seedVersion(f);
  const contactId = await seedContact(f);
  return await f.session.query(
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
        firm_time_zone, holiday_calendar_version, origin_kind, permission_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'America/New_York', 'none.1', $7, $8)`,
    [
      workspace(f),
      versionId,
      f.crm.alpha.opportunityId,
      firm(f),
      contactId,
      admin(f),
      overrides['origin_kind'] ?? 'prospecting',
      overrides['permission_id'] ?? null,
    ],
  );
}

export const FOLLOW_UP_CONSTRAINT_CASES: readonly Case[] = [
  // ------------------------------------------------- follow_up_permissions keys
  {
    constraint: 'follow_up_permissions_pkey',
    run: async f => {
      const id = await seedPermission(f);
      // The same (workspace, id) twice. Everything else is valid.
      return await f.session.query(
        `INSERT INTO follow_up_permissions
           (workspace_id, id, firm_id, contact_id, kind, scope, booking_reference, expires_at, granted_by_user_id)
         VALUES ($1, $2, $3, $4, 'booking', 'booking_communications', 'cal-seed-0002',
                 now() + interval '30 days', $5)`,
        [workspace(f), id, firm(f), contact(f), admin(f)],
      );
    },
  },
  {
    constraint: 'follow_up_permissions_firm_fkey',
    // A firm of the other workspace: the composite key makes it absent from this one.
    run: async f => await permission(f, { firm_id: f.crm.beta.firmId, contact_id: contact(f) }),
  },
  {
    constraint: 'follow_up_permissions_contact_fkey',
    // A contact that exists, at another firm than the one named.
    run: async f => await permission(f, { contact_id: f.crm.beta.contactId }),
  },
  {
    constraint: 'follow_up_permissions_call_log_fkey',
    run: async f => await permission(f, { call_log_id: ABSENT, booking_reference: null }),
  },
  {
    constraint: 'follow_up_permissions_mail_message_fkey',
    run: async f => await permission(f, { mail_message_id: ABSENT, booking_reference: null }),
  },
  {
    constraint: 'follow_up_permissions_sequence_fkey',
    run: async f => await permission(f, { scope: 'agreed_sequence', sequence_id: ABSENT }),
  },
  {
    constraint: 'follow_up_permissions_granter_fkey',
    run: async f => await permission(f, { granted_by_user_id: stranger(f) }),
  },

  // ---------------------------------------------- follow_up_permissions CHECKs
  {
    constraint: 'follow_up_permissions_kind_known',
    run: async f => await permission(f, { kind: 'hunch' }),
  },
  {
    constraint: 'follow_up_permissions_scope_known',
    // `sequence_id` stays null, so the `_sequence_iff_agreed` rule — which sorts
    // before `_scope_known` — is satisfied by an unknown scope that is not
    // `agreed_sequence`.
    run: async f => await permission(f, { scope: 'whatever_they_asked_for' }),
  },
  {
    constraint: 'follow_up_permissions_has_evidence',
    run: async f => await permission(f, { booking_reference: null }),
  },
  {
    constraint: 'follow_up_permissions_sequence_iff_agreed',
    // A sequence named by a scope that is not the agreed one. The FK is satisfied: the
    // sequence is real.
    run: async f => {
      const { rows } = await f.session.query<{ id: string }>(
        `INSERT INTO sequences (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3) RETURNING id`,
        [workspace(f), `Sequence iff agreed ${String(Date.now())}`, admin(f)],
      );
      return await permission(f, { scope: 'single_email', sequence_id: rows[0]?.id ?? '' });
    },
  },
  {
    constraint: 'follow_up_permissions_granted_by_one',
    // Both: a person and a rule. Neither is also refused, by the same CHECK.
    run: async f => await permission(f, { granted_by_user_id: admin(f), granted_by_rule: 'call_outcome' }),
  },
  {
    constraint: 'follow_up_permissions_granted_by_rule_shape',
    run: async f => await permission(f, { granted_by_user_id: null, granted_by_rule: 'Call Outcome' }),
  },
  {
    constraint: 'follow_up_permissions_expires_after_grant',
    run: async f =>
      await permission(f, {
        granted_at: new Date().toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
  },
  {
    constraint: 'follow_up_permissions_consumption_is_single_email',
    // Consumption is what `single_email` means; a consumed `contextual_reply` would be
    // a scope claiming a rule that is not its own.
    run: async f => await permission(f, { scope: 'contextual_reply', consumed_at: new Date().toISOString() }),
  },
  {
    constraint: 'follow_up_permissions_booking_reference_bounded',
    run: async f => await permission(f, { booking_reference: '   ' }),
  },
  {
    constraint: 'follow_up_permissions_note_bounded',
    run: async f => await permission(f, { note: 'x'.repeat(2001) }),
  },

  // -------------------------------------------------- sequence_enrollments (0025)
  {
    constraint: 'sequence_enrollments_origin_kind_known',
    run: async f => await enrollment(f, { origin_kind: 'warm_ish' }),
  },
  {
    constraint: 'sequence_enrollments_permission_fkey',
    run: async f => await enrollment(f, { origin_kind: 'follow_up', permission_id: ABSENT }),
  },
  {
    constraint: 'sequence_enrollments_follow_up_has_permission',
    // The label without the evidence: the state David said must not authorize a send,
    // made unrepresentable rather than merely refused in code.
    run: async f => await enrollment(f, { origin_kind: 'follow_up', permission_id: null }),
  },

  // ------------------------------------------------------- opportunities (0025)
  {
    constraint: 'opportunities_control_mode_origin_known',
    run: async f =>
      await f.session.query(
        `UPDATE opportunities SET control_mode_origin = 'a_hunch'
          WHERE workspace_id = $1 AND id = $2`,
        [workspace(f), f.crm.alpha.opportunityId],
      ),
  },
];
