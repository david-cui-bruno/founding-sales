import { afterAll, beforeAll, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { withTransaction } from '../../db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { createPerson, addSelectedSource, changeSelectedSource, readPerson, bridgeLegacyContacts } from '../../crm/people.ts';
import { saveRelationship, correctRelationship, readRelationships, saveSourceContext, readSourceContexts } from '../../crm/relationships.ts';
import { addFirmSource, readFirmSources } from '../../crm/firmSources.ts';
import { previewDeletion, commitDeletion, REDACTED_NAME } from '../../retention/deletion.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';

let database: TestDatabase;
let members: TwoWorkspaces;
let crm: SeededCrm;
beforeAll(async () => {
  database = await createTestDatabase();
  members = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, members);
});

it('contact deletion makes its derived relationship evidence and original source context require review', async () => {
  const context = repositoryContext(workspaceScope(members.beta.workspaceId, {
    kind: 'user', userId: members.beta.admin.userId, role: 'admin',
  }), database.session);
  const personId = crm.beta.contactId;
  expect((await bridgeLegacyContacts(context, [personId])).ok).toBe(true);
  await addSelectedSource(context, {
    personId, sourceKey: 'relationship-deletion', excerpt: 'Selected business relationship evidence',
    occurredAt: '2026-10-01T14:00:00.000Z',
  });
  const source = (await readPerson(context, personId))?.sources[0];
  if (source === undefined || source.contentHash === null) throw new Error('source fixture failed');
  const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
  const relationship = await saveRelationship(context, {
    commandId: '11111111-1111-4111-8111-111111111111', clientVersion: '1.0.13',
    personId, firmId: crm.beta.firmId, status: 'current', startDate: null, endDate: null, evidence,
  });
  if (!relationship.ok || relationship.value.relationshipId === undefined) throw new Error('relationship fixture failed');
  expect((await saveSourceContext(context, {
    personId, relationshipId: relationship.value.relationshipId, relationshipRevision: 1, evidence,
  })).ok).toBe(true);
  const preview = await previewDeletion(context, {
    targetKind: 'contact', firmId: crm.beta.firmId, contactId: personId,
  });
  if (!preview.ok || preview.value === undefined) throw new Error('deletion preview failed');
  expect((await commitDeletion(context, {
    requestId: preview.value.requestId, previewHash: preview.value.previewHash,
    commandId: 'delete-derived-relationship', journal: recordingSuppressionJournal(),
  })).ok).toBe(true);
  expect((await readRelationships(context, { personId, limit: 50 }))?.relationships).toEqual([
    expect.objectContaining({ sourceState: 'unavailable', contextReview: 'required', firmId: crm.beta.firmId }),
  ]);
  expect((await readSourceContexts(context, { personId, limit: 50 }))?.contexts).toEqual([
    expect.objectContaining({ review: 'required', relationshipRevision: 1, firmId: crm.beta.firmId }),
  ]);
});
afterAll(async () => { await database.drop(); });

