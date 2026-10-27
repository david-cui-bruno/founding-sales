import { expect, it } from 'vitest';
import { campaignOpeningApproveInputSchema, campaignOpeningPolicySchema } from '@fss/contracts';
import { approveCampaignOpening, revokeCampaignOpening, readCampaignOpeningControl, assertCampaignOpeningControlCommit } from '../../outreach/campaignOpeningControl.ts';
import { resolveCampaignOpening, prefixCampaignOpening, type CampaignOpeningSelector } from '../../outreach/campaignOpening.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { campaignOpeningControlFixture, controlId, controlOther, controlInput } from './campaignOpeningControlFixture.ts';
const authority = async (): Promise<boolean> => true;
it('reads full exact baseline, approves immutable provenance, revokes without audience/settings/attempt writes', async () => {
  const s = campaignOpeningControlFixture();
  expect(await readCampaignOpeningControl(s.context, { campaignId: controlId }, authority)).toMatchObject({ baseline: { subject: 'Exact subject', body: 'Exact baseline\n\nSigned off' }, policy: null, approvalState: 'available', selectorReadiness: 'not_established', sendingAuthority: 'unchanged' });
  s.statements.length = 0;
  const approved = await approveCampaignOpening(s.context, controlInput, authority);
  expect(approved).toMatchObject({ ok: true, value: { campaignId: controlId, policyRevision: 1 } });
  expect(s.statements[0]?.sql).toContain('pg_advisory_xact_lock');
  const configured = await readCampaignOpeningControl(s.context, { campaignId: controlId }, authority);
  expect(configured).toMatchObject({ approvalState: 'already_configured', policy: { state: 'active', value: { ownerUserId: controlId, variants: controlInput.variants, revision: 1 } } });
  const row = s.state.policy!;
  expect(await revokeCampaignOpening(s.context, { campaignId: controlId, expectedCampaignRevision: 1, policyId: row.id, policyRevision: 1 }, authority)).toMatchObject({ ok: true });
  expect(await approveCampaignOpening(s.context, controlInput, authority)).toEqual({ ok: false, reason: 'already_configured' });
  expect(await readCampaignOpeningControl(s.context, { campaignId: controlId }, authority)).toMatchObject({ approvalState: 'already_configured', policy: { state: 'revoked' } });
  const writes = s.statements.filter(x => /^(INSERT|UPDATE|DELETE)/u.test(x.sql));
  expect(writes.every(x => /^(INSERT INTO (outreach_campaign_opening_policies|audit_events)|UPDATE outreach_campaign_opening_policies)/u.test(x.sql))).toBe(true);
  expect(s.state.audits).toHaveLength(2); expect(JSON.stringify(s.state.audits)).not.toContain('Approved {{firm_name}}');
});
it.each(['expired', 'campaign_revoked', 'template_lost'] as const)('revokes exact policy after %s without replacing tombstone or checking unavailable baseline', async mode => {
  const s = campaignOpeningControlFixture(); await approveCampaignOpening(s.context, controlInput, authority);
  if (mode === 'expired') s.state.now = '2026-11-01T01:30:00.000Z';
  if (mode === 'campaign_revoked') { s.state.campaign.revoked_at = new Date(s.state.now); s.state.campaign.revision = 2; }
  if (mode === 'template_lost') s.state.baseline = null;
  s.statements.length = 0;
  expect(await revokeCampaignOpening(s.context, { campaignId: controlId, expectedCampaignRevision: s.state.campaign.revision, policyId: s.state.policy!.id, policyRevision: 1 }, authority)).toMatchObject({ ok: true });
  expect(s.statements.some(x => x.sql.includes('FROM sequence_versions'))).toBe(false);
  expect(s.state.policy?.revoked_at).not.toBeNull();
});
it.each(['stale', 'foreign', 'template', 'expired', 'beyond_campaign', 'campaign_revoked', 'template_lost', 'oversized'] as const)('refuses %s approval without mutation', async mode => {
  const s = campaignOpeningControlFixture(), input = structuredClone(controlInput);
  if (mode === 'stale') input.expectedCampaignRevision = 2;
  if (mode === 'foreign') input.campaignId = controlOther;
  if (mode === 'template') input.templateContentHash = 'b'.repeat(64);
  if (mode === 'expired') input.expiresAt = s.state.now;
  if (mode === 'beyond_campaign') input.expiresAt = '2026-12-01T00:00:00.000Z';
  if (mode === 'campaign_revoked') s.state.campaign.revoked_at = new Date(s.state.now);
  if (mode === 'template_lost') s.state.baseline = null;
  if (mode === 'oversized') s.state.baseline!.body = 'x'.repeat(100001);
  expect(await approveCampaignOpening(s.context, input, authority)).toMatchObject({ ok: false });
  expect(s.state.policy).toBeNull(); expect(s.state.audits).toEqual([]);
});
it.each(['salesperson', 'system', 'inactive', 'other_owner'] as const)('no %s current policy visibility or approval authority', async mode => {
  const s = campaignOpeningControlFixture();
  const context = mode === 'salesperson' ? repositoryContext(workspaceScope(controlId, { kind: 'user', role: 'salesperson', userId: controlId }), s.db)
    : mode === 'system' ? repositoryContext(workspaceScope(controlId, { kind: 'system', component: 'worker' }), s.db) : s.context;
  if (mode === 'inactive') s.state.active = false;
  if (mode === 'other_owner') s.state.campaign.owner_user_id = controlOther;
  expect(await readCampaignOpeningControl(context, { campaignId: controlId }, authority)).toBeNull();
  expect(await approveCampaignOpening(context, controlInput, authority)).toMatchObject({ ok: false }); expect(s.state.policy).toBeNull();
});
it.each(['principal', 'membership', 'expiry', 'template', 'campaign'] as const)('rolls back approval AND audit on delayed %s loss', async mode => {
  const s = campaignOpeningControlFixture(); let allowed = true;
  s.hook(async sql => { if (sql.startsWith('INSERT INTO audit_events')) {
    if (mode === 'principal') allowed = false;
    if (mode === 'membership') s.state.active = false;
    if (mode === 'expiry') s.state.now = controlInput.expiresAt;
    if (mode === 'template') s.state.baseline = null;
    if (mode === 'campaign') s.state.campaign.revision = 2;
  } });
  expect(await approveCampaignOpening(s.context, controlInput, async () => allowed)).toMatchObject({ ok: false });
  expect(s.state.policy).toBeNull(); expect(s.state.audits).toEqual([]);
});
it('final after-receipt fence uses clock after its last authority wait', async () => {
  const s = campaignOpeningControlFixture(); await approveCampaignOpening(s.context, controlInput, authority);
  let checks = 0;
  await expect(assertCampaignOpeningControlCommit(s.context, controlInput, async () => { if (++checks === 2) s.state.now = controlInput.expiresAt; return true; })).rejects.toThrow('expiry_invalid');
  expect(s.statements.at(-1)?.sql).toBe('SELECT clock_timestamp() AS now');
});
it('informs unavailable rather than truncating and withholds a baseline changed during read', async () => {
  const s = campaignOpeningControlFixture(); s.state.baseline!.body = 'x'.repeat(100001);
  expect(await readCampaignOpeningControl(s.context, { campaignId: controlId }, authority)).toMatchObject({ baseline: null, approvalState: 'unavailable' });
  s.state.baseline!.body = 'Exact'; let reads = 0;
  s.hook(async sql => { if (sql.includes('FROM sequence_versions') && ++reads === 2) s.state.baseline!.body = 'Changed'; });
  expect(await readCampaignOpeningControl(s.context, { campaignId: controlId }, authority)).toBeNull();
});
it('withholds exact baseline changed during the final retained-principal wait', async () => {
  const s = campaignOpeningControlFixture(); let checks = 0;
  expect(await readCampaignOpeningControl(s.context, { campaignId: controlId }, async () => { if (++checks === 2) s.state.baseline!.body = 'Changed during authority wait'; return true; })).toBeNull();
});
it.each([[], Array.from({ length: 9 }, (_, i) => ({ id: `v_${i}`, text: 'Approved' })), [{ id: 'same', text: 'A' }, { id: 'same', text: 'B' }], [{ id: 'a', text: '{{recipient_email}}' }], [{ id: 'a', text: '<script>' }], [{ id: 'a', text: 'A\nB' }], [{ id: 'a', text: 'A\tB' }]].map(variants => [variants]))('rejects malformed or unusable lines %#', async variants => {
  const s = campaignOpeningControlFixture(); expect(await approveCampaignOpening(s.context, { ...controlInput, variants }, authority)).toMatchObject({ ok: false }); expect(s.state.policy).toBeNull();
});
it('new approved owner control feeds existing fake selector exact choice/prefix without changing baseline or invoking sends', async () => {
  const s = campaignOpeningControlFixture(); await approveCampaignOpening(s.context, campaignOpeningApproveInputSchema.parse(controlInput), authority);
  const policy = campaignOpeningPolicySchema.parse(s.state.policy!.policy);
  const snapshot = { policy, source: { firmName: 'Fictional Homes', locality: 'Dallas', region: 'TX' }, citationIds: ['current:public'],
    binding: { workspaceId: controlId, ownerUserId: controlId, campaignId: controlId, campaignRevision: 1, policyId: policy.id,
      sequenceVersionId: controlId, templateVersionId: controlId, templateContentHash: controlInput.templateContentHash,
      enrollmentId: controlId, executionId: controlId, firmId: controlId, candidateId: controlId, candidateRevision: 1,
      qualificationRunId: controlId, sourceFingerprint: 'b'.repeat(64), validUntil: controlInput.expiresAt } };
  const selector: CampaignOpeningSelector = { select: async () => ({ kind: 'selected', choice: { variantId: 'local', citationIds: ['current:public'] } }) };
  const selected = await selector.select({ ...snapshot, attemptId: controlId }); expect(selected.kind).toBe('selected');
  const line = resolveCampaignOpening(snapshot, selected.kind === 'selected' ? selected.choice : null, s.state.now); expect(line).toBe('Approved Fictional Homes line.');
  expect(prefixCampaignOpening({ subject: s.state.baseline!.subject, body: s.state.baseline!.body }, line!)).toEqual({ subject: 'Exact subject', body: 'Approved Fictional Homes line.\n\nExact baseline\n\nSigned off' });
});
