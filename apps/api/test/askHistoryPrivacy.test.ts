import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import type { AskAnswerAdapter } from '@fss/domain/crm/askAnswerPorts.ts';

it('deletes renamed private history during an accepted answer wait without deleting its source or losing the charge', async () => {
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
    const renamed = await post('/ask/history/change', command({ requestId, expectedRevision: 1, action: { kind: 'rename', title: 'Private coordinator follow-up' } }));
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ result: { historyRevision: 2 } });
    expect((await post('/ask/history/list', {})).body).toMatchObject({ items: [{ requestId, historyRevision: 2, title: 'Private coordinator follow-up', createdAt: expect.any(String) }] });
    expect((await post('/ask/history/change', command({ requestId, expectedRevision: 1, action: { kind: 'delete' } }))).status).toBe(409);
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'pending', question: 'maintenance routing' });
    const erased = await post('/ask/history/change', command({ requestId, expectedRevision: 2, action: { kind: 'delete' } }));
    expect(erased.status).toBe(200);
    expect((await post('/ask/history/list', {})).body).toMatchObject({ items: [], nextCursor: null });
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'deleted', question: null, fallback: null, answer: null });
    releaseAnswer!();
    await worker;
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'deleted', question: null, fallback: null, answer: null });
    expect((await post('/ask/answers/source/read', { requestId, expectedVersion: 1, windowId: citationWindowId })).status).toBe(404);
    expect((await post('/ask/history/list', {})).body).toMatchObject({ items: [], nextCursor: null });
    const retained = await post('/crm/imports/read', { firmId });
    expect(retained.status).toBe(200);
    expect(retained.body).toMatchObject({ imports: [{ source: { sourceId, excerpt: text, availability: 'available' } }] });
    expect((await post('/research/firm', { firmId })).body).toMatchObject({ spend: { todayCents: 6, monthToDateCents: 6 } });
    await runOnce(fixture.db, { registry, owner: 'post-delete-answer-worker', limit: 20 });
    expect(calls).toBe(1);
  } finally {
    releaseAnswer?.();
    await worker;
    await fixture.stop();
  }
});
