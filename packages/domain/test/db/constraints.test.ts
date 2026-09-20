import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { payloadHash, seedTwoWorkspaces, type TwoWorkspaces } from './support/fixtures.ts';
import { IDENTITY_CONSTRAINT_CASES } from './support/identityCases.ts';
import { CRM_CONSTRAINT_CASES } from './support/crmCases.ts';
import { POLICY_CONSTRAINT_CASES } from './support/policyCases.ts';
import { RESEARCH_CONSTRAINT_CASES } from './support/researchCases.ts';
import { MAIL_CONSTRAINT_CASES } from './support/mailCases.ts';
import { TODAY_CONSTRAINT_CASES } from './support/todayCases.ts';
import { seedCrm, type SeededCrm } from './support/crmFixtures.ts';
import { seedMail, type SeededMail } from './support/mailFixtures.ts';

/**
 * A failing insert for every foundation constraint.
 *
 * The last test in this file is the one that keeps the rest honest: it asks the
 * database for every CHECK, UNIQUE, FOREIGN KEY, PRIMARY KEY, constraint trigger and
 * partial unique index it has, and fails if any of them has no case above. A future
 * migration that adds a constraint without a failing insert cannot pass the gate.
 */

interface Fixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
  readonly holdId: string;
  readonly baseSuppressionEventId: string;
  /**
   * The CRM and mail rows lane G7's cases start from. Seeded once rather than per
   * case: a mailbox is unique per owner, so a case that created its own would
   * spend its first statement inventing a second salesperson.
   */
  readonly crm: SeededCrm;
  readonly mail: SeededMail;
}

interface Case {
  readonly constraint: string;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}

/** The constraint trigger raises restrict_violation rather than naming a constraint. */
const TRIGGER_CONSTRAINT = 'workspace_memberships_last_active_admin';

const workspace = (fixture: Fixture): string => fixture.seeded.alpha.workspaceId;
const admin = (fixture: Fixture): string => fixture.seeded.alpha.admin.userId;
const salesperson = (fixture: Fixture): string => fixture.seeded.alpha.salesperson.userId;
const device = (fixture: Fixture): string => fixture.seeded.alpha.salesperson.deviceId;

