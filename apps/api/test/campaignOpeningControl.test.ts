import { beforeEach, expect, it, vi } from 'vitest';
import { routeCampaignOpeningControl, CAMPAIGN_OPENING_CONTROL_PATHS } from '../src/routes/campaignOpeningControl.ts';
import { authenticate, type AuthenticatedPrincipal } from '../src/auth/sessions.ts';
import type * as Sessions from '../src/auth/sessions.ts';
import type { AuthDeps } from '../src/auth/config.ts';
import type { RoutingOptions, ApiRequest } from '../src/routes/types.ts';
import { payloadHashOf } from '../src/auth/tokens.ts';
import { campaignOpeningControlFixture, controlId, controlOther, controlInput } from '../../../packages/domain/test/outreach/campaignOpeningControlFixture.ts';
vi.mock('../src/auth/sessions.ts', async original => ({ ...await original<typeof Sessions>(), authenticate: vi.fn() }));
const principal: AuthenticatedPrincipal = { workspaceId: controlId, userId: controlId, deviceId: controlId, sessionId: controlId,
  role: 'admin', membershipStatus: 'active', deviceStatus: 'active' };
let current: AuthenticatedPrincipal | null;
beforeEach(() => { current = { ...principal }; vi.mocked(authenticate).mockImplementation(async () => current
  ? { authenticated: true, principal: current } : { authenticated: false, refusal: 'session_ended' }); });
