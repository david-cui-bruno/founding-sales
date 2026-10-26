import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../db/queryable.ts';
import type { TwoWorkspaces } from './support/fixtures.ts';
import type { SeededMail } from './support/mailFixtures.ts';
import type { SeededOutbound } from './support/outboundFixtures.ts';
import { openingFixture } from '../outreach/campaignOpeningFixture.ts';

type Fixture = { session: SessionQueryable; seeded: TwoWorkspaces; mail: SeededMail; outbound: SeededOutbound };
type Row = Record<string, unknown>;
type Case = { constraint: string; run: (fixture: Fixture) => Promise<unknown> };
const policies = 'outreach_campaign_opening_policies';
const attempts = 'outreach_campaign_opening_attempts';
const attemptChecks = [
  'outreach_campaign_opening_attempts_snapshot_hash_check', 'outreach_campaign_opening_attempts_state_check',
  'campaign_opening_content_shape', 'campaign_opening_invalidated', 'campaign_opening_finished', 'campaign_opening_times',
  'campaign_opening_fence_hashes', 'campaign_opening_binding_shape',
] as const;
const insert = (f: Fixture, table: string, row: Row) => f.session.query(
  `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(row),
);

/** Only the privileged rolled-back catalog harness disables these two NEW
 * lifecycle triggers to isolate declarative constraints. Actual role/current
 * source/immutable lifecycle guards remain enabled in the focused PG workflow
 * cases. No legacy constraint or trigger is dropped, disabled or whitelisted. */
async function policyRow(f: Fixture): Promise<Row> {
  await f.session.query(`ALTER TABLE ${policies} DISABLE TRIGGER campaign_opening_policy_fence`);
  const workspaceId = f.seeded.alpha.workspaceId, ownerUserId = f.seeded.alpha.admin.userId;
  const sequenceId = randomUUID(), versionId = randomUUID(), campaignId = randomUUID(), policyId = randomUUID();
  await insert(f, 'sequences', { workspace_id: workspaceId, id: sequenceId, name: 'Fictional opening catalog', created_by_user_id: ownerUserId });
  await insert(f, 'sequence_versions', { workspace_id: workspaceId, id: versionId, sequence_id: sequenceId, version: 1 });
  await insert(f, 'outreach_email_campaigns', { workspace_id: workspaceId, id: campaignId, owner_user_id: ownerUserId,
    mailbox_id: f.mail.alpha.mailboxId, sequence_version_id: versionId, authorization_revision: 1, regions: ['TX'],
    max_enrollments: 25, daily_admission_limit: 5, approved_at: '2026-10-26T12:00:00Z', expires_at: '2026-10-27T12:00:00Z', revision: 1 });
  const policy = { ...openingFixture().policy, id: policyId, workspaceId, ownerUserId, campaignId, sequenceVersionId: versionId };
  return { workspace_id: workspaceId, id: policyId, campaign_id: campaignId, policy: JSON.stringify(policy) };
}
async function attemptRow(f: Fixture): Promise<Row> {
  await f.session.query(`ALTER TABLE ${attempts} DISABLE TRIGGER campaign_opening_attempt_fence`);
  const executionId = randomUUID(), workspaceId = f.seeded.alpha.workspaceId;
  return { workspace_id: workspaceId, execution_id: executionId, attempt_id: randomUUID(),
    binding: JSON.stringify({ ...openingFixture().binding, workspaceId, executionId }), snapshot_hash: 'a'.repeat(64),
    state: 'unknown', claimed_at: '2026-10-26T12:00:00Z', finished_at: null, invalidated_at: null,
    content: null, fence_id: null, subject_hash: null, body_hash: null };
}
const invalidAttempt = (constraint: typeof attemptChecks[number], patch: Row): Case => ({ constraint, run: async f => {
  const row = await attemptRow(f);
  // Some malformed states necessarily violate both shape and finish checks.
  // Isolate only new CHECKs within this transaction, which the harness rolls back.
  for (const other of attemptChecks) if (other !== constraint) await f.session.query(`ALTER TABLE ${attempts} DROP CONSTRAINT ${other}`);
  return insert(f, attempts, { ...row, ...patch });
} });

/** Exact named PK/UNIQUE/FK/CHECK catalog coverage for additive migration0140.
 * FK name reflects PostgreSQL's 63-byte generated-name truncation. */
export const CAMPAIGN_OPENING_CONSTRAINT_CASES: readonly Case[] = [
  { constraint: 'campaign_opening_historical_terminal', run: async f => {
    await f.session.query(`UPDATE outbound_messages SET state='dispatching',attempt_token=gen_random_uuid(),dispatch_started_at=clock_timestamp(),
      provider_message_id='fictional-observed',provider_thread_id='fictional-thread' WHERE workspace_id=$1 AND id=$2`,
    [f.seeded.alpha.workspaceId, f.outbound.alpha.preparedFenceId]);
    return f.session.query('SET CONSTRAINTS campaign_opening_historical_terminal IMMEDIATE');
  } },
  { constraint: 'outreach_campaign_opening_policies_pkey', run: async f => {
    const row = await policyRow(f); await insert(f, policies, row);
    await f.session.query(`ALTER TABLE ${policies} DROP CONSTRAINT outreach_campaign_opening_policies_workspace_id_campaign_id_key`);
    return insert(f, policies, row);
  } },
  { constraint: 'outreach_campaign_opening_policies_workspace_id_campaign_id_key', run: async f => {
    const row = await policyRow(f); await insert(f, policies, row);
    const policy = JSON.parse(String(row['policy'])) as Record<string, unknown>, id = randomUUID();
    return insert(f, policies, { ...row, id, policy: JSON.stringify({ ...policy, id }) });
  } },
  { constraint: 'outreach_campaign_opening_policie_workspace_id_campaign_id_fkey', run: async f => {
    const row = await policyRow(f), workspaceId = f.seeded.beta.workspaceId;
    const policy = JSON.parse(String(row['policy'])) as Record<string, unknown>;
    // Existing alpha campaign is not a campaign witness in beta.
    return insert(f, policies, { ...row, workspace_id: workspaceId, policy: JSON.stringify({ ...policy, workspaceId }) });
  } },
  { constraint: 'campaign_opening_policy_shape', run: async f => insert(f, policies, { ...await policyRow(f), policy: '{}' }) },
  { constraint: 'outreach_campaign_opening_attempts_pkey', run: async f => {
    const row = await attemptRow(f); await insert(f, attempts, row);
    return insert(f, attempts, { ...row, attempt_id: randomUUID() });
  } },
  { constraint: 'outreach_campaign_opening_attempts_workspace_id_attempt_id_key', run: async f => {
    const row = await attemptRow(f); await insert(f, attempts, row);
    return insert(f, attempts, { ...row, execution_id: randomUUID() });
  } },
  invalidAttempt('outreach_campaign_opening_attempts_snapshot_hash_check', { snapshot_hash: 'not-a-hash' }),
  invalidAttempt('outreach_campaign_opening_attempts_state_check', { state: 'retry' }),
  invalidAttempt('campaign_opening_content_shape', { state: 'ready', content: null }),
  invalidAttempt('campaign_opening_invalidated', { state: 'ready', content: '{}', invalidated_at: '2026-10-26T12:01:00Z' }),
  invalidAttempt('campaign_opening_finished', { state: 'refused', finished_at: null }),
  invalidAttempt('campaign_opening_times', { claimed_at: '-infinity' }),
  invalidAttempt('campaign_opening_fence_hashes', { fence_id: randomUUID(), subject_hash: 'not-a-hash', body_hash: 'b'.repeat(64) }),
  invalidAttempt('campaign_opening_binding_shape', { binding: '{}' }),
];