it('deleting an operational contact also removes its bridged copied source without deleting unrelated person history', async () => {
  const context = repositoryContext(workspaceScope(members.alpha.workspaceId, {
    kind: 'user', userId: members.alpha.admin.userId, role: 'admin',
  }), database.session);
  // A legacy bridge fixture; the observable assertions use public CRM/deletion reads.
  await database.session.query(
    'INSERT INTO crm_people(workspace_id,id,owner_user_id,full_name) VALUES($1,$2,$3,$4)',
    [members.alpha.workspaceId, crm.alpha.contactId, members.alpha.admin.userId, 'Legacy Correspondent'],
  );
  await database.session.query(
    'INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,$2)',
    [members.alpha.workspaceId, crm.alpha.contactId],
  );
  const unrelated = await createPerson(context, 'Unrelated Correspondent');
  if (!unrelated.ok || unrelated.value.personId === undefined) throw new Error('person fixture failed');
  await addSelectedSource(context, {
    personId: crm.alpha.contactId, sourceKey: 'legacy-source', excerpt: 'Private legacy conversation',
    occurredAt: '2026-10-01T14:00:00.000Z',
  });
  await addSelectedSource(context, {
    personId: unrelated.value.personId, sourceKey: 'other-source', excerpt: 'Unrelated history remains',
    occurredAt: '2026-10-02T14:00:00.000Z',
  });
  const preview = await previewDeletion(context, {
    targetKind: 'contact', firmId: crm.alpha.firmId, contactId: crm.alpha.contactId,
  });
  if (!preview.ok || preview.value === undefined) throw new Error('deletion preview failed');
  const deleted = await commitDeletion(context, {
    requestId: preview.value.requestId, previewHash: preview.value.previewHash,
    commandId: 'delete-legacy-person-copy', journal: recordingSuppressionJournal(),
  });
  expect(deleted.ok).toBe(true);
  const legacy = await readPerson(context, crm.alpha.contactId);
  expect(legacy?.person.fullName).toBe(REDACTED_NAME);
  expect(legacy?.sources).toEqual([expect.objectContaining({ availability: 'deleted', excerpt: null, contentHash: null })]);
  expect((await readPerson(context, unrelated.value.personId))?.sources[0]?.excerpt).toBe('Unrelated history remains');
});

