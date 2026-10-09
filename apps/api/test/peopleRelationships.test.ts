import { correctEndpoint } from '@fss/domain/crm/endpoints.ts';
import { changeFirmSource } from '@fss/domain/crm/firmSources.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { correctRelationship } from '@fss/domain/crm/relationships.ts';
import { changeSelectedSource } from '@fss/domain/crm/people.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { reassignFirm } from '@fss/domain/crm/firms.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
describe('source-backed relationships and endpoint identity', () => {
  let fixture: AuthFixture;
  let token: string;
  const post = async (path: string, body: unknown, bearer = token) => dispatch({ method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${bearer}` }, body }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
  const command = (fields: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
  const personWithSource = async (fullName: string, excerpt = 'Business association selected by David') => {
    const create = await post('/crm/people/create', command({ fullName }));
    const personId = (create.body as {
      result: {
        personId: string;
      };
    }).result.personId;
    await post('/crm/people/source/add', command({ personId, sourceKey: randomUUID(), excerpt, occurredAt: '2026-09-15T14:00:00.000Z' }));
    const page = await post('/crm/people/read', { personId });
    const source = (page.body as {
      sources: {
        sourceId: string;
        revision: number;
        contentHash: string;
      }[];
    }).sources[0];
    if (source === undefined)
      throw new Error('Fixture source unavailable');
    return { personId, evidence: { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash } };
  };
  beforeAll(async () => { fixture = await createAuthFixture(); token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken; });
  afterAll(async () => { await fixture.stop(); });
  it('shows several supported firm relationships with explicitly unknown dates', async () => {
    const { personId, evidence } = await personWithSource('Taylor Park');
    const first = await seedFirm(fixture, { name: 'First portfolio', assignedUserId: fixture.alpha.salesperson.userId });
    const second = await seedFirm(fixture, { name: 'Second portfolio', assignedUserId: fixture.alpha.salesperson.userId });
    for (const firmId of [first, second]) {
      expect((await post('/crm/relationships/save', command({ personId, firmId, status: 'current', startDate: null, endDate: null, evidence }))).status).toBe(200);
    }
    const read = await post('/crm/relationships/read', { personId });
    expect(read.status).toBe(200);
    const body = read.body as {
      relationships: unknown[];
    };
    expect(body.relationships).toHaveLength(2);
    expect(body.relationships).toEqual(expect.arrayContaining([{ relationshipId: expect.any(String), personId, firmId: first, firmName: 'First portfolio', status: 'current', startDate: null, endDate: null, revision: 1, evidence, sourceState: 'available', contextReview: 'current' }]));
    expect((await post('/crm/people/read', { personId })).body).toMatchObject({ person: { firm: null } });
  });
  it('corrects a relationship without rewriting the original source context', async () => {
    const { personId, evidence } = await personWithSource('Avery Fields');
    const oldFirm = await seedFirm(fixture, { name: 'Original firm', assignedUserId: fixture.alpha.salesperson.userId });
    const newFirm = await seedFirm(fixture, { name: 'Corrected firm', assignedUserId: fixture.alpha.salesperson.userId });
    const saved = await post('/crm/relationships/save', command({ personId, firmId: oldFirm, status: 'unknown', startDate: null, endDate: null, evidence }));
    const relationshipId = (saved.body as {
      result: {
        relationshipId: string;
      };
    }).result.relationshipId;
    expect((await post('/crm/relationships/context/save', command({ personId, relationshipId, relationshipRevision: 1, evidence }))).status).toBe(200);
    expect((await post('/crm/relationships/correct', command({ personId, relationshipId, expectedRevision: 1, firmId: newFirm, status: 'historical', startDate: '2025-01-01', endDate: '2026-01-01', evidence }))).status).toBe(200);
    expect((await post('/crm/relationships/context/read', { personId })).body).toMatchObject({ contexts: [{ sourceId: evidence.sourceId, relationshipId, relationshipRevision: 1, firmId: oldFirm, review: 'required' }] });
    expect((await post('/crm/relationships/read', { personId })).body).toMatchObject({ relationships: [{ firmId: newFirm, revision: 2, contextReview: 'required' }] });
    expect((await post('/crm/relationships/correct', command({ personId, relationshipId, expectedRevision: 1, firmId: oldFirm, status: 'current', startDate: null, endDate: null, evidence }))).status).toBe(409);
    expect((await post('/crm/people/read', { personId })).body).toMatchObject({ person: { firm: null }, sources: [{ revision: 1 }] });
  });
  it('rereads context review after a concurrent relationship correction commits', async () => {
    const { personId, evidence } = await personWithSource('Concurrent context correction');
    const firmId = await seedFirm(fixture, { name: 'Concurrent relationship firm', assignedUserId: fixture.alpha.salesperson.userId });
    const saved = await post('/crm/relationships/save', command({ personId, firmId, status: 'current', startDate: null, endDate: null, evidence }));
    const relationshipId = (saved.body as {
      result: {
        relationshipId: string;
      };
    }).result.relationshipId;
    await post('/crm/relationships/context/save', command({ personId, relationshipId, relationshipRevision: 1, evidence }));
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await correctRelationship(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }), holder), { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, personId, relationshipId, expectedRevision: 1, firmId, status: 'historical', startDate: null, endDate: null, evidence });
    const pending = post('/crm/relationships/context/read', { personId });
    try {
      await waitForBlock(observer, pid);
    }
    finally {
      await holder.query('COMMIT');
    }
    expect((await pending).body).toMatchObject({ contexts: [{ relationshipId, relationshipRevision: 1, review: 'required' }] });
  });
  it('publishes no old source context after deletion commits while the read is waiting', async () => {
    const { personId, evidence } = await personWithSource('Concurrent context deletion', 'Secret context body');
    const firmId = await seedFirm(fixture, { name: 'Concurrent deleted context firm', assignedUserId: fixture.alpha.salesperson.userId });
    const saved = await post('/crm/relationships/save', command({ personId, firmId, status: 'current', startDate: null, endDate: null, evidence }));
    const relationshipId = (saved.body as {
      result: {
        relationshipId: string;
      };
    }).result.relationshipId;
    await post('/crm/relationships/context/save', command({ personId, relationshipId, relationshipRevision: 1, evidence }));
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await changeSelectedSource(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }), holder), { personId, sourceId: evidence.sourceId, expectedRevision: 1 }, 'delete');
    const pending = post('/crm/relationships/context/read', { personId });
    try {
      await waitForBlock(observer, pid);
    }
    finally {
      await holder.query('COMMIT');
    }
    expect((await pending).status).toBe(404);
  });
  it('waits for deletion of separate firm evidence before publishing a surviving context review state', async () => {
    const identity = await personWithSource('Separate firm provenance race');
    const firmId = await seedFirm(fixture, { name: 'Deleted relationship evidence firm', assignedUserId: fixture.alpha.salesperson.userId });
    const added = await post('/crm/firm-sources/add', command({ firmId, sourceKey: randomUUID(), excerpt: 'Independent relationship evidence', occurredAt: '2026-09-15T14:00:00.000Z' }));
    const sourceId = (added.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    const source = ((await post('/crm/firm-sources/read', { firmId })).body as {
      sources: {
        revision: number;
        contentHash: string;
      }[];
    }).sources[0];
    if (source === undefined)
      throw new Error('Firm evidence missing');
    const contextFirmId = await seedFirm(fixture, { name: 'Surviving context firm', assignedUserId: fixture.alpha.salesperson.userId });
    const saved = await post('/crm/relationships/save', command({ personId: identity.personId, firmId: contextFirmId, status: 'current', startDate: null, endDate: null, evidence: { sourceId, sourceRevision: source.revision, contentHash: source.contentHash } }));
    const relationshipId = (saved.body as {
      result: {
        relationshipId: string;
      };
    }).result.relationshipId;
    await post('/crm/relationships/context/save', command({ ...identity, relationshipId, relationshipRevision: 1 }));
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await changeFirmSource(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }), holder), { firmId, sourceId, expectedRevision: 1 }, 'delete');
    const pending = post('/crm/relationships/context/read', { personId: identity.personId });
    try {
      await waitForBlock(observer, pid);
    }
    finally {
      await holder.query('COMMIT');
    }
    expect((await pending).body).toMatchObject({ contexts: [{ relationshipId, review: 'required' }] });
  });
  it('refuses cross-workspace relationships, evidence and endpoint identity disclosure', async () => {
    const identity = await personWithSource('Alpha isolated identity');
    const firmId = await seedFirm(fixture, { name: 'Alpha isolated firm', assignedUserId: fixture.alpha.salesperson.userId });
    const betaToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.salesperson)).accessToken;
    expect((await post('/crm/relationships/save', command({ ...identity, firmId, status: 'current', startDate: null, endDate: null }), betaToken)).status).toBe(409);
    expect((await post('/crm/relationships/read', { personId: identity.personId }, betaToken)).status).toBe(404);
    await post('/crm/endpoints/claim', command({ ...identity, kind: 'email', value: 'workspace@private.example.test', firmId: null, shared: false, status: 'current', startDate: '2026-01-01', endDate: null }));
    expect((await post('/crm/endpoints/match', { kind: 'email', value: 'workspace@private.example.test' }, betaToken)).body).toMatchObject({ outcome: 'no_supported_match', candidates: [] });
    expect((await post('/crm/endpoints/list', {}, betaToken)).body).toMatchObject({ claims: [] });
  });
  it('rejects invalid dates and mixed endpoint subjects without guessing missing phone country codes', async () => {
    const identity = await personWithSource('Strict evidence identity');
    const firmId = await seedFirm(fixture, { name: 'Strict identity firm', assignedUserId: fixture.alpha.salesperson.userId });
    for (const startDate of ['2026-02-30', '0000-01-01', '2026-13-01']) {
      expect((await post('/crm/relationships/save', command({ ...identity, firmId, status: 'current', startDate, endDate: null }))).status).toBe(400);
    }
    expect((await post('/crm/relationships/save', command({ ...identity, firmId, status: 'current', startDate: '2026-09-01', endDate: '2026-01-01' }))).status).toBe(409);
    expect((await post('/crm/endpoints/claim', command({ ...identity, kind: 'email', value: 'mixed@example.test', firmId, shared: true, status: 'current', startDate: null, endDate: null }))).status).toBe(400);
    expect((await post('/crm/endpoints/claim', command({ ...identity, kind: 'phone', value: '4155550123', firmId: null, shared: false, status: 'current', startDate: null, endDate: null }))).status).toBe(409);
  });
  it('matches one supported identity but keeps recycled and overlapping endpoints unresolved', async () => {
    const first = await personWithSource('Same Name', 'Morgan uses morgan@example.test since 2026-01-01');
    const second = await personWithSource('Same Name', 'Another person later uses the same address');
    const firstClaim = await post('/crm/endpoints/claim', command({ ...first, kind: 'email', value: 'morgan@EXAMPLE.test', firmId: null, shared: false, status: 'current', startDate: '2026-01-01', endDate: null }));
    expect(firstClaim.status).toBe(200);
    expect((await post('/crm/endpoints/match', { kind: 'email', value: 'morgan@example.test' })).body).toMatchObject({ outcome: 'person_match', personId: first.personId, firmId: null });
    expect((await post('/crm/endpoints/claim', command({ ...second, kind: 'email', value: 'morgan@example.test', firmId: null, shared: false, status: 'historical', startDate: null, endDate: null }))).status).toBe(200);
    const ambiguous = await post('/crm/endpoints/match', { kind: 'email', value: 'morgan@example.test' });
    expect(ambiguous.body).toMatchObject({ outcome: 'needs_review', personId: null, firmId: null });
    expect((ambiguous.body as {
      candidates: unknown[];
    }).candidates).toHaveLength(2);
    expect((await post('/crm/endpoints/match', { kind: 'email', value: 'morgan+other@example.test' })).body).toMatchObject({ outcome: 'no_supported_match' });
  });
  it('keeps future and expired current claims in review rather than matching them today', async () => {
    for (const [value, startDate, endDate] of [['future@time.example.test', '2999-01-01', null], ['expired@time.example.test', '2020-01-01', '2020-12-31']]) {
      const identity = await personWithSource('Temporal identity');
      expect((await post('/crm/endpoints/claim', command({ ...identity, kind: 'email', value, firmId: null, shared: false, status: 'current', startDate, endDate }))).status).toBe(200);
      expect((await post('/crm/endpoints/match', { kind: 'email', value })).body).toMatchObject({ outcome: 'needs_review', personId: null, firmId: null });
    }
  });
  it('represents a shared firm address without creating a human speaker', async () => {
    const firmId = await seedFirm(fixture, { name: 'Shared firm', assignedUserId: fixture.alpha.salesperson.userId });
    expect((await post('/crm/firm-sources/add', command({ firmId, sourceKey: 'shared evidence', excerpt: 'Our shared office address is info@shared.example.test', occurredAt: '2026-09-15T14:00:00.000Z' }))).status).toBe(200);
    const page = await post('/crm/firm-sources/read', { firmId });
    expect(page.status).toBe(200);
    const source = (page.body as {
      sources: {
        sourceId: string;
        revision: number;
        contentHash: string;
      }[];
    }).sources[0];
    if (source === undefined)
      throw new Error('Shared source missing');
    const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
    const claimed = await post('/crm/endpoints/claim', command({ personId: null, firmId, shared: true, kind: 'email', value: 'info@shared.example.test', status: 'current', startDate: '2026-09-15', endDate: null, evidence }));
    expect(claimed.status).toBe(200);
    expect((await post('/crm/endpoints/match', { kind: 'email', value: 'info@shared.example.test' })).body).toMatchObject({ outcome: 'firm_endpoint_match', personId: null, firmId, candidates: [{ personId: null, personName: null, shared: true }] });
  });
  it('keeps original firm authority on firm-owned evidence after another context is attached', async () => {
    const identity = await personWithSource('Contextualized shared source person');
    const original = await seedFirm(fixture, { name: 'Original source owner firm', assignedUserId: fixture.alpha.salesperson.userId });
    const other = await seedFirm(fixture, { name: 'Other evidence context', assignedUserId: fixture.alpha.salesperson.userId });
    const added = await post('/crm/firm-sources/add', command({ firmId: original, sourceKey: randomUUID(), excerpt: 'Private original firm evidence', occurredAt: '2026-09-15T14:00:00.000Z' }));
    const sourceId = (added.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    const source = ((await post('/crm/firm-sources/read', { firmId: original })).body as {
      sources: {
        revision: number;
        contentHash: string;
      }[];
    }).sources[0];
    if (source === undefined)
      throw new Error('Original source missing');
    const evidence = { sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
    const saved = await post('/crm/relationships/save', command({ personId: identity.personId, firmId: other, status: 'current', startDate: null, endDate: null, evidence }));
    const relationshipId = (saved.body as {
      result: {
        relationshipId: string;
      };
    }).result.relationshipId;
    await post('/crm/relationships/context/save', command({ personId: identity.personId, relationshipId, relationshipRevision: 1, evidence }));
    await post('/crm/endpoints/claim', command({ personId: identity.personId, firmId: null, shared: false, kind: 'email', value: 'privatecontext@authority.example.test', status: 'current', startDate: '2026-01-01', endDate: null, evidence }));
    await reassignFirm(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }), fixture.db), { firmId: original, toUserId: fixture.alpha.admin.userId });
    expect((await post('/crm/endpoints/match', { kind: 'email', value: 'privatecontext@authority.example.test' })).body).toMatchObject({ outcome: 'needs_review', candidates: [] });
  });
  it('permits authorized administrator selected-source reads without crossing workspace boundaries', async () => {
    const firmId = await seedFirm(fixture, { name: 'Administrator source access', assignedUserId: fixture.alpha.salesperson.userId });
    await post('/crm/firm-sources/add', command({ firmId, sourceKey: randomUUID(), excerpt: 'Selected owner business excerpt', occurredAt: '2026-09-15T14:00:00.000Z' }));
    const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const otherAdminToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
    expect((await post('/crm/firm-sources/read', { firmId }, adminToken)).body).toMatchObject({ sources: [{ excerpt: 'Selected owner business excerpt' }] });
    expect((await post('/crm/firm-sources/read', { firmId }, otherAdminToken)).status).toBe(404);
  });
  it('deleting a selected source invalidates its associations and removes unsupported endpoint literals', async () => {
    const { personId, evidence } = await personWithSource('Deleted evidence person', 'Private address secret@private.example.test');
    const firmId = await seedFirm(fixture, { name: 'Delete context', assignedUserId: fixture.alpha.salesperson.userId });
    const saved = await post('/crm/relationships/save', command({ personId, firmId, status: 'current', startDate: null, endDate: null, evidence }));
    const relationshipId = (saved.body as {
      result: {
        relationshipId: string;
      };
    }).result.relationshipId;
    await post('/crm/relationships/context/save', command({ personId, relationshipId, relationshipRevision: 1, evidence }));
    await post('/crm/endpoints/claim', command({ personId, firmId: null, shared: false, kind: 'email', value: 'secret@private.example.test', status: 'current', startDate: '2026-01-01', endDate: null, evidence }));
    expect((await post('/crm/people/source/delete', command({ personId, sourceId: evidence.sourceId, expectedRevision: 1 }))).status).toBe(200);
    expect((await post('/crm/relationships/read', { personId })).body).toMatchObject({ relationships: [{ sourceState: 'unavailable', contextReview: 'required' }] });
    expect((await post('/crm/relationships/context/read', { personId })).body).toMatchObject({ contexts: [{ review: 'required' }] });
    const match = await post('/crm/endpoints/match', { kind: 'email', value: 'secret@private.example.test' });
    expect(match.body).toMatchObject({ outcome: 'no_supported_match', candidates: [] });
    expect(JSON.stringify(match.body)).not.toContain('secret@private');
  });
  it('marks a surviving source context for review when its relationship evidence is deleted', async () => {
    const { personId, evidence } = await personWithSource('Independent contextual evidence');
    const firmId = await seedFirm(fixture, { name: 'Context provenance firm', assignedUserId: fixture.alpha.salesperson.userId });
    const saved = await post('/crm/relationships/save', command({ personId, firmId, status: 'current', startDate: null, endDate: null, evidence }));
    const relationshipId = (saved.body as {
      result: {
        relationshipId: string;
      };
    }).result.relationshipId;
    const added = await post('/crm/people/source/add', command({ personId, sourceKey: randomUUID(), excerpt: 'Separate selected conversation', occurredAt: '2026-09-16T14:00:00.000Z' }));
    const separateId = (added.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    const page = await post('/crm/people/read', { personId });
    const separate = (page.body as {
      sources: {
        sourceId: string;
        revision: number;
        contentHash: string;
      }[];
    }).sources.find(source => source.sourceId === separateId);
    if (separate === undefined)
      throw new Error('Separate source missing');
    await post('/crm/relationships/context/save', command({ personId, relationshipId, relationshipRevision: 1, evidence: { sourceId: separateId, sourceRevision: separate.revision, contentHash: separate.contentHash } }));
    expect((await post('/crm/people/source/delete', command({ personId, sourceId: evidence.sourceId, expectedRevision: 1 }))).status).toBe(200);
    expect((await post('/crm/relationships/context/read', { personId })).body).toMatchObject({ contexts: [{ sourceId: separateId, review: 'required' }] });
    expect((await post('/crm/relationships/context/save', command({ personId, relationshipId, relationshipRevision: 1, evidence: { sourceId: separateId, sourceRevision: separate.revision, contentHash: separate.contentHash } }))).status).toBe(409);
    expect((await post('/crm/people/read', { personId })).body).toMatchObject({ sources: expect.arrayContaining([expect.objectContaining({ sourceId: separateId, availability: 'available', excerpt: 'Separate selected conversation' })]) });
  });
  it('lists private endpoint assertions and corrects identity explicitly without merging people', async () => {
    const first = await personWithSource('First identity');
    const second = await personWithSource('Second identity');
    const claim = await post('/crm/endpoints/claim', command({ ...first, firmId: null, shared: false, kind: 'phone', value: '+14155550123', status: 'current', startDate: '2026-01-01', endDate: null }));
    const ids = (claim.body as {
      result: {
        endpointId: string;
        claimId: string;
      };
    }).result;
    expect((await post('/crm/endpoints/list', { personId: first.personId })).body).toMatchObject({ claims: [{ claimId: ids.claimId, personId: first.personId, personName: 'First identity' }] });
    const corrected = await post('/crm/endpoints/correct', command({ ...second, firmId: null, shared: false, kind: 'phone', value: '+14155550123', status: 'current', startDate: '2026-01-01', endDate: null, claimId: ids.claimId, expectedRevision: 1 }));
    expect(corrected.status).toBe(200);
    expect(corrected.body).toMatchObject({ result: { endpointId: ids.endpointId, claimId: ids.claimId, revision: 2 } });
    expect((await post('/crm/endpoints/match', { kind: 'phone', value: '+14155550123' })).body).toMatchObject({ outcome: 'person_match', personId: second.personId });
    expect((await post('/crm/people/read', { personId: first.personId })).body).toMatchObject({ person: { fullName: 'First identity' } });
    expect((await post('/crm/endpoints/correct', command({ ...first, firmId: null, shared: false, kind: 'phone', value: '+14155550123', status: 'current', startDate: null, endDate: null, claimId: ids.claimId, expectedRevision: 1 }))).status).toBe(409);
  });
  it('refuses endpoint correction when membership is revoked during an endpoint lock wait', async () => {
    const identity = await personWithSource('Endpoint authorization race');
    const claimed = await post('/crm/endpoints/claim', command({ ...identity, kind: 'email', value: 'before@authority.example.test', firmId: null, shared: false, status: 'current', startDate: '2026-01-01', endDate: null }));
    const { endpointId, claimId } = (claimed.body as {
      result: {
        endpointId: string;
        claimId: string;
      };
    }).result;
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM crm_identity_endpoints WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [fixture.alpha.workspaceId, endpointId]);
    const pending = post('/crm/endpoints/correct', command({ ...identity, kind: 'email', value: 'after@authority.example.test', firmId: null, shared: false, status: 'current', startDate: '2026-01-01', endDate: null, claimId, expectedRevision: 1 }));
    try {
      await waitForBlock(observer, pid);
      await observer.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2", [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId]);
    }
    finally {
      await holder.query('COMMIT');
    }
    const refused = await pending;
    await observer.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2", [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId]);
    expect(refused.status).toBe(409);
    expect((await post('/crm/endpoints/list', { personId: identity.personId })).body).toMatchObject({ claims: [{ claimId, revision: 1, value: 'before@authority.example.test' }] });
    expect((await post('/crm/endpoints/match', { kind: 'email', value: 'after@authority.example.test' })).body).toMatchObject({ outcome: 'no_supported_match', candidates: [] });
  });
  it('lets the owner restore explicitly contextualized B evidence after legacy A authority is lost', async () => {
    const oldFirmId = await seedFirm(fixture, { name: 'Legacy default A', assignedUserId: fixture.alpha.salesperson.userId });
    const firmId = await seedFirm(fixture, { name: 'Surviving explicit B', assignedUserId: fixture.alpha.salesperson.userId });
    const personId = await seedContact(fixture, { firmId, fullName: 'B context owner person' });
    await post('/crm/people/bridge', command({ contactIds: [personId] }));
    await post('/crm/people/source/add', command({ personId, sourceKey: randomUUID(), excerpt: 'Explicit B selected content', occurredAt: '2026-09-15T14:00:00.000Z' }));
    const source = ((await post('/crm/people/read', { personId })).body as {
      sources: {
        sourceId: string;
        revision: number;
        contentHash: string;
      }[];
    }).sources[0];
    if (source === undefined)
      throw new Error('B selected source missing');
    const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
    const saved = await post('/crm/relationships/save', command({ personId, firmId, status: 'current', startDate: null, endDate: null, evidence }));
    const relationshipId = (saved.body as {
      result: {
        relationshipId: string;
      };
    }).result.relationshipId;
    await post('/crm/relationships/context/save', command({ personId, relationshipId, relationshipRevision: 1, evidence }));
    await post('/crm/endpoints/claim', command({ personId, firmId: null, shared: false, kind: 'email', value: 'restored@bcontext.example.test', status: 'current', startDate: '2026-01-01', endDate: null, evidence }));
    // Copy captured under B; the current legacy pointer later moves to A.
    // A-captured refusal remains covered by crmEvidenceOriginalAcl.
    await fixture.db.query('UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2', [fixture.alpha.workspaceId, personId, oldFirmId]);
    await reassignFirm(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }), fixture.db), { firmId: oldFirmId, toUserId: fixture.alpha.admin.userId });
    expect((await post('/crm/people/read', { personId })).body).toMatchObject({ person: { firm: null }, sources: [{ excerpt: 'Explicit B selected content' }] });
    expect((await post('/crm/people/source/add', command({ personId, sourceKey: randomUUID(), excerpt: 'Unauthorized default A new capture', occurredAt: '2026-09-16T14:00:00.000Z' }))).status).toBe(409);
    expect((await post('/crm/people/source/delete', command({ personId, sourceId: source.sourceId, expectedRevision: 1 }))).status).toBe(200);
    expect((await post('/crm/people/source/restore', command({ personId, sourceId: source.sourceId, expectedRevision: 2 }))).status).toBe(200);
    expect((await post('/crm/people/source/recapture', command({ personId, sourceId: source.sourceId, expectedRevision: 3, excerpt: 'Explicitly recaptured B content', occurredAt: '2026-09-17T14:00:00.000Z' }))).status).toBe(200);
    expect((await post('/crm/people/read', { personId })).body).toMatchObject({ person: { firm: null }, sources: [{ revision: 4, excerpt: 'Explicitly recaptured B content' }] });
    const contexts = (await post('/crm/relationships/context/read', { personId })).body as {
      contexts: unknown[];
    };
    expect(contexts.contexts).toHaveLength(2);
    expect(contexts.contexts).toEqual(expect.arrayContaining([expect.objectContaining({ firmId, relationshipRevision: 1, review: 'required' })]));
    expect((await post('/crm/endpoints/match', { kind: 'email', value: 'restored@bcontext.example.test' })).body).toMatchObject({ outcome: 'no_supported_match', candidates: [] });
    expect((await post('/crm/relationships/read', { personId })).body).toMatchObject({ relationships: [{ sourceState: 'unavailable', contextReview: 'required' }] });
  });
  it('serializes two concurrent endpoint corrections that swap existing endpoints', async () => {
    const first = await personWithSource('First endpoint swap identity');
    const second = await personWithSource('Second endpoint swap identity');
    const fields = { firmId: null, shared: false, kind: 'email' as const, status: 'current' as const, startDate: '2026-01-01', endDate: null };
    const firstClaim = (await post('/crm/endpoints/claim', command({ ...first, ...fields, value: 'swap-first@identity.example.test' }))).body as {
      result: {
        claimId: string;
      };
    };
    const secondClaim = (await post('/crm/endpoints/claim', command({ ...second, ...fields, value: 'swap-second@identity.example.test' }))).body as {
      result: {
        claimId: string;
      };
    };
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await correctEndpoint(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }), holder), { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...first, ...fields, value: 'swap-second@identity.example.test', claimId: firstClaim.result.claimId, expectedRevision: 1 });
    const pending = post('/crm/endpoints/correct', command({ ...second, ...fields, value: 'swap-first@identity.example.test', claimId: secondClaim.result.claimId, expectedRevision: 1 }));
    try {
      await waitForBlock(observer, pid);
    }
    finally {
      await holder.query('COMMIT');
    }
    expect((await pending).status).toBe(200);
    expect((await post('/crm/endpoints/match', { kind: 'email', value: 'swap-second@identity.example.test' })).body).toMatchObject({ outcome: 'person_match', personId: first.personId });
    expect((await post('/crm/endpoints/match', { kind: 'email', value: 'swap-first@identity.example.test' })).body).toMatchObject({ outcome: 'person_match', personId: second.personId });
  });
  it('refuses oversized recapture context cloning before retaining a new person or firm body', async () => {
    const identity = await personWithSource('Bounded recapture identity');
    const firmId = await seedFirm(fixture, { name: 'Bounded recapture firm', assignedUserId: fixture.alpha.salesperson.userId });
    const added = await post('/crm/firm-sources/add', command({ firmId, sourceKey: randomUUID(), excerpt: 'Bounded shared evidence', occurredAt: '2026-09-15T14:00:00.000Z' }));
    const sourceId = (added.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    const source = ((await post('/crm/firm-sources/read', { firmId })).body as {
      sources: {
        revision: number;
        contentHash: string;
      }[];
    }).sources[0];
    if (source === undefined)
      throw new Error('Firm bound source missing');
    const firmEvidence = { sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
    for (let index = 0; index < 101; index++) {
      const saved = await post('/crm/relationships/save', command({ ...identity, firmId, status: 'current', startDate: null, endDate: null }));
      const relationshipId = (saved.body as {
        result: {
          relationshipId: string;
        };
      }).result.relationshipId;
      for (const evidence of [identity.evidence, firmEvidence])
        expect((await post('/crm/relationships/context/save', command({ personId: identity.personId, relationshipId, relationshipRevision: 1, evidence }))).status).toBe(200);
    }
    for (const [prefix, subject, copyId] of [['/crm/people/source', { personId: identity.personId }, identity.evidence.sourceId], ['/crm/firm-sources', { firmId }, sourceId]] as const) {
      expect((await post(`${prefix}/delete`, command({ ...subject, sourceId: copyId, expectedRevision: 1 }))).status).toBe(200);
      expect((await post(`${prefix}/restore`, command({ ...subject, sourceId: copyId, expectedRevision: 2 }))).status).toBe(200);
      const refused = await post(`${prefix}/recapture`, command({ ...subject, sourceId: copyId, expectedRevision: 3, excerpt: 'Must not retain oversized recapture', occurredAt: '2026-09-17T14:00:00.000Z' }));
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ reason: 'source_context_limit' });
    }
    expect((await post('/crm/people/read', { personId: identity.personId })).body).toMatchObject({ sources: [{ availability: 'awaiting_recapture', revision: 3, excerpt: null }] });
    expect((await post('/crm/firm-sources/read', { firmId })).body).toMatchObject({ sources: [{ availability: 'awaiting_recapture', revision: 3, excerpt: null }] });
  });
  it('deletes shared firm evidence and restores only through explicit recapture', async () => {
    const firmId = await seedFirm(fixture, { name: 'Restorable shared firm', assignedUserId: fixture.alpha.salesperson.userId });
    const added = await post('/crm/firm-sources/add', command({ firmId, sourceKey: 'restore shared', excerpt: 'Shared line +14155550124', occurredAt: '2026-09-15T14:00:00.000Z' }));
    const sourceId = (added.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    expect((await post('/crm/firm-sources/delete', command({ firmId, sourceId, expectedRevision: 1 }))).status).toBe(200);
    expect((await post('/crm/firm-sources/read', { firmId })).body).toMatchObject({ sources: [{ availability: 'deleted', excerpt: null }] });
    expect((await post('/crm/firm-sources/restore', command({ firmId, sourceId, expectedRevision: 2 }))).status).toBe(200);
    expect((await post('/crm/firm-sources/read', { firmId })).body).toMatchObject({ sources: [{ availability: 'awaiting_recapture', excerpt: null }] });
    expect((await post('/crm/firm-sources/recapture', command({ firmId, sourceId, expectedRevision: 3, excerpt: 'Fresh shared selection', occurredAt: '2026-09-16T14:00:00.000Z' }))).status).toBe(200);
    expect((await post('/crm/firm-sources/read', { firmId })).body).toMatchObject({ sources: [{ revision: 4, excerpt: 'Fresh shared selection' }] });
  });
});
/** Database barriers coordinate real product operations; assertions remain on public reads. */
async function waitForBlock(observer: SessionQueryable, pid: number | undefined) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await observer.query<{
      blocked: boolean;
    }>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid]);
    if (rows[0]?.blocked === true)
      return;
    await delay(5);
  }
  throw new Error('Concurrent product request did not reach the database barrier');
}
