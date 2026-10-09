import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import type { AskAnswerAdapter, AskAnswerComposition } from '@fss/domain/crm/askAnswerPorts.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

async function selectedAnswer(text = 'Maintenance routing requires a coordinator.') {
  const fixture = await createAuthFixture();
  try {
    const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const post = (path: string, body: unknown) => dispatch(
      { method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } },
      { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false },
    );
    const command = (fields: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
    const firmId = await seedFirm(fixture, { name: 'Controlled source safety firm', assignedUserId: fixture.alpha.salesperson.userId });
    const selection = { text, subtype: 'pasted_text', label: 'Controlled source content', direction: 'unknown', participants: [], occurredAt: null, attachments: [] };
    const preview = await post('/crm/imports/preview', selection);
    expect(preview.status).toBe(200);
    const imported = await post('/crm/imports/commit', command({ ...selection, personId: null, firmId, importKey: randomUUID(), previewHash: (preview.body as { previewHash: string }).previewHash, parserVersion: 'selected-v1' }));
    expect(imported.status).toBe(200);
    const sourceId = (imported.body as { result: { sourceId: string } }).result.sourceId;
    await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','ask-only-fixture-grant','fixture-no-retention',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',10,100,1,1,$3)`, [fixture.alpha.workspaceId, 'a'.repeat(64), fixture.alpha.admin.userId]);
    const requested = await post('/ask/answers/request', command({ question: 'maintenance routing', scope: { sources: [{ workspaceId: fixture.alpha.workspaceId, sourceId, kind: 'selected_note', revision: 1, contentHash: createHash('sha256').update(text).digest('hex'), locator: null }] } }));
    expect(requested.status).toBe(200);
    expect(requested.body).toMatchObject({ result: { state: 'pending' } });
    const requestId = (requested.body as { result: { requestId: string } }).result.requestId;
    const run = async (answer: AskAnswerAdapter['run'], extras: Pick<AskAnswerComposition, 'support' | 'retrieval'> = {}) => {
      const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, crmAskAnswers: { allowControlledEvaluation: true, verifyPurpose: async proof => ({ configFingerprint: proof.configFingerprint, authorizationFingerprint: proof.authorizationFingerprint, validUntil: '2099-01-01T00:00:00Z', evaluationKind: 'controlled_fixture' }), answer: { endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer', run: answer }, ...extras } });
      await runOnce(fixture.db, { registry, owner: 'controlled-answer-safety-worker', limit: 20 });
    };
    return { fixture, post, requestId, sourceId, firmId, text, run };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}

it('refuses a fabricated citation window instead of publishing a source-shaped claim', async () => {
  const selected = await selectedAnswer();
  try {
    const fabricatedWindowId = randomUUID();
    await selected.run(async () => ({ acceptance: 'accepted', usage: { inputTokens: 50, outputTokens: 10 }, answer: { claims: [{ text: selected.text, kind: 'extractive', citationWindowIds: [fabricatedWindowId] }], abstained: false } }));
    const read = await selected.post('/ask/answers/read', { requestId: selected.requestId });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ state: 'unavailable', reason: 'unsupported_answer', answer: null });
    expect((await selected.post('/ask/answers/source/read', { requestId: selected.requestId, expectedVersion: 1, windowId: fabricatedWindowId })).status).toBe(404);
  } finally {
    await selected.fixture.stop();
  }
});