it('preserves independent identity and another firm history while deleting an indivisible mixed-firm copy', async () => {
  const isolated = await createTestDatabase();
  try {
    const workspaces = await seedTwoWorkspaces(isolated.session);
    const records = await seedCrm(isolated.session, workspaces);
    const workspaceId = workspaces.alpha.workspaceId;
    const context = repositoryContext(workspaceScope(workspaceId, {
      kind: 'user', userId: workspaces.alpha.admin.userId, role: 'admin',
    }), isolated.session);
    const personId = records.alpha.contactId;
    const firmA = records.alpha.firmId;
    const firmB = (await isolated.session.query<{ id: string }>(
      'INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',
      [workspaceId, 'Separate firm history', workspaces.alpha.salesperson.userId],
    )).rows[0]?.id;
    if (firmB === undefined) throw new Error('firm fixture failed');
    expect((await bridgeLegacyContacts(context, [personId])).ok).toBe(true);
    const capture = async (sourceKey: string, excerpt: string) => {
      const added = await addSelectedSource(context, { personId, sourceKey, excerpt, occurredAt: '2026-10-01T14:00:00.000Z' });
      if (!added.ok) throw new Error('capture fixture failed');
      const source = (await readPerson(context, personId))?.sources.find(candidate => candidate.sourceId === added.value.sourceId);
      if (source === undefined || source.contentHash === null) throw new Error('source fixture failed');
      return { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
    };
    const defaultA = await capture('default-a', 'Legacy firm conversation');
    const mixed = await capture('mixed-ab', 'Indivisible conversation about both firms');
    // Capture the genuinely B-only copy while B is the actual legacy authority.
    await isolated.session.query('UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2', [workspaceId, personId, firmB]);
    const onlyB = await capture('only-b', 'Separate firm conversation survives');
    await isolated.session.query('UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2', [workspaceId, personId, firmA]);
    const assertion = async (firmId: string, evidence: typeof onlyB) => {
      const result = await saveRelationship(context, {
        commandId: '11111111-1111-4111-8111-111111111111', clientVersion: '1.0.13',
        personId, firmId, status: 'current', startDate: null, endDate: null, evidence,
      });
      if (!result.ok || result.value.relationshipId === undefined) throw new Error('relationship fixture failed');
      return result.value.relationshipId;
    };
    const relationshipA = await assertion(firmA, mixed);
    const relationshipB = await assertion(firmB, onlyB);
    for (const [relationshipId, evidence] of [[relationshipB, onlyB], [relationshipA, mixed], [relationshipB, mixed]] as const) {
      expect((await saveSourceContext(context, { personId, relationshipId, relationshipRevision: 1, evidence })).ok).toBe(true);
    }
    let preview = await previewDeletion(context, { targetKind: 'contact', firmId: firmA, contactId: personId });
    if (!preview.ok || preview.value === undefined) throw new Error('deletion preview failed');
    await assertion(firmA, defaultA);
    expect(await commitDeletion(context, {
      requestId: preview.value.requestId, previewHash: preview.value.previewHash,
      commandId: 'stale-derived-evidence-preview', journal: recordingSuppressionJournal(),
    })).toMatchObject({ ok: false, reason: 'preview_stale' });
    preview = await previewDeletion(context, { targetKind: 'contact', firmId: firmA, contactId: personId });
    if (!preview.ok || preview.value === undefined) throw new Error('refreshed deletion preview failed');
    expect((await commitDeletion(context, {
      requestId: preview.value.requestId, previewHash: preview.value.previewHash,
      commandId: 'delete-one-firm-context', journal: recordingSuppressionJournal(),
    })).ok).toBe(true);
    const page = await readPerson(context, personId);
    expect(page?.person.fullName).toBe('Dana Example');
    expect(page?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: onlyB.sourceId, availability: 'available', excerpt: 'Separate firm conversation survives' }),
      expect.objectContaining({ sourceId: defaultA.sourceId, availability: 'deleted', excerpt: null }),
      expect.objectContaining({ sourceId: mixed.sourceId, availability: 'deleted', excerpt: null }),
    ]));
    expect((await readSourceContexts(context, { personId, limit: 50 }))?.contexts).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: onlyB.sourceId, firmId: firmB, review: 'current' }),
      expect.objectContaining({ sourceId: mixed.sourceId, firmId: firmB, review: 'required' }),
      expect.objectContaining({ sourceId: mixed.sourceId, firmId: firmA, review: 'required' }),
    ]));
    expect((await changeSelectedSource(context, { personId, sourceId: onlyB.sourceId, expectedRevision: 1 }, 'delete')).ok).toBe(true);
    expect((await changeSelectedSource(context, { personId, sourceId: onlyB.sourceId, expectedRevision: 2 }, 'restore')).ok).toBe(true);
    const repeated = await previewDeletion(context, { targetKind: 'contact', firmId: firmA, contactId: personId });
    if (!repeated.ok) throw new Error('repeat preview fixture failed');
    expect(repeated.value.redacts['crm_selected_sources']).toBe(0);
    expect((await commitDeletion(context, { requestId: repeated.value.requestId, previewHash: repeated.value.previewHash,
      commandId: 'preserve-other-firm-restoration-identity', journal: recordingSuppressionJournal() })).ok).toBe(true);
    expect((await readPerson(context, personId))?.sources.find(candidate => candidate.sourceId === onlyB.sourceId)).toMatchObject({
      availability: 'awaiting_recapture', revision: 3, excerpt: null,
    });
  } finally {
    await isolated.drop();
  }
});

it('firm deletion removes explicitly scoped evidence from a person with no legacy contact', async () => {
  const context = repositoryContext(workspaceScope(members.alpha.workspaceId, {
    kind: 'user', userId: members.alpha.admin.userId, role: 'admin',
  }), database.session);
  const created = await createPerson(context, 'Independent firm correspondent');
  if (!created.ok || created.value.personId === undefined) throw new Error('person fixture failed');
  const personId = created.value.personId;
  await addSelectedSource(context, { personId, sourceKey: 'independent-firm-source', excerpt: 'Private conversation at the deleted firm', occurredAt: '2026-10-01T14:00:00.000Z' });
  const source = (await readPerson(context, personId))?.sources[0];
  if (source === undefined || source.contentHash === null) throw new Error('source fixture failed');
  const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
  const saved = await saveRelationship(context, {
    commandId: '11111111-1111-4111-8111-111111111111', clientVersion: '1.0.13',
    personId, firmId: crm.alpha.firmId, status: 'current', startDate: null, endDate: null, evidence,
  });
  if (!saved.ok || saved.value.relationshipId === undefined) throw new Error('relationship fixture failed');
  expect((await saveSourceContext(context, { personId, relationshipId: saved.value.relationshipId, relationshipRevision: 1, evidence })).ok).toBe(true);
  const preview = await previewDeletion(context, { targetKind: 'firm', firmId: crm.alpha.firmId });
  if (!preview.ok || preview.value === undefined) throw new Error('deletion preview failed');
  expect((await commitDeletion(context, { requestId: preview.value.requestId, previewHash: preview.value.previewHash, commandId: 'delete-independent-firm-context', journal: recordingSuppressionJournal() })).ok).toBe(true);
  expect((await readPerson(context, personId))?.sources).toEqual([
    expect.objectContaining({ sourceId: source.sourceId, availability: 'deleted', excerpt: null }),
  ]);
});

