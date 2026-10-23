import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
import type { SeededMail } from './mailFixtures.ts';
import type { SeededOutbound } from './outboundFixtures.ts';
type Fixture = { session: SessionQueryable; seeded: TwoWorkspaces; crm: SeededCrm; mail: SeededMail; outbound: SeededOutbound };
type Row = Record<string, unknown>;
type Case = { constraint: string; run: (fixture: Fixture) => Promise<unknown> };
const missing = '00000000-0000-4000-8000-000000000130';
const insert = (f: Fixture, table: string, row: Row) => f.session.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(row));

async function campaign(f: Fixture): Promise<Row> {
  const w = f.seeded.alpha.workspaceId, actor = f.seeded.alpha.admin.userId;
  const sequence = randomUUID(), version = randomUUID();
  await insert(f, 'sequences', { workspace_id: w, id: sequence, name: 'Controlled campaign catalog', created_by_user_id: actor });
  await insert(f, 'sequence_versions', { workspace_id: w, id: version, sequence_id: sequence, version: 1 });
  return { workspace_id: w, id: randomUUID(), owner_user_id: actor, mailbox_id: f.mail.alpha.mailboxId,
    sequence_version_id: version, authorization_revision: 1, regions: ['TX'], max_enrollments: 25, daily_admission_limit: 5,
    approved_at: '2026-10-22T12:00:00Z', expires_at: '2026-10-23T12:00:00Z', revision: 1 };
}
async function source(f: Fixture, policy: Row): Promise<Row> {
  const w = f.seeded.alpha.workspaceId, candidate = randomUUID(), run = randomUUID();
  await insert(f, 'sourcing_candidates', { workspace_id: w, id: candidate, identity_key: randomUUID().replaceAll('-', '').repeat(2), payload: '{}', status: 'needs_review', revision: 1 });
  await insert(f, 'sourcing_qualification_runs', { workspace_id: w, id: run, candidate_id: candidate, candidate_revision: 1, fingerprint: 'e'.repeat(64), prompt_version: 'fixture', policy_version: 'fixture', model_name: 'fixture' });
  return { workspace_id: w, candidate_id: candidate, run_id: run, firm_id: f.crm.alpha.firmId, contact_id: f.crm.alpha.contactId,
    route_id: f.outbound.alpha.routeId, observation_id: randomUUID(), block_id: 'office', identity_kind: 'role', reviewed: false, campaign_id: policy['id'] };
}
async function admission(f: Fixture): Promise<Row> {
  const policy = await campaign(f);
  await insert(f, 'outreach_email_campaigns', policy);
  const s = await source(f, policy);
  await insert(f, 'outreach_email_sources', s);
  const plan = randomUUID(), enrollment = randomUUID();
  await insert(f, 'outreach_plans', { workspace_id: s['workspace_id'], id: plan, firm_id: s['firm_id'], contact_id: s['contact_id'], owner_user_id: policy['owner_user_id'], mailbox_id: policy['mailbox_id'], candidate_id: s['candidate_id'], qualification_run_id: s['run_id'], lane: 'email_first', state: 'stopped' });
  await insert(f, 'sequence_enrollments', { workspace_id: s['workspace_id'], id: enrollment, sequence_version_id: policy['sequence_version_id'], outreach_plan_id: plan,
    firm_id: s['firm_id'], contact_id: s['contact_id'], assigned_user_id: f.seeded.alpha.admin.userId, origin_kind: 'prospecting', firm_time_zone: 'America/Chicago', holiday_calendar_version: 'none.1' });
  return { workspace_id: s['workspace_id'], campaign_id: policy['id'], firm_id: s['firm_id'], contact_id: s['contact_id'], route_id: s['route_id'], plan_id: plan, enrollment_id: enrollment, candidate_id: s['candidate_id'], qualification_run_id: s['run_id'] };
}
const checks: [string, Row][] = [
  ['email_campaign_authorization_revision', { authorization_revision: 0 }],
  ['email_campaign_regions', { regions: [] }], ['email_campaign_regions', { regions: ['TX', 'TX'] }],
  ['email_campaign_regions', { regions: ['CA'] }], ['email_campaign_regions', { regions: ['TX', null] }],
  ['email_campaign_lifetime_cap', { max_enrollments: 0 }], ['email_campaign_lifetime_cap', { max_enrollments: 26 }],
  ['email_campaign_daily_cap', { daily_admission_limit: 0 }], ['email_campaign_daily_cap', { daily_admission_limit: 6 }],
  ['email_campaign_revision', { revision: 0, revoked_at: '2026-10-22T13:00:00Z' }],
  ['email_campaign_expiry', { expires_at: '2026-10-22T12:00:00Z' }], ['email_campaign_expiry', { expires_at: '2026-11-22T12:00:00Z' }],
  ['email_campaign_revocation', { revision: 2 }],
  ['email_campaign_owner_fkey', { owner_user_id: missing }], ['email_campaign_mailbox_fkey', { mailbox_id: missing }], ['email_campaign_sequence_fkey', { sequence_version_id: missing }],
];
export const EMAIL_CAMPAIGN_CONSTRAINT_CASES: readonly Case[] = [
  ...checks.map(([constraint, change]) => ({ constraint, run: async (f: Fixture) => {
    if (constraint === 'email_campaign_revision') await f.session.query('ALTER TABLE outreach_email_campaigns DROP CONSTRAINT email_campaign_revocation');
    return insert(f, 'outreach_email_campaigns', { ...await campaign(f), ...change });
  } })),
  ...['email_campaign_pkey', 'email_campaign_one_unrevoked'].map(constraint => ({ constraint, run: async (f: Fixture) => {
    const row = await campaign(f); await insert(f, 'outreach_email_campaigns', row);
    if (constraint === 'email_campaign_pkey') await f.session.query('DROP INDEX email_campaign_one_unrevoked');
    return insert(f, 'outreach_email_campaigns', { ...row, ...(constraint === 'email_campaign_one_unrevoked' ? { id: randomUUID() } : {}) });
  } })),
  { constraint: 'outreach_email_sources_campaign_fkey', run: async f => {
    const policy = await campaign(f); const s = await source(f, policy);
    return insert(f, 'outreach_email_sources', { ...s, campaign_id: missing });
  } },
  { constraint: 'outreach_email_sources_campaign_not_reviewed', run: async f => {
    const policy = await campaign(f); await insert(f, 'outreach_email_campaigns', policy);
    return insert(f, 'outreach_email_sources', { ...await source(f, policy), reviewed: true });
  } },
  ...[
    ['email_campaign_admission_campaign_fkey', 'campaign_id'], ['email_campaign_admission_contact_fkey', 'contact_id'],
    ['email_campaign_admission_plan_fkey', 'plan_id'], ['email_campaign_admission_enrollment_fkey', 'enrollment_id'],
  ].map(([constraint, key]) => ({ constraint: constraint!, run: async (f: Fixture) => {
    const row = await admission(f);
    // Privileged rolled-back catalog harness isolates declarative constraints.
    // The live insertion trigger is independently exercised by actual e2e cases.
    await f.session.query('DROP TRIGGER email_campaign_admission_lineage ON outreach_email_campaign_admissions');
    return insert(f, 'outreach_email_campaign_admissions', { ...row, [key!]: missing });
  } })),
  ...['email_campaign_admission_pkey', 'email_campaign_admission_one_firm', 'email_campaign_admission_one_enrollment'].map(constraint => ({ constraint, run: async (f: Fixture) => {
    const row = await admission(f);
    await f.session.query('DROP TRIGGER email_campaign_admission_lineage ON outreach_email_campaign_admissions');
    await insert(f, 'outreach_email_campaign_admissions', row);
    for (const other of ['email_campaign_admission_pkey', 'email_campaign_admission_one_firm', 'email_campaign_admission_one_enrollment']) {
      if (other !== constraint) await f.session.query(`ALTER TABLE outreach_email_campaign_admissions DROP CONSTRAINT ${other}`);
    }
    return insert(f, 'outreach_email_campaign_admissions', row);
  } })),
];