const cases: readonly Case[] = [
  // ---------------------------------------------------------------- workspaces
  {
    constraint: 'workspaces_pkey',
    run: async f => {
      const { rows } = await f.session.query<{ id: string }>('SELECT id FROM workspaces LIMIT 1');
      return await f.session.query('INSERT INTO workspaces (id, slug, display_name) VALUES ($1, $2, $3)', [
        rows[0]?.id,
        'another-slug',
        'Another',
      ]);
    },
  },
  {
    constraint: 'workspaces_slug_unique',
    run: async f => await f.session.query("INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Duplicate')"),
  },
  {
    constraint: 'workspaces_slug_shape',
    run: async f => await f.session.query("INSERT INTO workspaces (slug, display_name) VALUES ('Not A Slug', 'x')"),
  },
  {
    constraint: 'workspaces_display_name_present',
    run: async f => await f.session.query("INSERT INTO workspaces (slug, display_name) VALUES ('blank-name', '   ')"),
  },
  {
    constraint: 'workspaces_business_time_zone_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO workspaces (slug, display_name, business_time_zone) VALUES ('bad-zone', 'x', 'EST5EDT?')",
      ),
  },
  {
    constraint: 'workspaces_updated_not_before_created',
    run: async f =>
      await f.session.query(
        "INSERT INTO workspaces (slug, display_name, created_at, updated_at) VALUES ('backdated', 'x', TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')",
      ),
  },

  // -------------------------------------------------------------------- users
  {
    constraint: 'users_pkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO users (id, google_sub, email, display_name) VALUES ($1, $2, $3, $4)',
        [admin(f), 'sub-clash', 'clash@example.test', 'Clash'],
      ),
  },
  {
    constraint: 'users_google_sub_unique',
    run: async f => {
      const { rows } = await f.session.query<{ google_sub: string }>('SELECT google_sub FROM users LIMIT 1');
      return await f.session.query('INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3)', [
        rows[0]?.google_sub,
        'other@example.test',
        'Other',
      ]);
    },
  },
  {
    constraint: 'users_google_sub_present',
    run: async f =>
      await f.session.query("INSERT INTO users (google_sub, email, display_name) VALUES ('  ', 'a@example.test', 'A')"),
  },
  {
    constraint: 'users_email_shape',
    run: async f =>
      await f.session.query("INSERT INTO users (google_sub, email, display_name) VALUES ('sub-a', 'Mixed@Example.test', 'A')"),
  },
  {
    constraint: 'users_display_name_present',
    run: async f =>
      await f.session.query("INSERT INTO users (google_sub, email, display_name) VALUES ('sub-b', 'b@example.test', '')"),
  },

  // ----------------------------------------------------- workspace_memberships
  {
    constraint: 'workspace_memberships_pkey',
    run: async f => {
      const { rows } = await f.session.query<{ id: string }>(
        'SELECT id FROM workspace_memberships WHERE workspace_id = $1 LIMIT 1',
        [workspace(f)],
      );
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-pkey', 'pk@example.test', 'PK') RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, id, user_id, role) VALUES ($1, $2, $3, 'salesperson')",
        [workspace(f), rows[0]?.id, created.rows[0]?.id],
      );
    },
  },
  {
    constraint: 'workspace_memberships_one_per_user',
    run: async f =>
      await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'workspace_memberships_role_known',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-role', 'role@example.test', 'Role') RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'manager')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: 'workspace_memberships_status_known',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-status', 'status@example.test', 'S') RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'salesperson', 'suspended')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: 'workspace_memberships_deactivation_consistent',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-deact', 'd@example.test', 'D') RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role, status, deactivated_at) VALUES ($1, $2, 'salesperson', 'active', now())",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: 'workspace_memberships_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ('00000000-0000-4000-8000-000000000000', $1, 'salesperson')",
        [admin(f)],
      ),
  },
  {
    constraint: 'workspace_memberships_user_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, '00000000-0000-4000-8000-000000000000', 'salesperson')",
        [workspace(f)],
      ),
  },
  {
    constraint: TRIGGER_CONSTRAINT,
    run: async f =>
      await f.session.query(
        "UPDATE workspace_memberships SET status = 'inactive', deactivated_at = now() WHERE workspace_id = $1 AND role = 'admin'",
        [workspace(f)],
      ),
  },

  // ------------------------------------------------------------------ devices
  {
    constraint: 'devices_pkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO devices (workspace_id, id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4, $5)',
        [workspace(f), device(f), salesperson(f), 'Second Mac', payloadHash('pkey')],
      ),
  },
  {
    constraint: 'devices_membership_fkey',
    run: async f =>
      await f.session.query(
        'INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4)',
        [workspace(f), '00000000-0000-4000-8000-000000000000', 'Stranger Mac', payloadHash('fk')],
      ),
  },
  {
    constraint: 'devices_label_present',
    run: async f =>
      await f.session.query(
        'INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4)',
        [workspace(f), admin(f), '  ', payloadHash('label')],
      ),
  },
  {
    constraint: 'devices_secret_hash_shape',
    run: async f =>
      await f.session.query(
        'INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4)',
        [workspace(f), admin(f), 'Plain Mac', 'a-plaintext-device-secret'],
      ),
  },
  {
    constraint: 'devices_credential_generation_positive',
    run: async f =>
      await f.session.query(
        'INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, credential_generation) VALUES ($1, $2, $3, $4, 0)',
        [workspace(f), admin(f), 'Zero Mac', payloadHash('gen')],
      ),
  },
  {
    constraint: 'devices_status_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, status) VALUES ($1, $2, $3, $4, 'suspended')",
        [workspace(f), admin(f), 'Odd Mac', payloadHash('status')],
      ),
  },
  {
    constraint: 'devices_revocation_consistent',
    run: async f =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, status, revoked_at) VALUES ($1, $2, $3, $4, 'active', now())",
        [workspace(f), admin(f), 'Half Revoked Mac', payloadHash('revoke')],
      ),
  },
  {
    constraint: 'devices_client_version_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO devices (workspace_id, user_id, device_label, secret_hash, client_version) VALUES ($1, $2, $3, $4, 'latest')",
        [workspace(f), admin(f), 'Unversioned Mac', payloadHash('version')],
      ),
  },

  // -------------------------------------------------------- calling_identities
  {
    constraint: 'calling_identities_pkey',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550200') RETURNING id",
        [workspace(f), admin(f)],
      );
      return await f.session.query(
        "INSERT INTO calling_identities (workspace_id, id, owner_user_id, e164) VALUES ($1, $2, $3, '+14015550201')",
        [workspace(f), created.rows[0]?.id, admin(f)],
      );
    },
  },
  {
    constraint: 'calling_identities_number_unique',
    run: async f => {
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550202')",
        [workspace(f), admin(f)],
      );
      return await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550202')",
        [workspace(f), salesperson(f)],
      );
    },
  },
  {
    constraint: 'calling_identities_owner_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '+14015550203')",
        [workspace(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: 'calling_identities_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, e164) VALUES ('00000000-0000-4000-8000-000000000000', '+14015550204')",
      ),
  },
  {
    constraint: 'calling_identities_e164_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164) VALUES ($1, $2, '401-555-0205')",
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'calling_identities_verification_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status) VALUES ($1, $2, '+14015550206', 'probably')",
        [workspace(f), admin(f)],
      ),
  },
  {
    // The reserved shared line: a null-owner row may exist, but never enabled.
    constraint: 'calling_identities_shared_line_disabled',
    run: async f =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled) VALUES ($1, NULL, '+14015550207', 'verified', true)",
        [workspace(f)],
      ),
  },
  {
    constraint: 'calling_identities_enabled_requires_verification',
    run: async f =>
      await f.session.query(
        "INSERT INTO calling_identities (workspace_id, owner_user_id, e164, verification_status, enabled) VALUES ($1, $2, '+14015550208', 'unverified', true)",
        [workspace(f), admin(f)],
      ),
  },

  // --------------------------------------------------------- command_receipts
  {
    constraint: 'command_receipts_pkey',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-pkey', 'firm.assign', $3, 'accepted')",
          [workspace(f), device(f), payloadHash('cmd')],
        );
      }
      return null;
    },
  },
  {
    constraint: 'command_receipts_device_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-fk', 'firm.assign', $3, 'accepted')",
        [workspace(f), f.seeded.beta.salesperson.deviceId, payloadHash('cmd')],
      ),
  },
  {
    constraint: 'command_receipts_command_id_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd with spaces', 'firm.assign', $3, 'accepted')",
        [workspace(f), device(f), payloadHash('cmd')],
      ),
  },
  {
    constraint: 'command_receipts_kind_present',
    run: async f =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-kind', '  ', $3, 'accepted')",
        [workspace(f), device(f), payloadHash('cmd')],
      ),
  },
  {
    constraint: 'command_receipts_payload_hash_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-hash', 'firm.assign', 'not-a-hash', 'accepted')",
        [workspace(f), device(f)],
      ),
  },
  {
    constraint: 'command_receipts_result_status_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status) VALUES ($1, $2, 'cmd-status', 'firm.assign', $3, 'maybe')",
        [workspace(f), device(f), payloadHash('cmd')],
      ),
  },
  {
    constraint: 'command_receipts_dial_result_not_actionable',
    run: async f =>
      await f.session.query(
        `INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status, result)
         VALUES ($1, $2, 'cmd-dial', 'authorize_dial', $3, 'accepted', '{"ticket":"replayed"}'::jsonb)`,
        [workspace(f), device(f), payloadHash('cmd')],
      ),
  },

  // ------------------------------------------------------------- audit_events
  {
    constraint: 'audit_events_pkey',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'system', 'a', 'workspace') RETURNING id",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO audit_events (workspace_id, id, actor_kind, action, subject_kind) VALUES ($1, $2, 'system', 'b', 'workspace')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: 'audit_events_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ('00000000-0000-4000-8000-000000000000', 'system', 'a', 'workspace')",
      ),
  },
  {
    constraint: 'audit_events_actor_user_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, actor_user_id, action, subject_kind) VALUES ($1, 'user', '00000000-0000-4000-8000-000000000000', 'a', 'workspace')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'audit_events_actor_kind_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'robot', 'a', 'workspace')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'audit_events_user_actor_identified',
    run: async f =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'user', 'a', 'workspace')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'audit_events_action_present',
    run: async f =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'system', '   ', 'workspace')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'audit_events_subject_kind_present',
    run: async f =>
      await f.session.query(
        "INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind) VALUES ($1, 'system', 'a', '')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'audit_events_detail_is_object',
    run: async f =>
      await f.session.query(
        `INSERT INTO audit_events (workspace_id, actor_kind, action, subject_kind, detail) VALUES ($1, 'system', 'a', 'workspace', '"a string"'::jsonb)`,
        [workspace(f)],
      ),
  },

  // -------------------------------------------------------- suppression_events
  {
    constraint: 'suppression_events_pkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, $2, 'handle', 'x@example.test', 'v1', 'import')",
        [workspace(f), f.baseSuppressionEventId],
      ),
  },
  {
    constraint: 'suppression_events_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ('00000000-0000-4000-8000-000000000000', 'e-ws', 'handle', 'x@example.test', 'v1', 'import')",
      ),
  },
  {
    constraint: 'suppression_events_actor_user_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id) VALUES ($1, 'e-actor', 'handle', 'x@example.test', 'v1', 'salesperson_manual', '00000000-0000-4000-8000-000000000000')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'suppression_events_scope_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'e-scope', 'domain', 'example.test', 'v1', 'import')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'suppression_events_canonical_key_present',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'e-key', 'handle', 'Mixed@Example.test', 'v1', 'import')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'suppression_events_canonicalizer_version_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'e-canon', 'handle', 'x@example.test', 'Version One', 'import')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'suppression_events_source_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'e-source', 'handle', 'x@example.test', 'v1', 'a_hunch')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'suppression_events_supersession_consistent',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id, supersession_reason) VALUES ($1, 'e-cons', 'handle', 'x@example.test', 'v1', 'import', $2, 'correction')",
        [workspace(f), f.baseSuppressionEventId],
      ),
  },
  {
    constraint: 'suppression_events_supersession_reason_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id, supersession_reason) VALUES ($1, 'e-reason', 'handle', 'x@example.test', 'v1', 'admin_supersession', $2, 'changed_my_mind')",
        [workspace(f), f.baseSuppressionEventId],
      ),
  },
  {
    constraint: 'suppression_events_supersession_reason_required',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id) VALUES ($1, 'e-req', 'handle', 'x@example.test', 'v1', 'admin_supersession', $2)",
        [workspace(f), f.baseSuppressionEventId],
      ),
  },
  {
    constraint: 'suppression_events_superseded_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id, supersession_reason) VALUES ($1, 'e-missing', 'handle', 'x@example.test', 'v1', 'admin_supersession', 'no-such-event', 'correction')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'suppression_events_one_direct_supersession',
    run: async f => {
      // The canonical key matches the base event's on purpose: migration 0006's
      // `suppression_events_supersession_same_key` trigger refuses a supersession
      // that changes it, and would otherwise fire on the *first* insert here and
      // hide the unique index this case is about.
      for (const id of ['e-first-supersession', 'e-second-supersession']) {
        await f.session.query(
          "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, supersedes_event_id, supersession_reason) VALUES ($1, $2, 'handle', 'base@example.test', 'v1', 'admin_supersession', $3, 'correction')",
          [workspace(f), id, f.baseSuppressionEventId],
        );
      }
      return null;
    },
  },

  // -------------------------------------------------------------- active_holds
  {
    constraint: 'active_holds_pkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, $2, 'firm', 'firm-2', 'uncertain_reply', ARRAY['email_send'], 'message')",
        [workspace(f), f.holdId],
      ),
  },
  {
    constraint: 'active_holds_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ('00000000-0000-4000-8000-000000000000', 'firm', 'firm-1', 'uncertain_reply', ARRAY['email_send'], 'message')",
      ),
  },
  {
    constraint: 'active_holds_reason_code_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'firm', 'firm-1', 'a_bad_feeling', ARRAY['email_send'], 'message')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'active_holds_scope_kind_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'universe', 'x', 'uncertain_reply', ARRAY['email_send'], 'message')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'active_holds_workspace_scope_has_no_key',
    run: async f =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'workspace', 'firm-1', 'scoped_pause', ARRAY['email_send'], 'pause')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'active_holds_blocked_action_kinds_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', ARRAY['send_a_pigeon'], 'message')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'active_holds_source_event_kind_present',
    run: async f =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', ARRAY['email_send'], '  ')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'active_holds_release_not_before_start',
    run: async f =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, started_at, released_at) VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', ARRAY['email_send'], 'message', TIMESTAMPTZ '2026-03-01 00:00:00+00', TIMESTAMPTZ '2026-02-01 00:00:00+00')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'active_holds_recovery_action_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds, source_event_kind, recovery_action) VALUES ($1, 'firm', 'firm-1', 'uncertain_reply', ARRAY['email_send'], 'message', 'just_send_it')",
        [workspace(f)],
      ),
  },

  // ------------------------------------------------------ administrative_pauses
  {
    constraint: 'administrative_pauses_pkey',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', $2, $3) RETURNING id",
        [workspace(f), f.holdId, admin(f)],
      );
      return await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, $2, 'workspace', 'scoped_pause', $3, $4)",
        [workspace(f), created.rows[0]?.id, f.holdId, admin(f)],
      );
    },
  },
  {
    constraint: 'administrative_pauses_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ('00000000-0000-4000-8000-000000000000', 'workspace', 'scoped_pause', $1, $2)",
        [f.holdId, admin(f)],
      ),
  },
  {
    constraint: 'administrative_pauses_reason_code_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'because_i_said_so', $2, $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: 'administrative_pauses_hold_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', '00000000-0000-4000-8000-000000000000', $2)",
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'administrative_pauses_creator_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: 'administrative_pauses_releaser_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id, released_by_user_id, released_at) VALUES ($1, 'workspace', 'scoped_pause', $2, $3, $4, now())",
        [workspace(f), f.holdId, admin(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: 'administrative_pauses_scope_kind_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, scope_key, reason_code, hold_id, created_by_user_id) VALUES ($1, 'galaxy', 'x', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: 'administrative_pauses_scope_key_required',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id) VALUES ($1, 'owner', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: 'administrative_pauses_channel_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, scope_key, channel, reason_code, hold_id, created_by_user_id) VALUES ($1, 'channel', 'all', 'carrier_pigeon', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: 'administrative_pauses_channel_scope_consistent',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, scope_key, channel, reason_code, hold_id, created_by_user_id) VALUES ($1, 'owner', $4, 'email', 'scoped_pause', $2, $3)",
        [workspace(f), f.holdId, admin(f), admin(f)],
      ),
  },
  {
    constraint: 'administrative_pauses_reason_note_bounded',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, reason_note, hold_id, created_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', $4, $2, $3)",
        [workspace(f), f.holdId, admin(f), 'x'.repeat(501)],
      ),
  },
  {
    constraint: 'administrative_pauses_release_consistent',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id, released_at) VALUES ($1, 'workspace', 'scoped_pause', $2, $3, now())",
        [workspace(f), f.holdId, admin(f)],
      ),
  },
  {
    constraint: 'administrative_pauses_release_not_before_create',
    run: async f =>
      await f.session.query(
        "INSERT INTO administrative_pauses (workspace_id, scope_kind, reason_code, hold_id, created_by_user_id, created_at, released_at, released_by_user_id) VALUES ($1, 'workspace', 'scoped_pause', $2, $3, TIMESTAMPTZ '2026-03-01 00:00:00+00', TIMESTAMPTZ '2026-02-01 00:00:00+00', $3)",
        [workspace(f), f.holdId, admin(f)],
      ),
  },

  // -------------------------------------------------------- system_generations
  {
    constraint: 'system_generations_pkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO system_generations (generation, reason, established_at, established_by_user_id) VALUES (1, 'operator_advance', now(), $1)",
        [admin(f)],
      ),
  },
  {
    constraint: 'system_generations_established_by_user_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO system_generations (generation, reason, established_at, established_by_user_id) VALUES (2, 'operator_advance', now(), '00000000-0000-4000-8000-000000000000')",
      ),
  },
  {
    constraint: 'system_generations_generation_positive',
    run: async f =>
      await f.session.query(
        "INSERT INTO system_generations (generation, reason, established_at, established_by_user_id) VALUES (0, 'operator_advance', now(), $1)",
        [admin(f)],
      ),
  },
  {
    constraint: 'system_generations_reason_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO system_generations (generation, reason, established_at, established_by_user_id) VALUES (3, 'felt_like_it', now(), $1)",
        [admin(f)],
      ),
  },
  {
    constraint: 'system_generations_operator_advance_attributed',
    run: async f =>
      await f.session.query(
        "INSERT INTO system_generations (generation, reason, established_at) VALUES (4, 'restore_completed', now())",
      ),
  },
  {
    constraint: 'system_generations_notes_bounded',
    run: async f =>
      await f.session.query(
        "INSERT INTO system_generations (generation, reason, established_at, established_by_user_id, notes) VALUES (5, 'operator_advance', now(), $1, $2)",
        [admin(f), 'n'.repeat(1001)],
      ),
  },

  // -------------------------------------------------------- retention_policies
  {
    constraint: 'retention_policies_pkey',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'raw_mime', 'delete', INTERVAL '7 days', now()) RETURNING id",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO retention_policies (workspace_id, id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, $2, 'operational_logs', 'delete', INTERVAL '90 days', now())",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: 'retention_policies_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ('00000000-0000-4000-8000-000000000000', 'raw_mime', 'delete', INTERVAL '7 days', now())",
      ),
  },
  {
    constraint: 'retention_policies_one_per_kind',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'canceled_drafts', 'delete', INTERVAL '30 days', now())",
          [workspace(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: 'retention_policies_data_kind_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'everything', 'delete', INTERVAL '1 day', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: 'retention_policies_disposition_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'raw_mime', 'shred', INTERVAL '1 day', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: 'retention_policies_interval_consistent',
    run: async f =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, effective_from) VALUES ($1, 'raw_mime', 'delete', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: 'retention_policies_interval_positive',
    run: async f =>
      await f.session.query(
        "INSERT INTO retention_policies (workspace_id, data_kind, disposition, retention_interval, effective_from) VALUES ($1, 'unmatched_gmail_metadata', 'delete', INTERVAL '0', now())",
        [workspace(f)],
      ),
  },

  // --------------------------------------------------------------------- jobs
  {
    constraint: 'jobs_pkey',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'today.build', '{}'::jsonb, 'today:a') RETURNING id",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO jobs (workspace_id, id, kind, payload, idempotency_key) VALUES ($1, $2, 'today.build', '{}'::jsonb, 'today:b')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: 'jobs_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ('00000000-0000-4000-8000-000000000000', 'today.build', '{}'::jsonb, 'today:c')",
      ),
  },
  {
    constraint: 'jobs_idempotent',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'mail.sync', '{}'::jsonb, 'mail-sync:same')",
          [workspace(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: 'jobs_kind_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'Today Build', '{}'::jsonb, 'today:d')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_payload_is_object',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'today.build', '[]'::jsonb, 'today:e')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_idempotency_key_present',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'today.build', '{}'::jsonb, '   ')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_state_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state) VALUES ($1, 'today.build', '{}'::jsonb, 'today:f', 'thinking')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_attempts_sane',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, attempt_count, max_attempts) VALUES ($1, 'today.build', '{}'::jsonb, 'today:g', 11, 10)",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_lease_consistent',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state) VALUES ($1, 'today.build', '{}'::jsonb, 'today:h', 'running')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_lease_owner_bounded',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state, lease_owner, lease_expires_at) VALUES ($1, 'today.build', '{}'::jsonb, 'today:i', 'running', '  ', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_error_detail_bounded',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, error_detail) VALUES ($1, 'today.build', '{}'::jsonb, 'today:j', $2)",
        [workspace(f), 'e'.repeat(2001)],
      ),
  },

  // ----------------------------------------------------------- daily_counters
  {
    constraint: 'daily_counters_pkey',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'mailbox', 'mailbox-1', 'automated_sends', DATE '2026-09-19', 'America/New_York')",
          [workspace(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: 'daily_counters_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ('00000000-0000-4000-8000-000000000000', 'mailbox', 'mailbox-1', 'automated_sends', DATE '2026-09-19', 'America/New_York')",
      ),
  },
  {
    constraint: 'daily_counters_subject_kind_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'firm', 'firm-1', 'automated_sends', DATE '2026-09-19', 'America/New_York')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'daily_counters_subject_key_present',
    run: async f =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'mailbox', '  ', 'automated_sends', DATE '2026-09-19', 'America/New_York')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'daily_counters_counter_kind_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'mailbox', 'mailbox-2', 'Automated Sends', DATE '2026-09-19', 'America/New_York')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'daily_counters_count_nonnegative',
    run: async f =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone, count) VALUES ($1, 'mailbox', 'mailbox-3', 'automated_sends', DATE '2026-09-19', 'America/New_York', -1)",
        [workspace(f)],
      ),
  },
  {
    constraint: 'daily_counters_business_time_zone_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO daily_counters (workspace_id, subject_kind, subject_key, counter_kind, business_date, business_time_zone) VALUES ($1, 'mailbox', 'mailbox-4', 'automated_sends', DATE '2026-09-19', 'Eastern Time')",
        [workspace(f)],
      ),
  },

  // --------------------------------------------------------------- heartbeats
  {
    constraint: 'heartbeats_pkey',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('api', 'api-1', now()) RETURNING id",
      );
      return await f.session.query(
        "INSERT INTO heartbeats (id, component, instance_key, observed_at) VALUES ($1, 'api', 'api-2', now())",
        [created.rows[0]?.id],
      );
    },
  },
  {
    constraint: 'heartbeats_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO heartbeats (workspace_id, component, instance_key, observed_at) VALUES ('00000000-0000-4000-8000-000000000000', 'mailbox', 'mailbox-1', now())",
      ),
  },
  {
    // NULLS NOT DISTINCT: two api heartbeats with no workspace still collide.
    constraint: 'heartbeats_identity',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('scheduler', 'scheduler-1', now())",
        );
      }
      return null;
    },
  },
  {
    constraint: 'heartbeats_component_known',
    run: async f =>
      await f.session.query("INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('desktop', 'mac-1', now())"),
  },
  {
    constraint: 'heartbeats_mailbox_is_workspace_scoped',
    run: async f =>
      await f.session.query("INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('mailbox', 'mailbox-9', now())"),
  },
  {
    constraint: 'heartbeats_instance_key_present',
    run: async f =>
      await f.session.query("INSERT INTO heartbeats (component, instance_key, observed_at) VALUES ('worker', '   ', now())"),
  },
  {
    constraint: 'heartbeats_detail_is_object',
    run: async f =>
      await f.session.query(
        "INSERT INTO heartbeats (component, instance_key, observed_at, detail) VALUES ('worker', 'worker-2', now(), '42'::jsonb)",
      ),
  },

  // --------------------------------------------------------- hold_reason_codes
  {
    constraint: 'hold_reason_codes_pkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO hold_reason_codes (code, description, recoverable) VALUES ('dead_job', 'duplicate', true)",
      ),
  },
  {
    constraint: 'hold_reason_codes_code_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO hold_reason_codes (code, description, recoverable) VALUES ('Dead Job', 'x', true)",
      ),
  },
  {
    constraint: 'hold_reason_codes_description_present',
    run: async f =>
      await f.session.query(
        "INSERT INTO hold_reason_codes (code, description, recoverable) VALUES ('new_code', '   ', true)",
      ),
  },

  // ------------------------------------------------------- jobs (migration 0002)
  {
    constraint: 'jobs_fencing_token_nonnegative',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, fencing_token) VALUES ($1, 'canary', '{}'::jsonb, 'canary:fence', -1)",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_requeued_count_nonnegative',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, requeued_count) VALUES ($1, 'canary', '{}'::jsonb, 'canary:requeued', -1)",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_error_code_shape',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, error_code) VALUES ($1, 'canary', '{}'::jsonb, 'canary:code', 'Provider Refused')",
        [workspace(f)],
      ),
  },
  {
    // NOT VALID, so migration 0001's rows are untouched; every new write is checked.
    constraint: 'jobs_completed_at_consistent',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state) VALUES ($1, 'canary', '{}'::jsonb, 'canary:done', 'done')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'jobs_dead_at_consistent',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state) VALUES ($1, 'canary', '{}'::jsonb, 'canary:dead', 'dead')",
        [workspace(f)],
      ),
  },
  {
    // A dead job keeps its payload: an audited admin requeue has to have one to run.
    constraint: 'jobs_payload_archived_only_when_done',
    run: async f =>
      await f.session.query(
        "INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, payload_archived_at) VALUES ($1, 'canary', '{}'::jsonb, 'canary:archived', now())",
        [workspace(f)],
      ),
  },

  // ------------------------------------------------- heartbeats (migration 0002)
  {
    constraint: 'heartbeats_expected_interval_positive',
    run: async f =>
      await f.session.query(
        "INSERT INTO heartbeats (component, instance_key, observed_at, expected_interval_seconds) VALUES ('worker', 'worker-interval', now(), 0)",
      ),
  },

  // ------------------------------------------------ canary_runs (migration 0002)
  {
    constraint: 'canary_runs_pkey',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          "INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:00:00+00')",
          [workspace(f)],
        );
      }
      return null;
    },
  },
  {
    constraint: 'canary_runs_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ('00000000-0000-4000-8000-000000000000', TIMESTAMPTZ '2026-09-21 14:00:00+00')",
      ),
  },
  {
    constraint: 'canary_runs_quarter_hour_aligned',
    run: async f =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:07:00+00')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'canary_runs_completed_after_insert',
    run: async f =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour, completed_at, completed_by) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:15:00+00', now() - INTERVAL '1 day', 'worker-1')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'canary_runs_completion_attributed',
    run: async f =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour, completed_at) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:30:00+00', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: 'canary_runs_completed_by_bounded',
    run: async f =>
      await f.session.query(
        "INSERT INTO canary_runs (workspace_id, quarter_hour, completed_at, completed_by) VALUES ($1, TIMESTAMPTZ '2026-09-21 14:45:00+00', now(), '   ')",
        [workspace(f)],
      ),
  },

  // -------------------------------------------- critical_alerts (migration 0002)
  {
    constraint: 'critical_alerts_pkey',
    run: async f => {
      const created = await f.session.query<{ id: string }>(
        "INSERT INTO critical_alerts (workspace_id, alert_key) VALUES ($1, 'canary_stale') RETURNING id",
        [workspace(f)],
      );
      return await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, id, alert_key) VALUES ($1, $2, 'dead_job_unresolved')",
        [workspace(f), created.rows[0]?.id],
      );
    },
  },
  {
    constraint: 'critical_alerts_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key) VALUES ('00000000-0000-4000-8000-000000000000', 'canary_stale')",
      ),
  },
  {
    // The acknowledger must be a member of this workspace: the composite key is what
    // stops another workspace's admin silencing this one's alert.
    constraint: 'critical_alerts_acknowledger_fkey',
    run: async f =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, acknowledged_at, acknowledged_by_user_id) VALUES ($1, 'canary_stale', now(), $2)",
        [workspace(f), f.seeded.beta.admin.userId],
      ),
  },
  {
    constraint: 'critical_alerts_key_shape',
    run: async f =>
      await f.session.query("INSERT INTO critical_alerts (workspace_id, alert_key) VALUES ($1, 'Canary Stale')", [
        workspace(f),
      ]),
  },
  {
    constraint: 'critical_alerts_severity_known',
    run: async f =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, severity) VALUES ($1, 'canary_stale', 'info')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'critical_alerts_detail_is_object',
    run: async f =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, detail) VALUES ($1, 'canary_stale', '42'::jsonb)",
        [workspace(f)],
      ),
  },
  {
    constraint: 'critical_alerts_acknowledgement_attributed',
    run: async f =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, acknowledged_at) VALUES ($1, 'canary_stale', now())",
        [workspace(f)],
      ),
  },
  {
    constraint: 'critical_alerts_acknowledged_after_raise',
    run: async f =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, acknowledged_at, acknowledged_by_user_id) VALUES ($1, 'canary_stale', now() - INTERVAL '1 day', $2)",
        [workspace(f), admin(f)],
      ),
  },
  {
    constraint: 'critical_alerts_resolved_after_raise',
    run: async f =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, resolved_at) VALUES ($1, 'canary_stale', now() - INTERVAL '1 day')",
        [workspace(f)],
      ),
  },
  {
    constraint: 'critical_alerts_observed_after_raise',
    run: async f =>
      await f.session.query(
        "INSERT INTO critical_alerts (workspace_id, alert_key, last_observed_at) VALUES ($1, 'canary_stale', now() - INTERVAL '1 day')",
        [workspace(f)],
      ),
  },
  {
    // The partial unique index: one open alert per key, so a recurring condition
    // updates the open row rather than filling the table.
    constraint: 'critical_alerts_one_open_per_key',
    run: async f => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query("INSERT INTO critical_alerts (workspace_id, alert_key) VALUES ($1, 'canary_stale')", [
          workspace(f),
        ]);
      }
      return null;
    },
  },

  // Later migrations bring their cases in from their own file, so two lanes adding a
  // migration at the same time never both edit the middle of this array.
  ...IDENTITY_CONSTRAINT_CASES,
  ...CRM_CONSTRAINT_CASES,
  ...POLICY_CONSTRAINT_CASES,
  ...RESEARCH_CONSTRAINT_CASES,
  ...MAIL_CONSTRAINT_CASES,
  ...TODAY_CONSTRAINT_CASES,
];