it('preserves an independent person whose unrelated relationship has surviving firm-owned evidence', async () => {
  const isolated = await createTestDatabase();
  try {
    const workspaces = await seedTwoWorkspaces(isolated.session);
    const records = await seedCrm(isolated.session, workspaces);
    const workspaceId = workspaces.alpha.workspaceId;
    const context = repositoryContext(workspaceScope(workspaceId, {
      kind: 'user', userId: workspaces.alpha.admin.userId, role: 'admin',
    }), isolated.session);
    const personId = records.alpha.contactId;
    const firmB = (await isolated.session.query<{ id: string }>(
      'INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',
      [workspaceId, 'Supported unrelated firm', workspaces.alpha.salesperson.userId],
    )).rows[0]?.id;
    if (firmB === undefined) throw new Error('firm fixture failed');
    expect((await bridgeLegacyContacts(context, [personId])).ok).toBe(true);
    expect((await addFirmSource(context, { firmId: firmB, sourceKey: 'firm-owned-b-evidence', excerpt: 'Dana confirmed the separate business relationship', occurredAt: '2026-10-01T14:00:00.000Z' })).ok).toBe(true);
    const source = (await readFirmSources(context, { firmId: firmB, limit: 50 }))?.sources[0];
    if (source === undefined || source.contentHash === null) throw new Error('source fixture failed');
    expect((await saveRelationship(context, {
      commandId: '11111111-1111-4111-8111-111111111111', clientVersion: '1.0.13',
      personId, firmId: firmB, status: 'current', startDate: null, endDate: null,
      evidence: { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash },
    })).ok).toBe(true);
    const preview = await previewDeletion(context, { targetKind: 'contact', firmId: records.alpha.firmId, contactId: personId });
    if (!preview.ok || preview.value === undefined) throw new Error('deletion preview failed');
    expect((await commitDeletion(context, { requestId: preview.value.requestId, previewHash: preview.value.previewHash, commandId: 'preserve-supported-independent-person', journal: recordingSuppressionJournal() })).ok).toBe(true);
    expect((await readPerson(context, personId))?.person.fullName).toBe('Dana Example');
    expect((await readRelationships(context, { personId, limit: 50 }))?.relationships).toEqual([
      expect.objectContaining({ firmId: firmB, sourceState: 'available' }),
    ]);
  } finally {
    await isolated.drop();
  }
});


