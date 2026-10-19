import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { CRM_EXTRACTION_ENDPOINT, CRM_EXTRACTION_MODELS, crmExtractionPurposeSchema, crmCapabilityReadResponseSchema } from '@fss/contracts';
import { createCrmCapabilityRuntime, readCrmCapabilityStartup } from '@fss/domain/crm/capabilityStartup.ts';
import { crmCapabilityConfigurationFingerprint } from '@fss/domain/crm/capabilityAuthority.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

let f: AuthFixture, owner: string, salesperson: string;
const versions = { minimum: '1.0.51', ceiling: '1.4.x', incompatible: [] };
const purpose = { expectedRevision: 0, enabled: false, endpointId: CRM_EXTRACTION_ENDPOINT,
  modelVersion: CRM_EXTRACTION_MODELS[0], accessGrantVersion: 'fixture-reviewed-access', dataHandlingVersion: 'fixture-reviewed-handling',
  dailyCeilingCents: 100, monthlyCeilingCents: 2000, inputTokenPriceMicros: '1.1', outputTokenPriceMicros: '5.5' };
const config = readCrmCapabilityStartup({ FSS_CRM_CAPABILITY_ADAPTERS: JSON.stringify({ extraction: {
  region: 'us-east-1', ...purpose, expectedRevision: undefined, enabled: undefined,
  dailyCeilingCents: undefined, monthlyCeilingCents: undefined, inputTokenPriceMicros: undefined, outputTokenPriceMicros: undefined,
  providerKey: 'aws_bedrock.fixture', fundingVerifiedUntil: '2099-01-01T00:00:00Z',
} }) });
const runtime = createCrmCapabilityRuntime(config, { implementationCommit: null, imageDigest: null, side: 'api', schemaVersion: 116, gmailAvailable: false });
const command = (body: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: '1.0.51', ...body });
function post(path: string, body: unknown, token: string | null = owner, run = runtime) {
  return dispatch({ method: 'POST', path, body, query: new URLSearchParams(), headers: token ? { authorization: `Bearer ${token}` } : {} }, {
    session: f.db, auth: { ...f.deps, config: { ...f.deps.config, supportedClientVersions: versions } },
    supportedClientVersions: versions, sendingEnabled: false, crmCapabilityRuntime: run,
  });
}
beforeAll(async () => {
  f = await createAuthFixture();
  owner = (await issueSessionFor(f, f.alpha, f.alpha.admin)).accessToken;
  salesperson = (await issueSessionFor(f, f.alpha, f.alpha.salesperson)).accessToken;
});
afterAll(async () => { await f.stop(); });

it('retains strict legacy default shape and requires authenticated administrator configuration', async () => {
  expect((await post('/crm/processing/purpose/read', {}, null)).status).toBe(401);
  expect(crmExtractionPurposeSchema.parse((await post('/crm/processing/purpose/read', {})).body)).toEqual({
    configured: false, enabled: false, revision: 0, endpoint: null, modelVersion: null,
    dailyCeilingCents: 0, monthlyCeilingCents: 0, unavailableReason: 'purpose_not_configured',
  });
  expect((await post('/crm/processing/purpose/save', command(purpose), salesperson)).body).toMatchObject({ status: 'refused', reason: 'purpose_access_denied' });
  expect((await post('/crm/processing/purpose/save', command({ ...purpose, enabled: true }))).body).toMatchObject({ status: 'refused', reason: 'activation_not_available' });
});
it('saves only disabled exact settings through the 1.0.51 contract, with no work or consent minted', async () => {
  const answer = await post('/crm/processing/purpose/save', command(purpose));
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ status: 'accepted', result: { revision: 1, enabled: false } });
  const { expectedRevision: _revision, ...settings } = purpose;
  expect(crmExtractionPurposeSchema.parse((await post('/crm/processing/purpose/read', {})).body)).toEqual({
    ...settings, configured: true, revision: 1, unavailableReason: 'activation_not_available',
  });
  const view = crmCapabilityReadResponseSchema.parse((await post('/crm/capability/read', { capability: 'crm_extraction' })).body);
  expect(view).toMatchObject({ enabled: false, ready: false, reason: 'adapter_or_configuration_unavailable', authorityReceiptId: null, ownerApprovalId: null });
  expect((await f.db.query('SELECT 1 FROM crm_capability_owner_approvals')).rows).toHaveLength(0);
  expect((await f.db.query('SELECT 1 FROM crm_capability_authority_receipts')).rows).toHaveLength(0);
  expect((await f.db.query("SELECT 1 FROM jobs WHERE kind='crm.extract'")).rows).toHaveLength(0);
  expect((await post('/crm/processing/purpose/save', command(purpose))).body).toMatchObject({ status: 'refused', reason: 'purpose_revision_conflict' });
});
it('rejects malformed configuration and fabricated consent fields without changing the revision', async () => {
  for (const patch of [{ inputTokenPriceMicros: 0 }, { outputTokenPriceMicros: '5.1234567' }, { dailyCeilingCents: 0 }, { monthlyCeilingCents: 1.5 }, { authorityReceiptId: randomUUID() }, { approval: { consentAcknowledged: true } }]) {
    expect((await post('/crm/processing/purpose/save', command({ ...purpose, expectedRevision: 1, ...patch }))).status).toBe(400);
  }
  expect((await post('/crm/processing/purpose/read', {})).body).toMatchObject({ revision: 1, enabled: false });
});
it('keeps runtime endpoint/model/access/handling/funding bindings fail closed and price/budget fingerprinted', async () => {
  const baseline = crmCapabilityReadResponseSchema.parse((await post('/crm/capability/read', { capability: 'crm_extraction' })).body).configuration!;
  for (const patch of [{ endpointId: 'unreviewed' }, { modelVersion: 'stale-model' }, { accessGrantVersion: 'stale-access' }, { dataHandlingVersion: 'stale-handling' }]) {
    const changed = { ...baseline, ...patch };
    expect(runtime.adapterAvailable(changed)).toBe(false);
    expect(crmCapabilityConfigurationFingerprint(changed)).not.toBe(crmCapabilityConfigurationFingerprint(baseline));
  }
  for (const patch of [{ dailyCeilingCents: 101 }, { monthlyCeilingCents: 2001 }, { inputTokenPriceMicros: '1.2' }, { outputTokenPriceMicros: '5.6' }]) {
    expect(crmCapabilityConfigurationFingerprint({ ...baseline, ...patch })).not.toBe(crmCapabilityConfigurationFingerprint(baseline));
  }
  const expired = createCrmCapabilityRuntime({ ...config, extraction: { ...config.extraction!, fundingVerifiedUntil: '2000-01-01T00:00:00Z' } }, { implementationCommit: null, imageDigest: null, side: 'api', schemaVersion: 116, gmailAvailable: false });
  expect((await post('/crm/capability/read', { capability: 'crm_extraction' }, owner, expired)).body).toMatchObject({ ready: false, enabled: false, reason: 'adapter_or_configuration_unavailable' });
});
