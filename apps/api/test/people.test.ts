import { setTimeout as delay } from 'node:timers/promises';
import { changeSelectedSource } from '@fss/domain/crm/people.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { reassignFirm } from '@fss/domain/crm/firms.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
describe('independent CRM people and selected evidence', () => {
  let fixture: AuthFixture;
  let token: string;
  const post = async (path: string, body: unknown, bearer = token) => dispatch({ method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${bearer}` }, body }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
  const command = (fields: Record<string, unknown>) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
  beforeAll(async () => { fixture = await createAuthFixture(); token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken; });
  afterAll(async () => { await fixture.stop(); });
  it('creates a person with an unknown firm and reads selected dated evidence', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Morgan Lee' }));
    expect(created.status).toBe(200);
    const response = created.body as {
      result: {
        personId: string;
      };
    };
    const captured = await post('/crm/people/source/add', command({ personId: response.result.personId, sourceKey: 'selected-note-1', excerpt: 'We coordinate repairs manually.', occurredAt: '2026-09-15T14:00:00.000Z' }));
    expect(captured.status).toBe(200);
    const page = await post('/crm/people/read', { personId: response.result.personId });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ person: { fullName: 'Morgan Lee', firm: null }, sources: [{ excerpt: 'We coordinate repairs manually.', occurredAt: '2026-09-15T14:00:00.000Z', kind: 'selected_note', completeness: 'selected_excerpt' }] });
  });
  it('deduplicates source replay, deletes copied evidence and requires explicit restore and recapture', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Pat Chen' }));
    const personId = (created.body as {
      result: {
        personId: string;
      };
    }).result.personId;
    const input = command({ personId, sourceKey: 'private source title', excerpt: 'Sensitive commitment quotation', occurredAt: '2026-09-20T14:00:00.000Z' });
    const captured = await post('/crm/people/source/add', input);
    const sourceId = (captured.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    expect((await post('/crm/people/source/add', command({ ...input, commandId: randomUUID() }))).status).toBe(200);
    const duplicateRead = await post('/crm/people/read', { personId });
    expect(duplicateRead.body).toMatchObject({ sources: [{ sourceId }] });
    expect((duplicateRead.body as {
      sources: unknown[];
    }).sources).toHaveLength(1);
    expect((await post('/crm/people/source/delete', command({ personId, sourceId, expectedRevision: 1 }))).status).toBe(200);
    const deleted = await post('/crm/people/read', { personId });
    expect(deleted.body).toMatchObject({ sources: [{ sourceId, availability: 'deleted', excerpt: null, contentHash: null, occurredAt: null }] });
    expect(JSON.stringify(deleted.body)).not.toContain('Sensitive commitment');
    expect(JSON.stringify(await post('/crm/people/source/add', input))).not.toContain('Sensitive commitment');
    expect((await post('/crm/people/source/add', command({ ...input, commandId: randomUUID() }))).status).toBe(409);
    expect((await post('/crm/people/source/restore', command({ personId, sourceId, expectedRevision: 2 }))).status).toBe(200);
    expect((await post('/crm/people/read', { personId })).body).toMatchObject({ sources: [{ availability: 'awaiting_recapture', excerpt: null }] });
    expect((await post('/crm/people/source/add', command({ ...input, commandId: randomUUID(), excerpt: 'Explicitly selected again' }))).status).toBe(200);
    expect((await post('/crm/people/read', { personId })).body).toMatchObject({ sources: [{ sourceId, revision: 4, excerpt: 'Explicitly selected again' }] });
  });
  it('bridges legacy contacts idempotently without name merging and follows current assignment', async () => {
    const firmId = await seedFirm(fixture, { name: 'Legacy group', assignedUserId: fixture.alpha.salesperson.userId });
    const contactId = await seedContact(fixture, { firmId, fullName: 'Same Name' });
    const otherId = await seedContact(fixture, { firmId, fullName: 'Same Name' });
    const bridged = await post('/crm/people/bridge', command({ contactIds: [contactId, otherId] }));
    expect(bridged.status).toBe(200);
    expect((bridged.body as {
      result: {
        people: unknown[];
      };
    }).result.people).toEqual(expect.arrayContaining([{ personId: contactId, contactId }, { personId: otherId, contactId: otherId }]));
    expect((await post('/crm/people/bridge', command({ contactIds: [contactId] }))).body).toMatchObject({ result: { people: [{ personId: contactId }] } });
    expect((await post('/crm/people/read', { personId: contactId })).body).toMatchObject({ person: { firm: { firmId, name: 'Legacy group' } } });
    const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const added = await post('/crm/people/source/add', command({ personId: contactId, sourceKey: 'admin-private', excerpt: 'Admin-only evidence', occurredAt: '2026-09-20T14:00:00.000Z' }), adminToken);
    expect(added.status).toBe(200);
    expect((await post('/crm/people/read', { personId: contactId })).body).toMatchObject({ sources: [] });
    expect((await withTransaction(fixture.db, async () => reassignFirm(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }), fixture.db), { firmId, toUserId: fixture.alpha.admin.userId }))).ok).toBe(true);
    expect((await post('/crm/people/read', { personId: contactId })).status).toBe(404);
    expect((await post('/crm/people/source/add', command({ personId: contactId, sourceKey: 'late', excerpt: 'Cannot publish', occurredAt: '2026-09-20T14:00:00.000Z' }))).status).toBe(409);
  });
  it('keeps unknown-firm people and their notes workspace and owner private', async () => {
    const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const betaToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
    const created = await post('/crm/people/create', command({ fullName: 'Private person' }), adminToken);
    const personId = (created.body as {
      result: {
        personId: string;
      };
    }).result.personId;
    expect((await post('/crm/people/read', { personId })).status).toBe(404);
    expect((await post('/crm/people/read', { personId }, betaToken)).status).toBe(404);
    expect((await post('/crm/people/read', { personId }, adminToken)).status).toBe(200);
    expect((await post('/crm/people/neighbour', { personId }, adminToken)).status).toBe(404);
  });
  it('paginates visible people and their source excerpts without claiming complete coverage', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Pagination person' }));
    const personId = (created.body as {
      result: {
        personId: string;
      };
    }).result.personId;
    for (const sourceKey of ['page1', 'page2'])
      await post('/crm/people/source/add', command({ personId, sourceKey, excerpt: sourceKey, occurredAt: '2026-09-20T14:00:00.000Z' }));
    const first = await post('/crm/people/read', { personId, limit: 1 });
    expect(first.status).toBe(200);
    const page = first.body as {
      sources: {
        sourceId: string;
      }[];
      nextAfterSourceId: string | null;
    };
    expect(page.sources).toHaveLength(1);
    expect(page.nextAfterSourceId).toBe(page.sources[0]?.sourceId);
    const second = await post('/crm/people/read', { personId, limit: 1, afterSourceId: page.nextAfterSourceId });
    expect(second.body).toMatchObject({ nextAfterSourceId: null });
    expect((second.body as typeof page).sources[0]?.sourceId).not.toBe(page.sources[0]?.sourceId);
    const list = await post('/crm/people/list', { limit: 1 });
    expect(list.status).toBe(200);
    expect((list.body as {
      people: unknown[];
    }).people).toHaveLength(1);
    expect((list.body as {
      nextAfterId: string | null;
    }).nextAfterId).not.toBeNull();
  });
  it('vetoes source capture after a concurrent reassignment commits', async () => {
    const firmId = await seedFirm(fixture, { name: 'Reassignment race', assignedUserId: fixture.alpha.salesperson.userId });
    const contactId = await seedContact(fixture, { firmId, fullName: 'Former assignee person' });
    await post('/crm/people/bridge', command({ contactIds: [contactId] }));
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await reassignFirm(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }), holder), { firmId, toUserId: fixture.alpha.admin.userId });
    const pending = post('/crm/people/source/add', command({ personId: contactId, sourceKey: 'raced', excerpt: 'Must not be retained', occurredAt: '2026-09-20T14:00:00.000Z' }));
    try {
      await waitForBlock(observer, pid);
    }
    finally {
      await holder.query('COMMIT');
    }
    expect((await pending).status).toBe(409);
    const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    expect((await post('/crm/people/read', { personId: contactId }, adminToken)).body).toMatchObject({ sources: [] });
  });
  it('returns no copied quotation after a concurrent deletion wins the source read', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Delete race' }));
    const personId = (created.body as {
      result: {
        personId: string;
      };
    }).result.personId;
    const added = await post('/crm/people/source/add', command({ personId, sourceKey: 'delete-race', excerpt: 'Secret before deletion', occurredAt: '2026-09-20T14:00:00.000Z' }));
    const sourceId = (added.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await changeSelectedSource(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }), holder), { personId, sourceId, expectedRevision: 1 }, 'delete');
    const pending = post('/crm/people/read', { personId });
    try {
      await waitForBlock(observer, pid);
    }
    finally {
      await holder.query('COMMIT');
    }
    const read = await pending;
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ sources: [{ availability: 'deleted', excerpt: null }] });
    expect(JSON.stringify(read.body)).not.toContain('Secret before deletion');
  });
  it('explicitly recaptures a restored source by identity without retaining its original key', async () => {
    const person = await post('/crm/people/create', command({ fullName: 'Restorable source' }));
    const personId = (person.body as {
      result: {
        personId: string;
      };
    }).result.personId;
    const source = await post('/crm/people/source/add', command({ personId, sourceKey: 'not retained in view', excerpt: 'Old quotation', occurredAt: '2026-09-20T14:00:00.000Z' }));
    const sourceId = (source.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    await post('/crm/people/source/delete', command({ personId, sourceId, expectedRevision: 1 }));
    const recapture = command({ personId, sourceId, expectedRevision: 3, excerpt: 'New explicit selection', occurredAt: '2026-09-21T14:00:00.000Z' });
    expect((await post('/crm/people/source/recapture', recapture)).status).toBe(409);
    await post('/crm/people/source/restore', command({ personId, sourceId, expectedRevision: 2 }));
    expect((await post('/crm/people/source/recapture', { ...recapture, commandId: randomUUID() })).status).toBe(200);
    expect((await post('/crm/people/read', { personId })).body).toMatchObject({ sources: [{ sourceId, revision: 4, excerpt: 'New explicit selection' }] });
  });
  it('vetoes a sensitive read when membership is revoked while it waits', async () => {
    const memberToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.salesperson)).accessToken;
    const created = await post('/crm/people/create', command({ fullName: 'Revocation race' }), memberToken);
    const personId = (created.body as {
      result: {
        personId: string;
      };
    }).result.personId;
    const added = await post('/crm/people/source/add', command({ personId, sourceKey: 'revocation', excerpt: 'No revoked access', occurredAt: '2026-09-20T14:00:00.000Z' }), memberToken);
    const sourceId = (added.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await changeSelectedSource(repositoryContext(workspaceScope(fixture.beta.workspaceId, { kind: 'user', userId: fixture.beta.salesperson.userId, role: 'salesperson' }), holder), { personId, sourceId, expectedRevision: 1 }, 'delete');
    const pending = post('/crm/people/read', { personId }, memberToken);
    try {
      await waitForBlock(observer, pid);
      // Fixture simulates an independently committed administrative revocation.
      await observer.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2", [fixture.beta.workspaceId, fixture.beta.salesperson.userId]);
    }
    finally {
      await holder.query('COMMIT');
    }
    expect((await pending).status).toBe(404);
  });
  it('refuses capture when membership is revoked during its lock wait', async () => {
    const created = await post('/crm/people/create', command({ fullName: 'Revoked capture race' }));
    const personId = (created.body as {
      result: {
        personId: string;
      };
    }).result.personId;
    const first = await post('/crm/people/source/add', command({ personId, sourceKey: 'old', excerpt: 'Existing source', occurredAt: '2026-09-20T14:00:00.000Z' }));
    const sourceId = (first.body as {
      result: {
        sourceId: string;
      };
    }).result.sourceId;
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{
      pid: number;
    }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await changeSelectedSource(repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }), holder), { personId, sourceId, expectedRevision: 1 }, 'delete');
    const pending = post('/crm/people/source/add', command({ personId, sourceKey: 'revoked new source', excerpt: 'Cannot retain', occurredAt: '2026-09-20T14:00:00.000Z' }));
    try {
      await waitForBlock(observer, pid);
      await observer.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2", [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId]);
    }
    finally {
      await holder.query('COMMIT');
    }
    expect((await pending).status).toBe(409);
    const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const page = await post('/crm/people/read', { personId }, adminToken);
    expect((page.body as {
      sources: unknown[];
    }).sources).toHaveLength(1);
  });
});
/** Database barriers coordinate races; all outcome assertions use public reads/commands. */
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
