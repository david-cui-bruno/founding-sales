import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import type { AskAnswerAdapter } from '@fss/domain/crm/askAnswerPorts.ts';

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

it('settles an accepted answer charge after source deletion without publishing or reopening the erased question', async () => {
  const fixture = await createAuthFixture();
  let releaseAnswer: (() => void) | undefined;
  let worker: ReturnType<typeof runOnce> | undefined;
  try {
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const post = (path: string, body: unknown) => dispatch(
      { method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
      { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false },
    );
    const command = (fields: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
    const firmId = await seedFirm(fixture, { name: 'Controlled answer accounting firm', assignedUserId: fixture.alpha.salesperson.userId });
    const text = 'Private maintenance routing requires a coordinator.';
    const selection = { text, subtype: 'pasted_text', label: 'Private processing input', direction: 'unknown', participants: [], occurredAt: null, attachments: [] };
    const preview = await post('/crm/imports/preview', selection);
    expect(preview.status).toBe(200);
    const imported = await post('/crm/imports/commit', command({ ...selection, personId: null, firmId, importKey: randomUUID(), previewHash: (preview.body as { previewHash: string }).previewHash, parserVersion: 'selected-v1' }));
    expect(imported.status).toBe(200);
    const sourceId = (imported.body as { result: { sourceId: string } }).result.sourceId;
    await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','ask-only-fixture-grant','fixture-no-retention',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',10000,100000,1000,1000,$3)`, [fixture.alpha.workspaceId, 'a'.repeat(64), fixture.alpha.admin.userId]);
    const requested = await post('/ask/answers/request', command({ question: 'maintenance routing', scope: { sources: [{ workspaceId: fixture.alpha.workspaceId, sourceId, kind: 'selected_note', revision: 1, contentHash: createHash('sha256').update(text).digest('hex'), locator: null }] } }));
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({ result: { state: 'pending' } });
    const requestId = (requested.body as { result: { requestId: string } }).result.requestId;
    expect((await post('/research/firm', { firmId })).body).toMatchObject({ spend: { todayCents: 0, monthToDateCents: 0 } });
    let enteredAnswer: () => void = () => {};
    const entered = new Promise<void>(resolve => { enteredAnswer = resolve; });
    const held = new Promise<void>(resolve => { releaseAnswer = resolve; });
    let citationWindowId = '';
    let calls = 0;
    const adapter: AskAnswerAdapter = {
      endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer',
      async run(input) {
        calls++;
        citationWindowId = input.windows[0]!.id;
        enteredAnswer();
        await held;
        return { acceptance: 'accepted', usage: { inputTokens: 50, outputTokens: 10 }, answer: { claims: [{ text, kind: 'extractive', citationWindowIds: [citationWindowId] }], abstained: false } };
      },
    };
    const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, crmAskAnswers: { allowControlledEvaluation: true, verifyPurpose: async proof => ({ configFingerprint: proof.configFingerprint, authorizationFingerprint: proof.authorizationFingerprint, validUntil: '2099-01-01T00:00:00Z', evaluationKind: 'controlled_fixture' }), answer: adapter } });
    worker = runOnce(fixture.db, { registry, owner: 'held-answer-privacy-worker', limit: 20 });
    await Promise.race([entered, worker.then(() => { throw new Error('Controlled answer did not reach its held provider wait'); })]);
    const heldSpend = await post('/research/firm', { firmId });
    expect(heldSpend.status).toBe(200);
    expect((heldSpend.body as { spend: { todayCents: number } }).spend.todayCents).toBeGreaterThan(6);
    expect((await post('/crm/imports/delete', command({ sourceId, expectedSourceRevision: 1, expectedMetadataRevision: 1 }))).status).toBe(200);
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'deleted', question: null, fallback: null, answer: null });
    releaseAnswer!();
    await worker;
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'deleted', question: null, fallback: null, answer: null });
    expect((await post('/ask/answers/source/read', { requestId, expectedVersion: 1, windowId: citationWindowId })).status).toBe(404);
    expect((await post('/research/firm', { firmId })).body).toMatchObject({ spend: { todayCents: 6, monthToDateCents: 6 } });
    await runOnce(fixture.db, { registry, owner: 'post-delete-answer-worker', limit: 20 });
    expect(calls).toBe(1);
  } finally {
    releaseAnswer?.();
    await worker;
    await fixture.stop();
  }
});

it('erases an unanswered question when its selected copy is deleted and cannot revive it after restore', async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const post = (path: string, body: unknown) => dispatch(
      { method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
      { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false },
    );
    const command = (fields: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
    const person = await post('/crm/people/create', command({ fullName: 'Private question correspondent' }));
    expect(person.status).toBe(200);
    const personId = (person.body as { result: { personId: string } }).result.personId;
    const text = 'Private maintenance triage instructions are retained in this selected note.';
    const selection = { text, subtype: 'pasted_text', label: 'Private selected business note', direction: 'unknown', participants: [], occurredAt: null, attachments: [] };
    const preview = await post('/crm/imports/preview', selection);
    expect(preview.status).toBe(200);
    const imported = await post('/crm/imports/commit', command({ ...selection, personId, firmId: null, importKey: randomUUID(), previewHash: (preview.body as { previewHash: string }).previewHash, parserVersion: 'selected-v1' }));
    expect(imported.status).toBe(200);
    const sourceId = (imported.body as { result: { sourceId: string } }).result.sourceId;
    const question = 'Private maintenance triage';
    const requested = await post('/ask/answers/request', command({ question, scope: { sources: [{ workspaceId: fixture.alpha.workspaceId, sourceId, kind: 'selected_note', revision: 1, contentHash: createHash('sha256').update(text).digest('hex'), locator: null }] } }));
    expect(requested.status).toBe(200);
    const requestId = (requested.body as { result: { requestId: string } }).result.requestId;
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ question, fallback: { passages: [{ text }] } });
    const deleted = await post('/crm/imports/delete', command({ sourceId, expectedSourceRevision: 1, expectedMetadataRevision: 1 }));
    expect(deleted.status).toBe(200);
    const erased = await post('/ask/answers/read', { requestId });
    expect(erased.status).toBe(200);
    expect(erased.body).toMatchObject({ state: 'deleted', reason: 'deleted', question: null, fallback: null, answer: null });
    const restored = await post('/crm/imports/restore', command({ sourceId, expectedSourceRevision: 2, expectedMetadataRevision: 2 }));
    expect(restored.status).toBe(200);
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'deleted', reason: 'deleted', question: null, fallback: null, answer: null });
  } finally {
    await fixture.stop();
  }
});

it('refuses old citations and another owner after a source correction during answer generation', async () => {
  const fixture = await createAuthFixture();
  let releaseAnswer: (() => void) | undefined;
  let worker: ReturnType<typeof runOnce> | undefined;
  try {
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const post = (path: string, body: unknown) => dispatch(
      { method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
      { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false },
    );
    const command = (fields: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
    const firmId = await seedFirm(fixture, { name: 'Controlled corrected answer firm', assignedUserId: fixture.alpha.salesperson.userId });
    const text = 'Private maintenance routing requires a coordinator.';
    const selection = { text, subtype: 'pasted_text', label: 'Private processing input', direction: 'unknown', participants: [], occurredAt: null, attachments: [] };
    const preview = await post('/crm/imports/preview', selection);
    expect(preview.status).toBe(200);
    const imported = await post('/crm/imports/commit', command({ ...selection, personId: null, firmId, importKey: randomUUID(), previewHash: (preview.body as { previewHash: string }).previewHash, parserVersion: 'selected-v1' }));
    expect(imported.status).toBe(200);
    const sourceId = (imported.body as { result: { sourceId: string } }).result.sourceId;
    await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','ask-only-fixture-grant','fixture-no-retention',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',10000,100000,1000,1000,$3)`, [fixture.alpha.workspaceId, 'a'.repeat(64), fixture.alpha.admin.userId]);
    const requested = await post('/ask/answers/request', command({ question: 'maintenance routing', scope: { sources: [{ workspaceId: fixture.alpha.workspaceId, sourceId, kind: 'selected_note', revision: 1, contentHash: createHash('sha256').update(text).digest('hex'), locator: null }] } }));
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({ result: { state: 'pending' } });
    const requestId = (requested.body as { result: { requestId: string } }).result.requestId;
    expect((await post('/research/firm', { firmId })).body).toMatchObject({ spend: { todayCents: 0, monthToDateCents: 0 } });
    let enteredAnswer: () => void = () => {};
    const entered = new Promise<void>(resolve => { enteredAnswer = resolve; });
    const held = new Promise<void>(resolve => { releaseAnswer = resolve; });
    let citationWindowId = '';
    let calls = 0;
    const adapter: AskAnswerAdapter = {
      endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer',
      async run(input) {
        calls++;
        citationWindowId = input.windows[0]!.id;
        enteredAnswer();
        await held;
        return { acceptance: 'accepted', usage: { inputTokens: 50, outputTokens: 10 }, answer: { claims: [{ text, kind: 'extractive', citationWindowIds: [citationWindowId] }], abstained: false } };
      },
    };
    const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, crmAskAnswers: { allowControlledEvaluation: true, verifyPurpose: async proof => ({ configFingerprint: proof.configFingerprint, authorizationFingerprint: proof.authorizationFingerprint, validUntil: '2099-01-01T00:00:00Z', evaluationKind: 'controlled_fixture' }), answer: adapter } });
    worker = runOnce(fixture.db, { registry, owner: 'held-answer-correction-worker', limit: 20 });
    await Promise.race([entered, worker.then(() => { throw new Error('Controlled answer did not reach its held provider wait'); })]);
    const heldSpend = await post('/research/firm', { firmId });
    expect(heldSpend.status).toBe(200);
    expect((heldSpend.body as { spend: { todayCents: number } }).spend.todayCents).toBeGreaterThan(6);
    const correctedSelection = { ...selection, text: 'Updated maintenance routing has a different coordinator.' };
    const correctionPreview = await post('/crm/imports/preview', correctedSelection);
    expect(correctionPreview.status).toBe(200);
    const corrected = await post('/crm/imports/correct', command({ ...correctedSelection, sourceId, expectedSourceRevision: 1, expectedMetadataRevision: 1, previewHash: (correctionPreview.body as { previewHash: string }).previewHash, parserVersion: 'selected-v1' }));
    expect(corrected.status).toBe(200);
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ question: null, fallback: null, answer: null });
    releaseAnswer!();
    await worker;
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'stale', question: null, fallback: null, answer: null });
    expect((await post('/ask/answers/source/read', { requestId, expectedVersion: 1, windowId: citationWindowId })).status).toBe(404);
    expect((await post('/research/firm', { firmId })).body).toMatchObject({ spend: { todayCents: 6, monthToDateCents: 6 } });
    const otherToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    for (const [path, body] of [
      ['/ask/answers/read', { requestId }],
      ['/ask/answers/source/read', { requestId, expectedVersion: 1, windowId: citationWindowId }],
    ] as const) {
      const denied = await dispatch({ method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${otherToken}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
      expect(denied.status).toBe(404);
      expect(JSON.stringify(denied.body)).not.toContain('maintenance routing');
      expect(JSON.stringify(denied.body)).not.toContain(text);
    }
    await runOnce(fixture.db, { registry, owner: 'post-correction-answer-worker', limit: 20 });
    expect(calls).toBe(1);
  } finally {
    releaseAnswer?.();
    await worker;
    await fixture.stop();
  }
});
