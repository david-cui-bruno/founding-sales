import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

it('includes a privately saved unanswered question in firm deletion before any answer windows exist', async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const post = (path: string, body: unknown) => dispatch(
      { method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
      { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false, suppressionJournal: recordingSuppressionJournal() },
    );
    const command = (fields: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
    const firmId = await seedFirm(fixture, { name: 'Private unanswered question firm', assignedUserId: fixture.alpha.admin.userId });
    const text = 'Our maintenance triage is handled by one coordinator.';
    const selection = { text, subtype: 'pasted_text', label: 'Explicitly selected business note', direction: 'unknown', participants: [], occurredAt: null, attachments: [] };
    const importedPreview = await post('/crm/imports/preview', selection);
    expect(importedPreview.status).toBe(200);
    const imported = await post('/crm/imports/commit', command({ ...selection, personId: null, firmId, importKey: randomUUID(), previewHash: (importedPreview.body as { previewHash: string }).previewHash, parserVersion: 'selected-v1' }));
    expect(imported.status).toBe(200);
    const sourceId = (imported.body as { result: { sourceId: string } }).result.sourceId;
    const question = 'Maintenance triage';
    const requestCommand = command({ question, scope: { sources: [{ workspaceId: fixture.alpha.workspaceId, sourceId, kind: 'selected_note', revision: 1, contentHash: createHash('sha256').update(text).digest('hex'), locator: null }] } });
    const requested = await post('/ask/answers/request', requestCommand);
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({ result: { state: 'unavailable' } });
    const requestId = (requested.body as { result: { requestId: string } }).result.requestId;
    const beforeDeletion = await post('/ask/answers/read', { requestId });
    expect(beforeDeletion.status).toBe(200);
    expect(beforeDeletion.body).toMatchObject({ question, fallback: { passages: [{ text }] }, answer: null });
    const deletionPreview = await post('/retention/deletions/preview', command({ targetKind: 'firm', firmId }));
    expect(deletionPreview.status).toBe(200);
    expect(deletionPreview.body).toMatchObject({ result: { redacts: { crm_ask_requests: 1 } } });
    const shown = (deletionPreview.body as { result: { requestId: string; previewHash: string } }).result;
    const committed = await post('/retention/deletions/commit', command({ requestId: shown.requestId, previewHash: shown.previewHash }));
    expect(committed.status).toBe(200);
    const afterDeletion = await post('/ask/answers/read', { requestId });
    expect(afterDeletion.status).toBe(200);
    expect(afterDeletion.body).toMatchObject({ state: 'deleted', reason: 'deleted', question: null, fallback: null, answer: null });
    const replayed = await post('/ask/answers/request', requestCommand);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ replayed: true, result: { requestId, version: 1, state: 'unavailable' } });
    expect(JSON.stringify(replayed.body)).not.toContain(question);
    expect(JSON.stringify(replayed.body)).not.toContain(text);
  } finally {
    await fixture.stop();
  }
});