it('contact deletion removes a firm-owned indivisible copy explicitly naming that person and original firm', async () => {
  const isolated = await createTestDatabase();
  try {
    const workspaces = await seedTwoWorkspaces(isolated.session);
    const records = await seedCrm(isolated.session, workspaces);
    const workspaceId = workspaces.alpha.workspaceId;
    const context = repositoryContext(workspaceScope(workspaceId, {
      kind: 'user', userId: workspaces.alpha.admin.userId, role: 'admin',
    }), isolated.session);
    const personId = records.alpha.contactId;
    const firmB = (await isolated.session.query<{ id: string }>(
      'INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',
      [workspaceId, 'Firm-owned mixed copy', workspaces.alpha.salesperson.userId],
    )).rows[0]?.id;
    if (firmB === undefined) throw new Error('firm fixture failed');
    expect((await bridgeLegacyContacts(context, [personId])).ok).toBe(true);
    for (const sourceKey of ['mixed-person-copy', 'uncontextualized-firm-copy']) {
      expect((await addFirmSource(context, { firmId: firmB, sourceKey, excerpt: sourceKey, occurredAt: '2026-10-01T14:00:00.000Z' })).ok).toBe(true);
    }
    const sources = (await readFirmSources(context, { firmId: firmB, limit: 50 }))?.sources;
    const source = sources?.find(candidate => candidate.excerpt === 'mixed-person-copy');
    const untouched = sources?.find(candidate => candidate.excerpt === 'uncontextualized-firm-copy');
    if (source === undefined || source.contentHash === null || untouched === undefined) throw new Error('source fixture failed');
    const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
    const relationship = await saveRelationship(context, {
      commandId: '11111111-1111-4111-8111-111111111111', clientVersion: '1.0.13',
      personId, firmId: records.alpha.firmId, status: 'current', startDate: null, endDate: null, evidence,
    });
    if (!relationship.ok || relationship.value.relationshipId === undefined) throw new Error('relationship fixture failed');
    expect((await saveSourceContext(context, { personId, relationshipId: relationship.value.relationshipId, relationshipRevision: 1, evidence })).ok).toBe(true);
    const preview = await previewDeletion(context, { targetKind: 'contact', firmId: records.alpha.firmId, contactId: personId });
    if (!preview.ok || preview.value === undefined) throw new Error('deletion preview failed');
    expect(preview.value.redacts['crm_selected_sources']).toBe(1);
    expect((await commitDeletion(context, { requestId: preview.value.requestId, previewHash: preview.value.previewHash, commandId: 'delete-firm-owned-person-context', journal: recordingSuppressionJournal() })).ok).toBe(true);
    expect((await readFirmSources(context, { firmId: firmB, limit: 50 }))?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: source.sourceId, availability: 'deleted', excerpt: null }),
      expect.objectContaining({ sourceId: untouched.sourceId, availability: 'available', excerpt: 'uncontextualized-firm-copy' }),
    ]));
    expect((await readSourceContexts(context, { personId, limit: 50 }))?.contexts).toEqual([
      expect.objectContaining({ sourceId: source.sourceId, review: 'required' }),
    ]);
  } finally {
    await isolated.drop();
  }
});


