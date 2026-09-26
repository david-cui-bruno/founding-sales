import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';

/**
 * A failing insert for every constraint migration 0004 adds (firms,
 * contacts, routes, evidence, pipeline stages, opportunities, stage history, aliases,
 * merges and the CRM domain-event outbox).
 *
 * They live in their own file, appended to `cases` in constraints.test.ts, so two
 * lanes adding migrations at the same time do not both edit the middle of that array.
 * The coverage test at the bottom of constraints.test.ts is what makes them
 * mandatory: a constraint with no case here fails the build.
 *
 * Each case runs inside a transaction the caller rolls back, so a case may create the
 * rows it needs and then break exactly one thing. "Exactly one" matters: a row that
 * breaks two constraints is reported under whichever index or check PostgreSQL
 * reaches first, and the case would be testing the wrong promise.
 *
 * No real business name, address or number appears here.
 */

export interface CrmCaseFixture {
  readonly session: SessionQueryable;
  readonly seeded: TwoWorkspaces;
}

export interface CrmCase {
  readonly constraint: string;
  readonly run: (fixture: CrmCaseFixture) => Promise<unknown>;
}

const workspace = (f: CrmCaseFixture): string => f.seeded.alpha.workspaceId;
const otherWorkspaceUser = (f: CrmCaseFixture): string => f.seeded.beta.salesperson.userId;

/** A syntactically valid UUID that is never a row. */
const MISSING = '00000000-0000-4000-8000-000000000000';
const HASH = 'a'.repeat(64);

let sequence = 0;
/** A name or key that is unique within one case run, so a case never trips uniqueness by accident. */
const unique = (prefix: string): string => {
  sequence += 1;
  return `${prefix}${String(sequence)}`;
};

async function aFirm(f: CrmCaseFixture, name = 'Case Test Firm'): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    'INSERT INTO firms (workspace_id, name) VALUES ($1, $2) RETURNING id',
    [workspace(f), unique(`${name} `)],
  );
  return rows[0]?.id ?? '';
}

async function aContact(
  f: CrmCaseFixture,
  firmId: string,
  options: { readonly isPrimary?: boolean } = {},
): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    'INSERT INTO contacts (workspace_id, firm_id, full_name, is_primary) VALUES ($1, $2, $3, $4) RETURNING id',
    [workspace(f), firmId, unique('Case Contact '), options.isPrimary ?? false],
  );
  return rows[0]?.id ?? '';
}

async function aStage(f: CrmCaseFixture, key: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    'SELECT id FROM pipeline_stages WHERE workspace_id = $1 AND key = $2',
    [workspace(f), key],
  );
  return rows[0]?.id ?? '';
}

async function anOpportunity(f: CrmCaseFixture, firmId: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [workspace(f), firmId, await aStage(f, 'new')],
  );
  return rows[0]?.id ?? '';
}

async function aStageEvent(f: CrmCaseFixture, opportunityId: string, firmId: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind)
     VALUES ($1, $2, $3, $4, 'system') RETURNING id`,
    [workspace(f), opportunityId, firmId, await aStage(f, 'new')],
  );
  return rows[0]?.id ?? '';
}

/** A well-formed phone route, so a case changes only the one column it is about. */
async function aPhoneRoute(f: CrmCaseFixture, firmId: string, e164: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at)
     VALUES ($1, $2, $3, 'salesperson', now()) RETURNING id`,
    [workspace(f), firmId, e164],
  );
  return rows[0]?.id ?? '';
}

