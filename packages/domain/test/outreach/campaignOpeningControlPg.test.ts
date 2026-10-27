import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { campaignOpeningControlSchema, campaignOpeningCommandResultSchema } from '@fss/contracts';
import { createAuthFixture } from '../../../../apps/api/test/support/authFixture.ts';
import { issueSessionFor } from '../../../../apps/api/test/support/sessionFixture.ts';
import { seedEmailCampaign } from '../../../../apps/web/test/support/emailCampaignSeed.ts';
import type { ThinHostApp } from '../../../../apps/web/test/support/thinHostApp.ts';
import { routeCampaignOpeningControl } from '../../../../apps/api/src/routes/campaignOpeningControl.ts';
import type { ApiRequest, RoutingOptions } from '../../../../apps/api/src/routes/types.ts';
import { payloadHashOf } from '../../../../apps/api/src/auth/tokens.ts';
import { approveEmailCampaign } from '../../outreach/emailCampaign.ts';
import { withTransaction, type SessionQueryable, type QueryResultRowLike } from '../../db/queryable.ts';
import { registerOpeningFixture } from './campaignOpeningPgRuntime.ts';
async function fixture() {
  const f = await createAuthFixture(), stop = await registerOpeningFixture(f);
  try {
    const prepared = await seedEmailCampaign({ fixture: f } as ThinHostApp), approved = await withTransaction(f.db, () => approveEmailCampaign(prepared.context, prepared.policy));
    assert(approved.ok); const campaignId = approved.value.campaignId, db = await f.database.appRuntimeSession();
    const grant = await issueSessionFor(f, f.alpha, f.alpha.admin);
    const call = (action: string, body: unknown, session: SessionQueryable = db) => routeCampaignOpeningControl({ method: 'POST', path: `/outreach/email-campaigns/opening/${action}`,
      headers: { authorization: `Bearer ${grant.accessToken}` }, body, query: new URLSearchParams() } satisfies ApiRequest,
    { auth: { ...f.deps, db: session } } as RoutingOptions);
    const current = async () => campaignOpeningControlSchema.parse((await call('control', { campaignId }))?.body);
    const viewed = await current(); assert(viewed.baseline);
    const input = { campaignId, expectedCampaignRevision: viewed.campaignRevision, templateVersionId: viewed.baseline.templateVersionId,
      templateContentHash: viewed.baseline.templateContentHash, variants: [{ id: 'explicit', text: 'Approved {{firm_name}} opening.' }], expiresAt: new Date(Date.now() + 3600000).toISOString() };
    const snapshot = async () => { const value: Record<string, unknown[]> = {}; for (const table of ['outreach_email_campaigns', 'outreach_email_campaign_admissions', 'sequence_enrollments', 'step_executions', 'outbound_messages', 'provider_reservations', 'jobs', 'workspace_settings']) value[table] = (await f.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows; return value; };
    return { f, db, stop, call, current, input, campaignId, snapshot };
  } catch (error) { await stop(); throw error; }
}
it('app_runtime actual signed command persists opaque receipt, exact control and permanent revoked tombstone with other product state unchanged', async () => {
  const s = await fixture(); try {
    expect((await s.db.query('SELECT current_user')).rows[0]?.['current_user']).toBe('app_runtime'); const before = await s.snapshot(), commandId = randomUUID();
    const response = await s.call('approve', { ...s.input, commandId, clientVersion: '1.4.0' }); expect(response?.status).toBe(200);
    const result = campaignOpeningCommandResultSchema.parse((response?.body as { result: unknown }).result);
    expect(await s.current()).toMatchObject({ approvalState: 'already_configured', selectorReadiness: 'not_established', policy: { state: 'active', value: { id: result.policyId, variants: s.input.variants } } });
    const receiptsBefore = (await s.db.query('SELECT count(*)::int n FROM command_receipts')).rows;
    expect(await s.call('receipt', { commandId, payloadSHA256: payloadHashOf(s.input), action: 'approve' })).toMatchObject({ status: 200, body: { state: 'accepted', result } });
    expect(await s.call('receipt', { commandId, payloadSHA256: 'f'.repeat(64), action: 'approve' })).toMatchObject({ status: 200, body: { state: 'unknown' } });
    expect((await s.db.query('SELECT count(*)::int n FROM command_receipts')).rows).toEqual(receiptsBefore);
    expect((await s.call('revoke', { campaignId: s.campaignId, expectedCampaignRevision: 1, policyId: result.policyId, policyRevision: 1, commandId: randomUUID(), clientVersion: '1.4.0' }))?.status).toBe(200);
    expect(await s.current()).toMatchObject({ approvalState: 'already_configured', policy: { state: 'revoked' } });
    expect(await s.call('approve', { ...s.input, commandId: randomUUID(), clientVersion: '1.4.0' })).toMatchObject({ status: 409, body: { reason: 'already_configured' } });
    expect(await s.snapshot()).toEqual(before); const audit = await s.db.query("SELECT detail FROM audit_events WHERE action LIKE 'outreach.campaign_opening_%'"); expect(audit.rows).toHaveLength(2); expect(JSON.stringify(audit.rows)).not.toContain(s.input.variants[0]!.text);
  } finally { await s.stop(); }
}, 60000);
it('app_runtime revocation remains possible with revoked current campaign and missing baseline, but stale current revision refuses', async () => {
  const s = await fixture(); try {
    const response = await s.call('approve', { ...s.input, commandId: randomUUID(), clientVersion: '1.4.0' }); const result = campaignOpeningCommandResultSchema.parse((response?.body as { result: unknown }).result);
    await s.f.db.query('UPDATE outreach_email_campaigns SET revoked_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2', [s.f.alpha.workspaceId, s.campaignId]);
    await s.f.db.query('UPDATE template_versions SET retired_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2', [s.f.alpha.workspaceId, s.input.templateVersionId]);
    const target = { campaignId: s.campaignId, expectedCampaignRevision: 1, policyId: result.policyId, policyRevision: 1, commandId: randomUUID(), clientVersion: '1.4.0' };
    expect(await s.call('revoke', target)).toMatchObject({ status: 409, body: { reason: 'stale_campaign' } });
    expect((await s.call('revoke', { ...target, expectedCampaignRevision: 2, commandId: randomUUID() }))?.status).toBe(200);
    expect(await s.current()).toMatchObject({ baseline: null, approvalState: 'already_configured', policy: { state: 'revoked' } });
  } finally { await s.stop(); }
}, 60000);
it('real DB clock after command receipt wait rolls back policy AND audit AND receipt on expiry', async () => {
  const s = await fixture(); try {
    const commandId = randomUUID(), input = { ...s.input, expiresAt: new Date(Date.now() + 1500).toISOString() };
    const delayed: SessionQueryable = { query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => { const result = await s.db.query<Row>(text, values); if (text.startsWith('INSERT INTO command_receipts')) await s.db.query('SELECT pg_sleep(2)'); return result; } };
    expect((await s.call('approve', { ...input, commandId, clientVersion: '1.4.0' }, delayed))?.status).toBe(409);
    expect((await s.db.query('SELECT id FROM outreach_campaign_opening_policies WHERE campaign_id=$1', [s.campaignId])).rows).toEqual([]);
    expect((await s.db.query("SELECT id FROM audit_events WHERE action='outreach.campaign_opening_approved'")).rows).toEqual([]);
    expect((await s.db.query('SELECT command_id FROM command_receipts WHERE command_id=$1', [commandId])).rows).toEqual([]);
  } finally { await s.stop(); }
}, 60000);