it('deletion and a permitted surviving-context read both finish without exposing a deleted copy', async () => {
  const isolated = await createTestDatabase();
  try {
    const workspaces = await seedTwoWorkspaces(isolated.session);
    const records = await seedCrm(isolated.session, workspaces);
    const workspaceId = workspaces.alpha.workspaceId;
    const actor = { kind: 'user', userId: workspaces.alpha.admin.userId, role: 'admin' } as const;
    const context = repositoryContext(workspaceScope(workspaceId, actor), isolated.session);
    const personId = records.alpha.contactId;
    const firmB = '00000000-0000-4000-8000-000000000001';
    await isolated.session.query('INSERT INTO firms(workspace_id,id,name,assigned_user_id) VALUES($1,$2,$3,$4)',
      [workspaceId, firmB, 'Surviving concurrent history', workspaces.alpha.salesperson.userId]);
    await bridgeLegacyContacts(context, [personId]);
    // Establish B capture authority before the later legacy move to A.
    await isolated.session.query('UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2', [workspaceId, personId, firmB]);
    await addSelectedSource(context, { personId, sourceKey: 'concurrent-b-only', excerpt: 'Surviving B history', occurredAt: '2026-10-01T14:00:00.000Z' });
    await isolated.session.query('UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2', [workspaceId, personId, records.alpha.firmId]);
    const source = (await readPerson(context, personId))?.sources[0];
    if (source === undefined || source.contentHash === null) throw new Error('source fixture failed');
    const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
    const relationship = await saveRelationship(context, {
      commandId: '11111111-1111-4111-8111-111111111111', clientVersion: '1.0.13',
      personId, firmId: firmB, status: 'current', startDate: null, endDate: null, evidence,
    });
    if (!relationship.ok || relationship.value.relationshipId === undefined) throw new Error('relationship fixture failed');
    await saveSourceContext(context, { personId, relationshipId: relationship.value.relationshipId, relationshipRevision: 1, evidence });
    const preview = await previewDeletion(context, { targetKind: 'contact', firmId: records.alpha.firmId, contactId: personId });
    if (!preview.ok) throw new Error('preview fixture failed');
    const holder = await isolated.appRuntimeSession();
    const deleting = await isolated.appRuntimeSession();
    const observer = await isolated.appRuntimeSession();
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, firmB]);
    const pending = withTransaction(deleting, () => commitDeletion(repositoryContext(workspaceScope(workspaceId, actor), deleting), {
      requestId: preview.value.requestId, previewHash: preview.value.previewHash,
      commandId: 'concurrent-context-deletion', journal: recordingSuppressionJournal(),
    }));
    // Observe only a database barrier; outcomes are checked through public reads.
    try {
      let reached = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const blocked = (await observer.query<{ blocked: boolean }>(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0]?.blocked;
        if (blocked === true) { reached = true; break; }
        await delay(5);
      }
      if (!reached) throw new Error('deletion did not reach database barrier');
      expect((await readSourceContexts(repositoryContext(workspaceScope(workspaceId, actor), holder), { personId, limit: 50 }))?.contexts).toEqual([
        expect.objectContaining({ sourceId: source.sourceId, firmId: firmB, review: 'current' }),
      ]);
    } finally {
      await holder.query('COMMIT');
    }
    expect((await pending).ok).toBe(true);
    expect((await readPerson(context, personId))?.sources[0]).toMatchObject({ sourceId: source.sourceId, availability: 'available', excerpt: 'Surviving B history' });
  } finally {
    await isolated.drop();
  }
});


it('requires a fresh deletion preview when supported relationship revision changes without changing counts', async () => {
  const isolated = await createTestDatabase();
  try {
    const workspaces = await seedTwoWorkspaces(isolated.session);
    const records = await seedCrm(isolated.session, workspaces);
    const context = repositoryContext(workspaceScope(workspaces.alpha.workspaceId, {
      kind: 'user', userId: workspaces.alpha.admin.userId, role: 'admin',
    }), isolated.session);
    const personId = records.alpha.contactId;
    await bridgeLegacyContacts(context, [personId]);
    await addSelectedSource(context, { personId, sourceKey: 'preview-version', excerpt: 'Relationship evidence', occurredAt: '2026-10-01T14:00:00.000Z' });
    const source = (await readPerson(context, personId))?.sources[0];
    if (source === undefined || source.contentHash === null) throw new Error('source fixture failed');
    const evidence = { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash };
    const saved = await saveRelationship(context, {
      commandId: '11111111-1111-4111-8111-111111111111', clientVersion: '1.0.13',
      personId, firmId: records.alpha.firmId, status: 'current', startDate: null, endDate: null, evidence,
    });
    if (!saved.ok || saved.value.relationshipId === undefined) throw new Error('relationship fixture failed');
    const preview = await previewDeletion(context, { targetKind: 'contact', firmId: records.alpha.firmId, contactId: personId });
    if (!preview.ok) throw new Error('preview fixture failed');
    expect((await correctRelationship(context, {
      commandId: '22222222-2222-4222-8222-222222222222', clientVersion: '1.0.13',
      personId, relationshipId: saved.value.relationshipId, expectedRevision: 1,
      firmId: records.alpha.firmId, status: 'historical', startDate: null, endDate: null, evidence,
    })).ok).toBe(true);
    expect(await commitDeletion(context, { requestId: preview.value.requestId, previewHash: preview.value.previewHash,
      commandId: 'reject-stale-version-preview', journal: recordingSuppressionJournal() })).toMatchObject({ ok: false, reason: 'preview_stale' });
    expect((await readPerson(context, personId))?.sources[0]?.excerpt).toBe('Relationship evidence');
  } finally {
    await isolated.drop();
  }
});
