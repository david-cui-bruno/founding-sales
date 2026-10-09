import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

describe('canonical CRM evidence and extraction', () => {
  let fixture: AuthFixture;
  let token: string;
  const post = (path: string, body: unknown) => dispatch({
    method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` }, body,
  }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
  const command = (fields: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
  beforeAll(async () => {
    fixture = await createAuthFixture();
    token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  });
  afterAll(async () => { await fixture.stop(); });
  it('resolves a selected original passage at its exact source revision through the authenticated evidence read', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Casey Morgan' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    expect((await post('/crm/people/source/add', command({
      personId, sourceKey: 'repair-evidence', excerpt: 'We need help coordinating repairs.', occurredAt: '2026-10-01T14:00:00.000Z',
    }))).status).toBe(200);
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const resolved = await post('/crm/processing/source/read', {
      workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: 'text:0:12',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({
      state: 'available', passage: { text: 'We need help', locator: 'text:0:12', speaker: null },
      source: { sourceId: source.sourceId, revision: 1, kind: 'selected_note', occurredAt: '2026-10-01T14:00:00.000Z', completeness: 'selected_excerpt' },
    });
  });
  it('reads exact source metadata for processing without returning the copied text', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Metadata reader' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'metadata-only', excerpt: 'Original note.', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const metadata = await post('/crm/processing/source/read', {
      workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: null,
    });
    expect(metadata.status).toBe(200);
    expect(metadata.body).toMatchObject({ state: 'available', passage: null, extent: { unit: 'utf16', length: 14 },
      source: { sourceId: source.sourceId, revision: 1, locator: null, speaker: null } });
    expect(JSON.stringify(metadata.body)).not.toContain('Original note.');
  });

  it('refuses a citation locator that splits an original Unicode character', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Unicode correspondent' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'unicode-source', excerpt: 'A😀B', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const lookup = { workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash };
    expect((await post('/crm/processing/source/read', { ...lookup, locator: 'text:1:2' })).status).toBe(404);
    expect((await post('/crm/processing/source/read', { ...lookup, locator: 'text:2:3' })).status).toBe(404);
    const resolved = await post('/crm/processing/source/read', { ...lookup, locator: 'text:1:3' });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ passage: { text: '😀' } });
  });

  it('retains one exact-source processing generation and reports missing purpose configuration without claiming extraction', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Processing correspondent' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'processing-source', excerpt: 'We need a repair coordinator.', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const lookup = { workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: null };
    const requested = await post('/crm/processing/request', command({ source: lookup }));
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({ result: { state: 'unavailable', reason: 'purpose_not_configured' } });
    const processing = await post('/crm/processing/read', { source: lookup });
    expect(processing.status).toBe(200);
    expect(processing.body).toMatchObject({ state: 'unavailable', reason: 'purpose_not_configured', claims: [],
      sourceRevision: 1, processorVersion: 'crm-extract-v1', modelVersion: null });
    const repeated = await post('/crm/processing/request', command({ source: lookup }));
    expect(repeated.status).toBe(200);
    expect((repeated.body as { result: { generationId: string } }).result.generationId)
      .toBe((requested.body as { result: { generationId: string } }).result.generationId);
    expect(JSON.stringify(processing.body)).not.toContain('We need a repair coordinator.');
  });

  it('reports absent extraction purpose and zero allowances without inheriting another model permission', async () => {
    const settings = await post('/crm/processing/purpose/read', {});
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({ enabled: false, configured: false, modelVersion: null, endpoint: null,
      dailyCeilingCents: 0, monthlyCeilingCents: 0, unavailableReason: 'purpose_not_configured' });
  });

  it('lets an administrator save a revision-bound purpose and budget while activation remains unavailable', async () => {
    const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const adminPost = (body: unknown) => dispatch({ method: 'POST', path: '/crm/processing/purpose/save',
      query: new URLSearchParams(), headers: { authorization: `Bearer ${adminToken}` }, body },
      { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
    const purpose = { expectedRevision: 0, enabled: false, endpointId: 'evaluation-adapter', modelVersion: 'fixture-model-v1',
      accessGrantVersion: 'fixture-purpose-grant-v1', dataHandlingVersion: 'fixture-data-policy-v1',
      dailyCeilingCents: 10, monthlyCeilingCents: 100, inputTokenPriceMicros: 2, outputTokenPriceMicros: 8 };
    expect((await post('/crm/processing/purpose/save', command(purpose))).status).toBe(409);
    const activation = await adminPost(command({ ...purpose, enabled: true }));
    expect(activation.status).toBe(409);
    expect(activation.body).toMatchObject({ reason: 'activation_not_available' });
    const saved = await adminPost(command(purpose));
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ result: { revision: 1, enabled: false } });
    expect((await post('/crm/processing/purpose/read', {})).body).toMatchObject({ configured: true, enabled: false,
      revision: 1, endpointId: 'evaluation-adapter', modelVersion: 'fixture-model-v1',
      unavailableReason: 'activation_not_available', dailyCeilingCents: 10 });
    expect((await adminPost(command(purpose))).status).toBe(409);
  });

  it('binds a requested generation to the configured purpose revision while retaining the activation refusal', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Configured processing correspondent' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'configured-source', excerpt: 'Please send the pricing.', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const lookup = { workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: null };
    const requested = await post('/crm/processing/request', command({ source: lookup }));
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({ result: { state: 'unavailable', reason: 'activation_not_available',
      purposeRevision: 1, modelVersion: 'fixture-model-v1' } });
    const processing = await post('/crm/processing/read', { source: lookup });
    expect(processing.body).toMatchObject({ state: 'unavailable', reason: 'activation_not_available', purposeRevision: 1 });
  });

  it('shows deleted processing coverage without exposing the removed source or reviving its generation on restore', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Deleted processing correspondent' }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: 'deleted-processing-source', excerpt: 'Confidential repair notes.', occurredAt: '2026-10-01T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0];
    if (source === undefined) throw new Error('source fixture unavailable');
    const lookup = { workspaceId: source.workspaceId, kind: 'selected_note', sourceId: source.sourceId,
      revision: source.revision, contentHash: source.contentHash, locator: null };
    expect((await post('/crm/processing/request', command({ source: lookup }))).status).toBe(200);
    const deleted = await post('/crm/people/source/delete', command({ personId, sourceId: source.sourceId, expectedRevision: 1 }));
    expect(deleted.status).toBe(200);
    const health = await post('/crm/processing/health/read', { sourceId: source.sourceId, kind: 'selected_note' });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ availability: 'deleted', generations: [{ state: 'deleted', reason: 'source_deleted' }] });
    expect(JSON.stringify(health.body)).not.toContain('Confidential repair notes.');
    expect((await post('/crm/processing/source/read', lookup)).status).toBe(404);
    expect((await post('/crm/people/source/restore', command({ personId, sourceId: source.sourceId, expectedRevision: 2 }))).status).toBe(200);
    expect((await post('/crm/processing/health/read', { sourceId: source.sourceId, kind: 'selected_note' })).body)
      .toMatchObject({ availability: 'awaiting_recapture', generations: [{ state: 'deleted' }] });
  });

});
