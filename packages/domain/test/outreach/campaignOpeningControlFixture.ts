import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import type { SessionQueryable, QueryResultRowLike } from '../../db/queryable.ts';
import type { EmailCampaignRow } from '../../outreach/emailCampaignAuthority.ts';
import type { OpeningPolicyRow } from '../../outreach/campaignOpeningControlRead.ts';
export const controlId = '10000000-0000-4000-8000-000000000001';
export const controlOther = '20000000-0000-4000-8000-000000000002';
export const controlNow = '2026-10-27T01:30:00.000Z';
export const controlInput = { campaignId: controlId, expectedCampaignRevision: 1, templateVersionId: controlId, templateContentHash: 'a'.repeat(64),
  variants: [{ id: 'local', text: 'Approved {{firm_name}} line.' }], expiresAt: '2026-10-27T02:30:00.000Z' };
interface Receipt { device_id: string; command_kind: string; payload_hash: string; result_status: string; result: unknown }
export function campaignOpeningControlFixture() {
  const campaign: EmailCampaignRow = { id: controlId, owner_user_id: controlId, mailbox_id: controlId, sequence_version_id: controlId, authorization_revision: 1,
    regions: ['TX'], max_enrollments: 25, daily_admission_limit: 5, approved_at: new Date(controlNow), expires_at: new Date('2026-10-28T01:30:00.000Z'), revision: 1, revoked_at: null };
  const baseline = { sequence_version_id: controlId, template_version_id: controlId, version: 1, content_hash: 'a'.repeat(64), subject: 'Exact subject', body: 'Exact baseline\n\nSigned off', approved_at: new Date(controlNow) };
  const state = { campaign, baseline: baseline as typeof baseline | null, policy: null as OpeningPolicyRow | null, active: true, now: controlNow,
    receipts: new Map<string, Receipt>(), audits: [] as unknown[][] };
  type Snapshot = Pick<typeof state, 'policy' | 'audits' | 'receipts'>;
  const snapshots = new Map<string, Snapshot>();
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  let hook: (sql: string, values: readonly unknown[]) => Promise<void> = async () => {};
  const snapshot = (): Snapshot => structuredClone({ policy: state.policy, audits: state.audits, receipts: state.receipts });
  const restore = (name: string): void => { const old = snapshots.get(name); if (old) Object.assign(state, structuredClone(old)); };
  const db: SessionQueryable = { query: async <Row extends QueryResultRowLike>(sql: string, values: readonly unknown[] = []) => {
    statements.push({ sql, values });
    await hook(sql, values);
    let rows: unknown[] = [];
    if (sql === 'BEGIN' || sql.startsWith('SAVEPOINT ')) snapshots.set(sql === 'BEGIN' ? 'transaction' : sql.slice(10), snapshot());
    else if (sql === 'ROLLBACK') restore('transaction');
    else if (sql.startsWith('ROLLBACK TO SAVEPOINT ')) restore(sql.slice(22));
    else if (sql.startsWith('SELECT pg_advisory_xact_lock')) rows = [{}];
    else if (sql.includes('FROM workspace_memberships')) rows = state.active ? [{}] : [];
    else if (sql.includes('FROM outreach_email_campaigns c')) rows = state.active && values[0] === controlId && values[1] === controlId && values[2] === state.campaign.owner_user_id ? [state.campaign] : [];
    else if (sql.includes('FROM sequence_versions v JOIN sequence_steps')) rows = state.baseline ? [state.baseline] : [];
    else if (sql.startsWith('SELECT id,policy,revoked_at')) rows = state.policy ? [state.policy] : [];
    else if (sql === 'SELECT clock_timestamp() AS now') rows = [{ now: new Date(state.now) }];
    else if (sql.startsWith('INSERT INTO outreach_campaign_opening_policies')) {
      if (!state.policy) { state.policy = { id: String(values[1]), policy: JSON.parse(String(values[3])), revoked_at: null }; rows = [{ id: values[1] }]; }
    } else if (sql.startsWith('UPDATE outreach_campaign_opening_policies')) { if (state.policy && !state.policy.revoked_at) { state.policy.revoked_at = new Date(state.now); rows = [{ id: state.policy.id }]; } }
    else if (sql.startsWith('INSERT INTO audit_events')) state.audits.push([...values]);
    else if (sql.includes('FROM devices') || sql.includes('FROM sessions')) rows = [{ id: controlId }];
    else if (sql.includes('FROM command_receipts')) {
      const row = state.receipts.get(String(values[1]));
      if (row && (values.length === 2 || values[0] === controlId && values[2] === row.device_id && values[3] === controlId && values[4] === row.command_kind && values[5] === row.payload_hash)) rows = [row];
    } else if (sql.includes('INSERT INTO command_receipts')) {
      if (state.receipts.has(String(values[2]))) throw Object.assign(Error('duplicate'), { code: '23505' });
      state.receipts.set(String(values[2]), { device_id: String(values[1]), command_kind: String(values[3]), payload_hash: String(values[4]), result_status: String(values[5]), result: JSON.parse(String(values[6])) });
    } else if (!['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) && !/^(?:RELEASE|SAVEPOINT|ROLLBACK TO)/u.test(sql)) throw Error('Unexpected control SQL');
    return { rows: structuredClone(rows) as Row[], rowCount: rows.length };
  } };
  const context = repositoryContext(workspaceScope(controlId, { kind: 'user', userId: controlId, role: 'admin' }), db);
  return { state, context, db, statements, hook: (value: typeof hook) => { hook = value; } };
}
