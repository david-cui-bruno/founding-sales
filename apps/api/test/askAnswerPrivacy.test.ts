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
    const requested = await post('/ask/answers/request', command({ question: 'Who handles maintenance triage?', scope: { sources: [{ workspaceId: fixture.alpha.workspaceId, sourceId, kind: 'selected_note', revision: 1, contentHash: createHash('sha256').update(text).digest('hex'), locator: null }] } }));
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({ result: { state: 'unavailable' } });
    const deletionPreview = await post('/retention/deletions/preview', command({ targetKind: 'firm', firmId }));
    expect(deletionPreview.status).toBe(200);
    expect(deletionPreview.body).toMatchObject({ result: { redacts: { crm_ask_requests: 1 } } });
  } finally {
    await fixture.stop();
  }
});