function setup() {
  const s = campaignOpeningControlFixture();
  // Identity authentication is explicitly mocked, ordinary runCommand/domain/receipt owners are real.
  const unused = (): never => { throw Error('Identity port must stay mocked in source test'); };
  const auth: AuthDeps = { db: s.db, config: {
    supportedClientVersions: { minimum: '1.2.0', ceiling: '1.4.x', incompatible: [] },
    oidc: { issuer: '', discoveryUrl: '', clientId: '', clientSecret: '', redirectUri: '', hostedDomain: '', clockSkewSeconds: 0 },
    sessions: { accessSessionSeconds: 3600, fullSignInSeconds: 3600, authorizationRequestSeconds: 600 }, stateSigningKey: Buffer.alloc(0),
  }, google: { discovery: unused, signingKey: unused, exchangeCode: unused, verifySignature: unused }, now: () => new Date(), randomSecret: unused };
  const options = { auth } as RoutingOptions;
  const request = (action: string, body: unknown): ApiRequest => ({ method: 'POST', path: `/outreach/email-campaigns/opening/${action}`, headers: {}, query: new URLSearchParams(), body });
  const call = (action: string, body: unknown) => routeCampaignOpeningControl(request(action, body), options);
  const approve = () => call('approve', { ...controlInput, commandId: controlId, clientVersion: '1.4.0' });
  const receipt = (patch: Record<string, unknown> = {}) => call('receipt', { commandId: controlId, action: 'approve', payloadSHA256: payloadHashOf(controlInput), ...patch });
  return { ...s, auth, options, request, call, approve, receipt };
}
it('claims only four exact POST paths and refuses nonadmins/malformed payload before content/mutation', async () => {
  const s = setup(); expect(CAMPAIGN_OPENING_CONTROL_PATHS).toHaveLength(4);
  expect(await s.call('other', {})).toBeNull();
  expect((await routeCampaignOpeningControl({ ...s.request('control', {}), method: 'GET' }, s.options))?.status).toBe(405);
  expect((await s.call('approve', { ...controlInput, commandId: controlId, clientVersion: '1.4.0', ownerUserId: controlId }))?.status).toBe(400);
  current = { ...principal, role: 'salesperson' }; expect((await s.call('control', { campaignId: controlId }))?.status).toBe(403);
  expect(s.state.policy).toBeNull(); expect(s.statements.some(x => x.sql.includes('INSERT'))).toBe(false);
});
it('actual command owner persists opaque acceptance and receipt read uses exact hash/kind/device/user, never replays', async () => {
  const s = setup(); const accepted = await s.approve(); expect(accepted?.status).toBe(200);
  expect(accepted?.body).toMatchObject({ status: 'accepted', replayed: false, result: { campaignId: controlId, policyRevision: 1 } });
  expect(s.state.receipts.size).toBe(1); expect(JSON.stringify([...s.state.receipts.values()])).not.toContain('Approved {{firm_name}}');
  s.statements.length = 0;
  expect(await s.receipt()).toMatchObject({ status: 200, body: { state: 'accepted', result: { campaignId: controlId, policyRevision: 1 } } });
  expect(s.statements.find(x => x.sql.includes('FROM command_receipts'))?.values).toEqual([controlId, controlId, controlId, controlId, 'outreach.campaign_opening_approve', payloadHashOf(controlInput)]);
  expect(s.statements.every(x => !/^(INSERT|UPDATE|DELETE)/u.test(x.sql))).toBe(true);
});
it.each(['hash', 'kind', 'device', 'user', 'workspace'] as const)('%s receipt collision exposes UNKNOWN only', async mode => {
  const s = setup(); await s.approve();
  if (mode === 'device') current = { ...principal, deviceId: controlOther };
  if (mode === 'user') current = { ...principal, userId: controlOther };
  if (mode === 'workspace') current = { ...principal, workspaceId: controlOther };
  expect(await s.receipt(mode === 'hash' ? { payloadSHA256: 'b'.repeat(64) } : mode === 'kind' ? { action: 'revoke' } : {})).toMatchObject({ status: 200, body: { state: 'unknown' } });
});
it('native same-ID replay does not mutate and fresh principal is checked again on that replay', async () => {
  const s = setup(); await s.approve(); const audits = s.state.audits.length;
  expect(await s.approve()).toMatchObject({ status: 200, body: { status: 'accepted', replayed: true } }); expect(s.state.audits).toHaveLength(audits);
  s.hook(async sql => { if (sql.includes('FROM command_receipts')) current = null; });
  expect((await s.approve())?.status).toBe(401); expect(s.state.audits).toHaveLength(audits);
});
it.each(['session', 'device', 'role', 'revoked'] as const)('receipt %s loss across read wait rolls back and withholds result', async mode => {
  const s = setup(); await s.approve(); s.statements.length = 0;
  s.hook(async sql => { if (sql.includes('FROM command_receipts')) current = mode === 'revoked' ? null : mode === 'role'
    ? { ...principal, role: 'salesperson' } : { ...principal, [mode === 'session' ? 'sessionId' : 'deviceId']: controlOther }; });
  expect((await s.receipt())?.status).toBe(401); expect(s.statements.at(-1)?.sql).toBe('ROLLBACK');
});
it.each(['principal', 'expiry', 'template'] as const)('after-receipt %s loss rolls back policy/audit/receipt atomically', async mode => {
  const s = setup(); s.hook(async sql => { if (sql.includes('INSERT INTO command_receipts')) {
    if (mode === 'principal') current = null;
    if (mode === 'expiry') s.state.now = controlInput.expiresAt;
    if (mode === 'template') s.state.baseline = null;
  } });
  expect([401, 409]).toContain((await s.approve())?.status); expect(s.state.policy).toBeNull(); expect(s.state.audits).toEqual([]); expect(s.state.receipts.size).toBe(0);
});
it('revokes after campaign stop/template loss, and a second approval cannot replace persisted tombstone', async () => {
  const s = setup(); await s.approve(); const policyId = s.state.policy!.id;
  s.state.campaign.revoked_at = new Date(s.state.now); s.state.campaign.revision = 2; s.state.baseline = null;
  expect(await s.call('revoke', { campaignId: controlId, expectedCampaignRevision: 2, policyId, policyRevision: 1, commandId: controlOther, clientVersion: '1.4.0' })).toMatchObject({ status: 200, body: { status: 'accepted', result: { policyId } } });
  expect(await s.call('control', { campaignId: controlId })).toMatchObject({ status: 200, body: { baseline: null, approvalState: 'already_configured', policy: { state: 'revoked' }, selectorReadiness: 'not_established' } });
});
it('malformed read/receipt inputs and opaque accepted-result contamination are refused', async () => {
  const s = setup(); expect((await s.call('control', { campaignId: controlId, body: 'no' }))?.status).toBe(400);
  expect((await s.receipt({ text: 'not allowed' }))?.status).toBe(400);
  await s.approve(); s.state.receipts.get(controlId)!.result = { campaignId: controlId, policyId: controlId, policyRevision: 1, text: 'must not escape' };
  await expect(s.receipt()).rejects.toThrow();
});