async function anEmailRoute(f: CrmCaseFixture, firmId: string, address: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at)
     VALUES ($1, $2, $3, 'salesperson', now()) RETURNING id`,
    [workspace(f), firmId, address],
  );
  return rows[0]?.id ?? '';
}

async function anEvidenceItem(f: CrmCaseFixture, firmId: string, contentHash: string): Promise<string> {
  const { rows } = await f.session.query<{ id: string }>(
    `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash)
     VALUES ($1, $2, 'places', 'ref', $3) RETURNING id`,
    [workspace(f), firmId, contentHash],
  );
  return rows[0]?.id ?? '';
}

export const CRM_CONSTRAINT_CASES: readonly CrmCase[] = [
  // ------------------------------------------------------------------ firms
  {
    constraint: 'firms_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      return await f.session.query('INSERT INTO firms (workspace_id, id, name) VALUES ($1, $2, $3)', [
        workspace(f),
        firmId,
        'Duplicate id',
      ]);
    },
  },
  {
    constraint: 'firms_workspace_id_fkey',
    run: async f =>
      await f.session.query('INSERT INTO firms (workspace_id, name) VALUES ($1, $2)', [MISSING, 'Nowhere']),
  },
  {
    constraint: 'firms_assignee_fkey',
    run: async f =>
      await f.session.query('INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3)', [
        workspace(f),
        'Borrowed Assignee',
        otherWorkspaceUser(f),
      ]),
  },
  {
    constraint: 'firms_merged_into_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      return await f.session.query(
        "UPDATE firms SET status = 'merged', merged_into_firm_id = $3 WHERE workspace_id = $1 AND id = $2",
        [workspace(f), firmId, MISSING],
      );
    },
  },
  {
    constraint: 'firms_name_present',
    run: async f =>
      await f.session.query('INSERT INTO firms (workspace_id, name) VALUES ($1, $2)', [workspace(f), '   ']),
  },
  {
    constraint: 'firms_website_shape',
    run: async f =>
      await f.session.query('INSERT INTO firms (workspace_id, name, website) VALUES ($1, $2, $3)', [
        workspace(f),
        'Bad Website',
        'ftp://example.test',
      ]),
  },
  {
    constraint: 'firms_address_line_bounded',
    run: async f =>
      await f.session.query('INSERT INTO firms (workspace_id, name, address_line) VALUES ($1, $2, $3)', [
        workspace(f),
        'Blank Address',
        '   ',
      ]),
  },
  {
    constraint: 'firms_locality_bounded',
    run: async f =>
      await f.session.query('INSERT INTO firms (workspace_id, name, locality) VALUES ($1, $2, $3)', [
        workspace(f),
        'Blank Locality',
        '   ',
      ]),
  },
  {
    constraint: 'firms_region_code_shape',
    run: async f =>
      await f.session.query('INSERT INTO firms (workspace_id, name, region_code) VALUES ($1, $2, $3)', [
        workspace(f),
        'Lower-case State',
        'ri',
      ]),
  },
  {
    constraint: 'firms_postal_code_shape',
    run: async f =>
      await f.session.query('INSERT INTO firms (workspace_id, name, postal_code) VALUES ($1, $2, $3)', [
        workspace(f),
        'Bad Postal Code',
        '@@',
      ]),
  },
  {
    constraint: 'firms_country_code_shape',
    run: async f =>
      await f.session.query('INSERT INTO firms (workspace_id, name, country_code) VALUES ($1, $2, $3)', [
        workspace(f),
        'Three-letter Country',
        'usa',
      ]),
  },
  {
    constraint: 'firms_time_zone_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO firms (workspace_id, name, time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
         VALUES ($1, 'Bad Zone', 'Nowhere?', 'high', 'recorded', 'firm-zone.1')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'firms_time_zone_confidence_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO firms (workspace_id, name, time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
         VALUES ($1, 'Certain Zone', 'America/New_York', 'certain', 'recorded', 'firm-zone.1')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'firms_time_zone_source_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO firms (workspace_id, name, time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
         VALUES ($1, 'Guessed Zone', 'America/New_York', 'high', 'guess', 'firm-zone.1')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'firms_zone_provenance_complete',
    run: async f =>
      await f.session.query(
        `INSERT INTO firms (workspace_id, name, time_zone, time_zone_confidence, time_zone_rule_version)
         VALUES ($1, 'Sourceless Zone', 'America/New_York', 'high', 'firm-zone.1')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'firms_zone_unresolved_reason_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO firms (workspace_id, name, time_zone_unresolved_reason, time_zone_rule_version)
         VALUES ($1, 'Invented Reason', 'because', 'firm-zone.1')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'firms_zone_resolution_exclusive',
    run: async f =>
      await f.session.query(
        `INSERT INTO firms (workspace_id, name, time_zone, time_zone_confidence, time_zone_source,
                            time_zone_unresolved_reason, time_zone_rule_version)
         VALUES ($1, 'Both Ways', 'America/New_York', 'high', 'recorded', 'no_location', 'firm-zone.1')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'firms_zone_rule_version_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO firms (workspace_id, name, time_zone, time_zone_confidence, time_zone_source)
         VALUES ($1, 'Unversioned Zone', 'America/New_York', 'high', 'recorded')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'firms_status_known',
    run: async f =>
      await f.session.query("INSERT INTO firms (workspace_id, name, status) VALUES ($1, 'Archived', 'archived')", [
        workspace(f),
      ]),
  },
  {
    constraint: 'firms_merge_consistent',
    run: async f =>
      await f.session.query("INSERT INTO firms (workspace_id, name, status) VALUES ($1, 'Merged Nowhere', 'merged')", [
        workspace(f),
      ]),
  },
  {
    constraint: 'firms_not_merged_into_self',
    run: async f => {
      const firmId = await aFirm(f);
      return await f.session.query(
        "UPDATE firms SET status = 'merged', merged_into_firm_id = id WHERE workspace_id = $1 AND id = $2",
        [workspace(f), firmId],
      );
    },
  },
  {
    constraint: 'firms_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO firms (workspace_id, name, created_at, updated_at)
         VALUES ($1, 'Backdated', TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
        [workspace(f)],
      ),
  },

  // --------------------------------------------------------------- contacts
  {
    // A duplicate at the same firm breaks the semantic key, whose index is the older
    // of the two and is therefore the one PostgreSQL names.
    constraint: 'contacts_semantic_key',
    run: async f => {
      const firmId = await aFirm(f);
      const contactId = await aContact(f, firmId);
      return await f.session.query(
        'INSERT INTO contacts (workspace_id, id, firm_id, full_name) VALUES ($1, $2, $3, $4)',
        [workspace(f), contactId, firmId, 'Duplicate at the same firm'],
      );
    },
  },
  {
    // The same contact id at a *different* firm leaves the semantic key intact, so
    // only the primary key can fire.
    constraint: 'contacts_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirmId = await aFirm(f);
      const contactId = await aContact(f, firmId);
      return await f.session.query(
        'INSERT INTO contacts (workspace_id, id, firm_id, full_name) VALUES ($1, $2, $3, $4)',
        [workspace(f), contactId, otherFirmId, 'Duplicate id at another firm'],
      );
    },
  },
  {
    constraint: 'contacts_firm_fkey',
    run: async f =>
      await f.session.query('INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3)', [
        workspace(f),
        MISSING,
        'Firmless',
      ]),
  },
  {
    constraint: 'contacts_merged_into_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const contactId = await aContact(f, firmId);
      return await f.session.query(
        "UPDATE contacts SET status = 'merged', merged_into_contact_id = $3 WHERE workspace_id = $1 AND id = $2",
        [workspace(f), contactId, MISSING],
      );
    },
  },
  {
    constraint: 'contacts_one_active_primary',
    run: async f => {
      const firmId = await aFirm(f);
      await aContact(f, firmId, { isPrimary: true });
      return await f.session.query(
        'INSERT INTO contacts (workspace_id, firm_id, full_name, is_primary) VALUES ($1, $2, $3, true)',
        [workspace(f), firmId, 'Second primary'],
      );
    },
  },
  {
    constraint: 'contacts_full_name_present',
    run: async f =>
      await f.session.query('INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, $3)', [
        workspace(f),
        await aFirm(f),
        '   ',
      ]),
  },
  {
    constraint: 'contacts_title_bounded',
    run: async f =>
      await f.session.query('INSERT INTO contacts (workspace_id, firm_id, full_name, title) VALUES ($1, $2, $3, $4)', [
        workspace(f),
        await aFirm(f),
        'Blank Title',
        '   ',
      ]),
  },
  {
    constraint: 'contacts_status_known',
    run: async f =>
      await f.session.query("INSERT INTO contacts (workspace_id, firm_id, full_name, status) VALUES ($1, $2, $3, 'departed')", [
        workspace(f),
        await aFirm(f),
        'Departed',
      ]),
  },
  {
    constraint: 'contacts_merge_consistent',
    run: async f =>
      await f.session.query("INSERT INTO contacts (workspace_id, firm_id, full_name, status) VALUES ($1, $2, $3, 'merged')", [
        workspace(f),
        await aFirm(f),
        'Merged nowhere',
      ]),
  },
  {
    constraint: 'contacts_not_merged_into_self',
    run: async f => {
      const firmId = await aFirm(f);
      const contactId = await aContact(f, firmId);
      return await f.session.query(
        "UPDATE contacts SET status = 'merged', merged_into_contact_id = id WHERE workspace_id = $1 AND id = $2",
        [workspace(f), contactId],
      );
    },
  },
  {
    constraint: 'contacts_merged_is_not_primary',
    run: async f => {
      const firmId = await aFirm(f);
      const primaryId = await aContact(f, firmId, { isPrimary: true });
      const targetId = await aContact(f, firmId);
      return await f.session.query(
        "UPDATE contacts SET status = 'merged', merged_into_contact_id = $3 WHERE workspace_id = $1 AND id = $2",
        [workspace(f), primaryId, targetId],
      );
    },
  },
  {
    constraint: 'contacts_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO contacts (workspace_id, firm_id, full_name, created_at, updated_at)
         VALUES ($1, $2, 'Backdated', TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
        [workspace(f), await aFirm(f)],
      ),
  },

  // ----------------------------------------------------------- phone_routes
  {
    constraint: 'phone_routes_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const routeId = await aPhoneRoute(f, firmId, '+14015550101');
      return await f.session.query(
        `INSERT INTO phone_routes (workspace_id, id, firm_id, e164, source, retrieved_at)
         VALUES ($1, $2, $3, '+14015550102', 'salesperson', now())`,
        [workspace(f), routeId, firmId],
      );
    },
  },
  {
    constraint: 'phone_routes_firm_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at)
         VALUES ($1, $2, '+14015550103', 'salesperson', now())`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'phone_routes_contact_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirmId = await aFirm(f);
      const contactId = await aContact(f, firmId);
      return await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, contact_id, e164, source, retrieved_at)
         VALUES ($1, $2, $3, '+14015550104', 'salesperson', now())`,
        [workspace(f), otherFirmId, contactId],
      );
    },
  },
  {
    constraint: 'phone_routes_one_per_association',
    run: async f => {
      const firmId = await aFirm(f);
      await aPhoneRoute(f, firmId, '+14015550105');
      return await aPhoneRoute(f, firmId, '+14015550105');
    },
  },
  {
    constraint: 'phone_routes_e164_shape',
    run: async f => await aPhoneRoute(f, await aFirm(f), '4015550106'),
  },
  {
    constraint: 'phone_routes_source_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at)
         VALUES ($1, $2, '+14015550107', 'rumour', now())`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'phone_routes_confidence_range',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, association_confidence)
         VALUES ($1, $2, '+14015550108', 'salesperson', now(), 1.500)`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'phone_routes_technical_validation_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, technical_validation)
         VALUES ($1, $2, '+14015550109', 'salesperson', now(), 'maybe')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'phone_routes_eligibility_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, eligibility)
         VALUES ($1, $2, '+14015550110', 'salesperson', now(), 'perhaps')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'phone_routes_policy_version_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, eligibility_policy_version)
         VALUES ($1, $2, '+14015550112', 'salesperson', now(), 'Route Policy 1')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'phone_routes_retirement_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, eligibility)
         VALUES ($1, $2, '+14015550113', 'salesperson', now(), 'retired')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'phone_routes_retired_reason_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, eligibility, retired_at, retired_reason)
         VALUES ($1, $2, '+14015550114', 'salesperson', now(), 'retired', now(), '   ')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'phone_routes_version_positive',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, version)
         VALUES ($1, $2, '+14015550115', 'salesperson', now(), 0)`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'phone_routes_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO phone_routes (workspace_id, firm_id, e164, source, retrieved_at, created_at, updated_at)
         VALUES ($1, $2, '+14015550116', 'salesperson', now(),
                 TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
        [workspace(f), await aFirm(f)],
      ),
  },

  // -------------------------------------------------------- email_addresses
  {
    constraint: 'email_addresses_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const routeId = await anEmailRoute(f, firmId, 'one@example.test');
      return await f.session.query(
        `INSERT INTO email_addresses (workspace_id, id, firm_id, address, source, retrieved_at)
         VALUES ($1, $2, $3, 'two@example.test', 'salesperson', now())`,
        [workspace(f), routeId, firmId],
      );
    },
  },
  {
    constraint: 'email_addresses_firm_fkey',
    run: async f => await anEmailRoute(f, MISSING, 'firmless@example.test'),
  },
  {
    constraint: 'email_addresses_contact_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirmId = await aFirm(f);
      const contactId = await aContact(f, firmId);
      return await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at)
         VALUES ($1, $2, $3, 'crossed@example.test', 'salesperson', now())`,
        [workspace(f), otherFirmId, contactId],
      );
    },
  },
  {
    constraint: 'email_addresses_one_per_association',
    run: async f => {
      const firmId = await aFirm(f);
      await anEmailRoute(f, firmId, 'twice@example.test');
      return await anEmailRoute(f, firmId, 'twice@example.test');
    },
  },
  {
    constraint: 'email_addresses_address_shape',
    run: async f => await anEmailRoute(f, await aFirm(f), 'Not An Address'),
  },
  {
    constraint: 'email_addresses_source_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at)
         VALUES ($1, $2, 'rumoured@example.test', 'rumour', now())`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'email_addresses_confidence_range',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at, association_confidence)
         VALUES ($1, $2, 'overconfident@example.test', 'salesperson', now(), 1.500)`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'email_addresses_technical_validation_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at, technical_validation)
         VALUES ($1, $2, 'maybe@example.test', 'salesperson', now(), 'maybe')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'email_addresses_eligibility_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at, eligibility)
         VALUES ($1, $2, 'perhaps@example.test', 'salesperson', now(), 'perhaps')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'email_addresses_usable_is_evidenced',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at, eligibility)
         VALUES ($1, $2, 'unevidenced@example.test', 'salesperson', now(), 'usable')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'email_addresses_policy_version_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at, eligibility_policy_version)
         VALUES ($1, $2, 'unversioned@example.test', 'salesperson', now(), 'Route Policy 1')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'email_addresses_retirement_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at, eligibility)
         VALUES ($1, $2, 'retired@example.test', 'salesperson', now(), 'retired')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'email_addresses_retired_reason_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at, eligibility, retired_at, retired_reason)
         VALUES ($1, $2, 'blankreason@example.test', 'salesperson', now(), 'retired', now(), '   ')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'email_addresses_version_positive',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at, version)
         VALUES ($1, $2, 'versionless@example.test', 'salesperson', now(), 0)`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'email_addresses_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at, created_at, updated_at)
         VALUES ($1, $2, 'backdated@example.test', 'salesperson', now(),
                 TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
        [workspace(f), await aFirm(f)],
      ),
  },

  // --------------------------------------------------------- evidence_items
  {
    constraint: 'evidence_items_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const evidenceId = await anEvidenceItem(f, firmId, HASH);
      return await f.session.query(
        `INSERT INTO evidence_items (workspace_id, id, firm_id, provider, source_reference, content_hash)
         VALUES ($1, $2, $3, 'places', 'other', $4)`,
        [workspace(f), evidenceId, firmId, 'b'.repeat(64)],
      );
    },
  },
  {
    constraint: 'evidence_items_firm_fkey',
    run: async f => await anEvidenceItem(f, MISSING, HASH),
  },
  {
    constraint: 'evidence_items_contact_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirmId = await aFirm(f);
      const contactId = await aContact(f, firmId);
      return await f.session.query(
        `INSERT INTO evidence_items (workspace_id, firm_id, contact_id, provider, source_reference, content_hash)
         VALUES ($1, $2, $3, 'places', 'ref', $4)`,
        [workspace(f), otherFirmId, contactId, HASH],
      );
    },
  },
  {
    constraint: 'evidence_items_one_per_result',
    run: async f => {
      const firmId = await aFirm(f);
      await anEvidenceItem(f, firmId, HASH);
      return await anEvidenceItem(f, firmId, HASH);
    },
  },
  {
    constraint: 'evidence_items_provider_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash)
         VALUES ($1, $2, 'Places Provider', 'ref', $3)`,
        [workspace(f), await aFirm(f), HASH],
      ),
  },
  {
    constraint: 'evidence_items_source_reference_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash)
         VALUES ($1, $2, 'places', '   ', $3)`,
        [workspace(f), await aFirm(f), HASH],
      ),
  },
  {
    constraint: 'evidence_items_confidence_range',
    run: async f =>
      await f.session.query(
        `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash, confidence)
         VALUES ($1, $2, 'places', 'ref', $3, 1.500)`,
        [workspace(f), await aFirm(f), HASH],
      ),
  },
  {
    constraint: 'evidence_items_content_hash_shape',
    run: async f => await anEvidenceItem(f, await aFirm(f), 'not-a-digest'),
  },
  {
    constraint: 'evidence_items_retention_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash, terms_allow_retention)
         VALUES ($1, $2, 'places', 'ref', $3, false)`,
        [workspace(f), await aFirm(f), HASH],
      ),
  },
  {
    constraint: 'evidence_items_detail_is_object',
    run: async f =>
      await f.session.query(
        `INSERT INTO evidence_items (workspace_id, firm_id, provider, source_reference, content_hash, detail)
         VALUES ($1, $2, 'places', 'ref', $3, '[]'::jsonb)`,
        [workspace(f), await aFirm(f), HASH],
      ),
  },

  // -------------------------------------------------------- pipeline_stages
  {
    constraint: 'pipeline_stages_pkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, id, key, display_name, position)
         VALUES ($1, $2, 'duplicate_id', 'Duplicate id', 90)`,
        [workspace(f), await aStage(f, 'new')],
      ),
  },
  {
    constraint: 'pipeline_stages_workspace_id_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, key, display_name, position)
         VALUES ($1, 'nowhere', 'Nowhere', 91)`,
        [MISSING],
      ),
  },
  {
    constraint: 'pipeline_stages_key_unique',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, key, display_name, position)
         VALUES ($1, 'new', 'New again', 92)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'pipeline_stages_position_unique',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, key, display_name, position)
         VALUES ($1, 'position_clash', 'Position clash', 1)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'pipeline_stages_key_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, key, display_name, position)
         VALUES ($1, 'New Stage', 'New Stage', 93)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'pipeline_stages_display_name_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, key, display_name, position)
         VALUES ($1, 'blank_name', '   ', 94)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'pipeline_stages_position_positive',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, key, display_name, position)
         VALUES ($1, 'zeroth', 'Zeroth', 0)`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'pipeline_stages_terminal_kind_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, key, display_name, position, terminal_kind)
         VALUES ($1, 'drawn', 'Drawn', 95, 'drawn')`,
        [workspace(f)],
      ),
  },
  {
    // A new Won would break `one_per_terminal_kind` first, so the case retires the
    // seeded Won instead: only "a terminal stage is never retired" can fire.
    constraint: 'pipeline_stages_terminal_not_retired',
    run: async f =>
      await f.session.query(
        "UPDATE pipeline_stages SET retired = true WHERE workspace_id = $1 AND key = 'won'",
        [workspace(f)],
      ),
  },
  {
    constraint: 'pipeline_stages_one_per_terminal_kind',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, key, display_name, position, terminal_kind)
         VALUES ($1, 'won_again', 'Won again', 96, 'won')`,
        [workspace(f)],
      ),
  },
  {
    constraint: 'pipeline_stages_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO pipeline_stages (workspace_id, key, display_name, position, created_at, updated_at)
         VALUES ($1, 'backdated', 'Backdated', 97,
                 TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
        [workspace(f)],
      ),
  },

  // ---------------------------------------------------------- opportunities
  {
    constraint: 'opportunities_semantic_key',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      // Closed, so the one-open-per-firm partial index does not also fire.
      return await f.session.query(
        `INSERT INTO opportunities (workspace_id, id, firm_id, stage_id, status, control_mode_changed_at, closed_at)
         VALUES ($1, $2, $3, $4, 'won', now(), now())`,
        [workspace(f), opportunityId, firmId, await aStage(f, 'won')],
      );
    },
  },
  {
    constraint: 'opportunities_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        `INSERT INTO opportunities (workspace_id, id, firm_id, stage_id, status, control_mode_changed_at, closed_at)
         VALUES ($1, $2, $3, $4, 'won', now(), now())`,
        [workspace(f), opportunityId, otherFirmId, await aStage(f, 'won')],
      );
    },
  },
  {
    constraint: 'opportunities_firm_fkey',
    run: async f => await anOpportunity(f, MISSING),
  },
  {
    constraint: 'opportunities_stage_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
         VALUES ($1, $2, $3, now())`,
        [workspace(f), await aFirm(f), MISSING],
      ),
  },
  {
    constraint: 'opportunities_reopened_from_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at, reopened_from_opportunity_id)
         VALUES ($1, $2, $3, now(), $4)`,
        [workspace(f), await aFirm(f), await aStage(f, 'new'), MISSING],
      ),
  },
  {
    constraint: 'opportunities_one_open_per_firm',
    run: async f => {
      const firmId = await aFirm(f);
      await anOpportunity(f, firmId);
      return await anOpportunity(f, firmId);
    },
  },
  {
    constraint: 'opportunities_status_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, status, control_mode_changed_at, closed_at)
         VALUES ($1, $2, $3, 'stalled', now(), now())`,
        [workspace(f), await aFirm(f), await aStage(f, 'new')],
      ),
  },
  {
    constraint: 'opportunities_control_mode_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode, control_mode_reason, control_mode_changed_at)
         VALUES ($1, $2, $3, 'held', 'a hold is not a control mode', now())`,
        [workspace(f), await aFirm(f), await aStage(f, 'new')],
      ),
  },
  {
    constraint: 'opportunities_manual_has_reason',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode, control_mode_changed_at)
         VALUES ($1, $2, $3, 'manual', now())`,
        [workspace(f), await aFirm(f), await aStage(f, 'new')],
      ),
  },
  {
    constraint: 'opportunities_close_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at, closed_at)
         VALUES ($1, $2, $3, now(), now())`,
        [workspace(f), await aFirm(f), await aStage(f, 'new')],
      ),
  },
  {
    constraint: 'opportunities_lost_needs_reason',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, status, control_mode_changed_at, closed_at)
         VALUES ($1, $2, $3, 'lost', now(), now())`,
        [workspace(f), await aFirm(f), await aStage(f, 'lost')],
      ),
  },
  {
    constraint: 'opportunities_close_reason_bounded',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at, close_reason)
         VALUES ($1, $2, $3, now(), '   ')`,
        [workspace(f), await aFirm(f), await aStage(f, 'new')],
      ),
  },
  {
    constraint: 'opportunities_close_not_before_open',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, status, control_mode_changed_at, opened_at, closed_at)
         VALUES ($1, $2, $3, 'won', now(),
                 TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
        [workspace(f), await aFirm(f), await aStage(f, 'won')],
      ),
  },
  {
    constraint: 'opportunities_not_reopened_from_self',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        'UPDATE opportunities SET reopened_from_opportunity_id = id WHERE workspace_id = $1 AND id = $2',
        [workspace(f), opportunityId],
      );
    },
  },
  {
    constraint: 'opportunities_updated_not_before_created',
    run: async f =>
      await f.session.query(
        `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at, created_at, updated_at)
         VALUES ($1, $2, $3, now(), TIMESTAMPTZ '2026-02-01 00:00:00+00', TIMESTAMPTZ '2026-01-01 00:00:00+00')`,
        [workspace(f), await aFirm(f), await aStage(f, 'new')],
      ),
  },

  // ----------------------------------------------- opportunity_stage_events
  {
    constraint: 'opportunity_stage_events_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      const eventId = await aStageEvent(f, opportunityId, firmId);
      return await f.session.query(
        `INSERT INTO opportunity_stage_events (workspace_id, id, opportunity_id, firm_id, to_stage_id, actor_kind)
         VALUES ($1, $2, $3, $4, $5, 'system')`,
        [workspace(f), eventId, opportunityId, firmId, await aStage(f, 'contacting')],
      );
    },
  },
  {
    constraint: 'opportunity_stage_events_opportunity_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await aStageEvent(f, opportunityId, otherFirmId);
    },
  },
  {
    constraint: 'opportunity_stage_events_from_stage_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id, actor_kind)
         VALUES ($1, $2, $3, $4, $5, 'system')`,
        [workspace(f), opportunityId, firmId, MISSING, await aStage(f, 'new')],
      );
    },
  },
  {
    constraint: 'opportunity_stage_events_to_stage_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind)
         VALUES ($1, $2, $3, $4, 'system')`,
        [workspace(f), opportunityId, firmId, MISSING],
      );
    },
  },
  {
    constraint: 'opportunity_stage_events_actor_kind_known',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind)
         VALUES ($1, $2, $3, $4, 'robot')`,
        [workspace(f), opportunityId, firmId, await aStage(f, 'new')],
      );
    },
  },
  {
    constraint: 'opportunity_stage_events_user_actor_identified',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind)
         VALUES ($1, $2, $3, $4, 'user')`,
        [workspace(f), opportunityId, firmId, await aStage(f, 'new')],
      );
    },
  },
  {
    constraint: 'opportunity_stage_events_reason_bounded',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind, reason)
         VALUES ($1, $2, $3, $4, 'system', '   ')`,
        [workspace(f), opportunityId, firmId, await aStage(f, 'new')],
      );
    },
  },
  {
    constraint: 'opportunity_stage_events_command_id_shape',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, to_stage_id, actor_kind, command_id)
         VALUES ($1, $2, $3, $4, 'system', 'not a command id!')`,
        [workspace(f), opportunityId, firmId, await aStage(f, 'new')],
      );
    },
  },
  {
    constraint: 'opportunity_stage_events_moves',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      const stageId = await aStage(f, 'new');
      return await f.session.query(
        `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id, actor_kind)
         VALUES ($1, $2, $3, $4, $4, 'system')`,
        [workspace(f), opportunityId, firmId, stageId],
      );
    },
  },

  // -------------------------------------------------------- record_aliases
  {
    constraint: 'record_aliases_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const { rows } = await f.session.query<{ id: string }>(
        `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value)
         VALUES ($1, 'firm', $2, 'name', 'First alias') RETURNING id`,
        [workspace(f), firmId],
      );
      return await f.session.query(
        `INSERT INTO record_aliases (workspace_id, id, record_kind, firm_id, alias_kind, alias_value)
         VALUES ($1, $2, 'firm', $3, 'name', 'Second alias')`,
        [workspace(f), rows[0]?.id, firmId],
      );
    },
  },
  {
    constraint: 'record_aliases_firm_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value)
         VALUES ($1, 'firm', $2, 'name', 'Firmless alias')`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'record_aliases_contact_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirmId = await aFirm(f);
      const contactId = await aContact(f, firmId);
      return await f.session.query(
        `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, contact_id, alias_kind, alias_value)
         VALUES ($1, 'contact', $2, $3, 'name', 'Crossed alias')`,
        [workspace(f), otherFirmId, contactId],
      );
    },
  },
  {
    constraint: 'record_aliases_unique',
    run: async f => {
      const firmId = await aFirm(f);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value)
           VALUES ($1, 'firm', $2, 'name', 'Repeated alias')`,
          [workspace(f), firmId],
        );
      }
      return null;
    },
  },
  {
    constraint: 'record_aliases_record_kind_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value)
         VALUES ($1, 'opportunity', $2, 'name', 'Wrong kind')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'record_aliases_contact_consistent',
    run: async f =>
      await f.session.query(
        `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value)
         VALUES ($1, 'contact', $2, 'name', 'Contactless contact alias')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'record_aliases_alias_kind_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value)
         VALUES ($1, 'firm', $2, 'nickname', 'Nicknamed')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'record_aliases_alias_value_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO record_aliases (workspace_id, record_kind, firm_id, alias_kind, alias_value)
         VALUES ($1, 'firm', $2, 'name', '   ')`,
        [workspace(f), await aFirm(f)],
      ),
  },

  // --------------------------------------------------- record_merge_events

  // ---------------------------------------------------- crm_domain_events
  {
    constraint: 'crm_domain_events_pkey',
    run: async f => {
      const firmId = await aFirm(f);
      const { rows } = await f.session.query<{ id: string }>(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind)
         VALUES ($1, 'firm.reassigned', $2, 'first', 'system') RETURNING id`,
        [workspace(f), firmId],
      );
      return await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, id, event_kind, firm_id, dedupe_key, actor_kind)
         VALUES ($1, $2, 'firm.reassigned', $3, 'second', 'system')`,
        [workspace(f), rows[0]?.id, firmId],
      );
    },
  },
  {
    constraint: 'crm_domain_events_firm_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind)
         VALUES ($1, 'firm.reassigned', $2, 'firmless', 'system')`,
        [workspace(f), MISSING],
      ),
  },
  {
    constraint: 'crm_domain_events_opportunity_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, opportunity_id, dedupe_key, actor_kind)
         VALUES ($1, 'opportunity.terminal_stop', $2, $3, 'crossed', 'system')`,
        [workspace(f), otherFirmId, opportunityId],
      );
    },
  },
  {
    constraint: 'crm_domain_events_contact_fkey',
    run: async f => {
      const firmId = await aFirm(f);
      const otherFirmId = await aFirm(f);
      const contactId = await aContact(f, firmId);
      return await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, contact_id, dedupe_key, actor_kind)
         VALUES ($1, 'contact.merged', $2, $3, 'crossed-contact', 'system')`,
        [workspace(f), otherFirmId, contactId],
      );
    },
  },
  {
    constraint: 'crm_domain_events_dedupe',
    run: async f => {
      const firmId = await aFirm(f);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.session.query(
          `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind)
           VALUES ($1, 'firm.reassigned', $2, 'repeated', 'system')`,
          [workspace(f), firmId],
        );
      }
      return null;
    },
  },
  {
    constraint: 'crm_domain_events_kind_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind)
         VALUES ($1, 'firm.invented', $2, 'invented', 'system')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'crm_domain_events_dedupe_key_present',
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind)
         VALUES ($1, 'firm.reassigned', $2, '   ', 'system')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'crm_domain_events_reason_code_fkey',
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind, reason_code)
         VALUES ($1, 'firm.reassigned', $2, 'invented-reason', 'system', 'invented_reason')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'crm_domain_events_actor_kind_known',
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind)
         VALUES ($1, 'firm.reassigned', $2, 'robot', 'robot')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'crm_domain_events_user_actor_identified',
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind)
         VALUES ($1, 'firm.reassigned', $2, 'anonymous-user', 'user')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'crm_domain_events_command_id_shape',
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind, command_id)
         VALUES ($1, 'firm.reassigned', $2, 'bad-command', 'system', 'not a command id!')`,
        [workspace(f), await aFirm(f)],
      ),
  },
  {
    constraint: 'crm_domain_events_opportunity_present',
    run: async f => {
      const firmId = await aFirm(f);
      const opportunityId = await anOpportunity(f, firmId);
      return await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, opportunity_id, dedupe_key, actor_kind)
         VALUES ($1, 'firm.reassigned', $2, $3, 'misplaced-opportunity', 'system')`,
        [workspace(f), firmId, opportunityId],
      );
    },
  },
  {
    constraint: 'crm_domain_events_detail_is_object',
    run: async f =>
      await f.session.query(
        `INSERT INTO crm_domain_events (workspace_id, event_kind, firm_id, dedupe_key, actor_kind, detail)
         VALUES ($1, 'firm.reassigned', $2, 'bad-detail', 'system', '[]'::jsonb)`,
        [workspace(f), await aFirm(f)],
      ),
  },
];