describe('foundation constraints', () => {
  let database: TestDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createTestDatabase();
    const seeded = await seedTwoWorkspaces(database.session);
    const hold = await database.session.query<{ id: string }>(
      "INSERT INTO active_holds (workspace_id, scope_kind, reason_code, blocked_action_kinds, source_event_kind) VALUES ($1, 'workspace', 'scoped_pause', ARRAY['email_send'], 'pause') RETURNING id",
      [seeded.alpha.workspaceId],
    );
    await database.session.query(
      "INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source) VALUES ($1, 'base-event', 'handle', 'base@example.test', 'v1', 'prospect_opt_out')",
      [seeded.alpha.workspaceId],
    );
    const crm = await seedCrm(database.session, seeded);
    const mail = await seedMail(database.session, seeded, crm);
    fixture = {
      session: database.session,
      seeded,
      holdId: hold.rows[0]?.id ?? '',
      baseSuppressionEventId: 'base-event',
      crm,
      mail,
    };
  });

  afterAll(async () => {
    await database.drop();
  });

  it.each(cases.map(testCase => [testCase.constraint, testCase] as const))(
    'refuses the insert that would break %s',
    async (name, testCase) => {
      await fixture.session.query('BEGIN');
      let thrown: unknown = null;
      try {
        await testCase.run(fixture);
      } catch (error) {
        thrown = error;
      } finally {
        await fixture.session.query('ROLLBACK');
      }
      expect(thrown, `${name} accepted a row it should have refused`).not.toBeNull();
      if (name === TRIGGER_CONSTRAINT) {
        // The constraint trigger raises restrict_violation; it names no constraint.
        expect(thrown).toMatchObject({ code: '23001' });
        expect(String((thrown as { message?: string }).message)).toContain('without an active admin');
        return;
      }
      expect(thrown).toMatchObject({ constraint: name });
    },
  );

  it('has a case for every constraint the database enforces', async () => {
    const constraints = await database.session.query<{ name: string }>(`
      SELECT c.conname AS name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public'
         -- 'x' is the exclusion constraint migration 0006 added for state postures.
         -- It was absent from this list until then, so nothing was uncovered by it;
         -- leaving it out now would have let an exclusion constraint ship untested.
         AND c.contype IN ('c', 'u', 'f', 'p', 't', 'x')
         AND t.relname <> 'schema_versions'
    `);
    const partialUniqueIndexes = await database.session.query<{ name: string }>(`
      SELECT ci.relname AS name
        FROM pg_index i
        JOIN pg_class ci ON ci.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE i.indisunique AND i.indpred IS NOT NULL AND n.nspname = 'public'
    `);

    const enforced = new Set([
      ...constraints.rows.map(row => row.name),
      ...partialUniqueIndexes.rows.map(row => row.name),
    ]);
    const covered = new Set(cases.map(testCase => testCase.constraint));

    const uncovered = [...enforced].filter(name => !covered.has(name)).sort();
    expect(uncovered, 'every enforced constraint needs a failing insert above').toEqual([]);

    const stale = [...covered].filter(name => !enforced.has(name)).sort();
    expect(stale, 'a case names a constraint the database does not have').toEqual([]);
  });
});
