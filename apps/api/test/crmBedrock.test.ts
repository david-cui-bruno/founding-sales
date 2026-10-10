import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createBedrockAskAnswerAdapter, type CrmBedrockSurface } from '../../worker/src/providers/crmBedrock.ts';
import { composeCrmBedrock } from '../../worker/src/bootstrap/crmBedrock.ts';
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
    const run = async (answer: AskAnswerAdapter['run'], extras: Partial<AskAnswerComposition> = {}) => {
      const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, crmAskAnswers: { allowControlledEvaluation: true, verifyPurpose: async proof => ({ configFingerprint: proof.configFingerprint, authorizationFingerprint: proof.authorizationFingerprint, validUntil: '2099-01-01T00:00:00Z', evaluationKind: 'controlled_fixture' }), answer: { endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer', run: answer }, ...extras } });
      await runOnce(fixture.db, { registry, owner: 'controlled-answer-safety-worker', limit: 20 });
    };
    return { fixture, post, requestId, sourceId, firmId, text, run };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}

it('publishes exact source-linked JSON from Bedrock through the registered worker and charges reported usage', async () => {
  const selected = await selectedAnswer();
  try {
    let calls = 0;
    const surface: CrmBedrockSurface = { async converse(input) {
      calls++;
      const payload = JSON.parse(input.messages[0]!.content[0]!.text) as { windows: { id: string }[] };
      return { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10 }, output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ claims: [{ text: selected.text, kind: 'extractive', citationWindowIds: [payload.windows[0]!.id] }], abstained: false }) }] } } };
    } };
    const adapter = createBedrockAskAnswerAdapter({ surface, endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer' });
    await selected.run(adapter.run);
    const read = await selected.post('/ask/answers/read', { requestId: selected.requestId });
    expect(read.body).toMatchObject({ state: 'complete', answer: { claims: [{ text: selected.text, verification: 'supported' }] } });
    expect(calls).toBe(1);
    expect((await selected.post('/research/firm', { firmId: selected.firmId })).body).toMatchObject({ spend: { todayCents: 1, monthToDateCents: 1 } });
  } finally { await selected.fixture.stop(); }
});

it('conserves ambiguous Bedrock acceptance and does not invoke again on worker retry', async () => {
  const selected = await selectedAnswer();
  try {
    let calls = 0;
    const adapter = createBedrockAskAnswerAdapter({ endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer', surface: { async converse() { calls++; throw new Error('private socket failure'); } } });
    await selected.run(adapter.run);
    await selected.run(adapter.run);
    expect(calls).toBe(1);
    expect((await selected.post('/ask/answers/read', { requestId: selected.requestId })).body).toMatchObject({ state: 'unknown_acceptance', answer: null });
    expect((await selected.post('/research/firm', { firmId: selected.firmId })).body).toMatchObject({ spend: { todayCents: 1, monthToDateCents: 1 } });
  } finally { await selected.fixture.stop(); }
});

it('settles a proven Bedrock authorization refusal at zero without publishing provider error text', async () => {
  const selected = await selectedAnswer();
  try {
    const adapter = createBedrockAskAnswerAdapter({ endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer', surface: { async converse() { throw Object.assign(new Error('private request text'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }); } } });
    await selected.run(adapter.run);
    const read = await selected.post('/ask/answers/read', { requestId: selected.requestId });
    expect(read.body).toMatchObject({ state: 'unavailable', reason: 'processing_failed', answer: null });
    expect(JSON.stringify(read.body)).not.toContain('private request text');
    expect((await selected.post('/research/firm', { firmId: selected.firmId })).body).toMatchObject({ spend: { todayCents: 0, monthToDateCents: 0 } });
  } finally { await selected.fixture.stop(); }
});

it('charges a truncated billed response but refuses its apparently valid claim', async () => {
  const selected = await selectedAnswer();
  try {
    const adapter = createBedrockAskAnswerAdapter({ endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer', surface: { async converse(input) {
      const payload = JSON.parse(input.messages[0]!.content[0]!.text) as { windows: { id: string }[] };
      return { stopReason: 'max_tokens', usage: { inputTokens: 50, outputTokens: 10 }, output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ claims: [{ text: selected.text, kind: 'extractive', citationWindowIds: [payload.windows[0]!.id] }], abstained: false }) }] } } };
    } } });
    await selected.run(adapter.run);
    expect((await selected.post('/ask/answers/read', { requestId: selected.requestId })).body).toMatchObject({ state: 'unavailable', reason: 'processing_failed', answer: null });
    expect((await selected.post('/research/firm', { firmId: selected.firmId })).body).toMatchObject({ spend: { todayCents: 1, monthToDateCents: 1 } });
  } finally { await selected.fixture.stop(); }
});

it('binds purpose-specific extraction into the normal registry and publishes exact quoted evidence', async () => {
  const selected = await selectedAnswer();
  try {
    const created = await selected.post('/crm/people/create', { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, fullName: 'Bedrock extraction fixture' });
    const personId = (created.body as { result: { personId: string } }).result.personId;
    const text = 'We need faster repairs.';
    expect((await selected.post('/crm/people/source/add', { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, personId, sourceKey: 'bedrock-extraction', excerpt: text, occurredAt: '2026-10-01T14:00:00Z' })).status).toBe(200);
    const page = await selected.post('/crm/people/read', { personId });
    const stored = (page.body as { sources: { workspaceId: string; sourceId: string; revision: number; contentHash: string }[] }).sources[0]!;
    const source = { workspaceId: stored.workspaceId, sourceId: stored.sourceId, revision: stored.revision, contentHash: stored.contentHash, kind: 'selected_note', locator: null };
    await selected.fixture.db.query(`INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,1,true,'controlled-extraction','literal-v1','extraction-only-grant','fixture-no-retention',10,100,1,1,$2)`, [selected.fixture.alpha.workspaceId, selected.fixture.alpha.admin.userId]);
    expect((await selected.post('/crm/processing/request', { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, source })).status).toBe(200);
    let calls = 0;
    const composition = composeCrmBedrock({ surface: { async converse(input) {
      calls++;
      expect(input.modelId).toBe('literal-v1');
      expect(input.messages[0]!.content[0]!.text).toBe(text);
      expect(input.inferenceConfig.maxTokens).toBe(4096);
      return { stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 30 }, output: { message: { role: 'assistant', content: [{ text: JSON.stringify([{ kind: 'need', interpretation: 'Faster repairs', status: 'stated', locator: 'text:0:23', quote: text }]) }] } } };
    } }, extraction: { endpointId: 'controlled-extraction', modelVersion: 'literal-v1', accessGrantVersion: 'extraction-only-grant', dataHandlingVersion: 'fixture-no-retention', providerKey: 'fixture.crm_extraction', fundingVerifiedUntil: '2099-01-01T00:00:00Z' } });
    const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, ...composition });
    await runOnce(selected.fixture.db, { registry, owner: 'controlled-bedrock-extraction', limit: 20 });
    expect(calls).toBe(1);
    expect((await selected.post('/crm/processing/read', { source })).body).toMatchObject({ state: 'complete', claims: [{ kind: 'need', quote: text }], financial: { dispatchState: 'settled', settledCents: 1 } });
  } finally { await selected.fixture.stop(); }
});

it('transfers no original text to Bedrock when exact purpose verification fails', async () => {
  const selected = await selectedAnswer();
  try {
    let calls = 0;
    const composition = composeCrmBedrock({ surface: { async converse() { calls++; throw new Error('Must not receive private evidence'); } }, answer: { endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer' }, verifyPurpose: async () => null });
    await selected.run(composition.crmAskAnswers!.answer!.run, composition.crmAskAnswers);
    expect(calls).toBe(0);
    expect((await selected.post('/ask/answers/read', { requestId: selected.requestId })).body).toMatchObject({ state: 'unavailable', reason: 'processing_authority_unavailable', answer: null });
    expect((await selected.post('/research/firm', { firmId: selected.firmId })).body).toMatchObject({ spend: { todayCents: 0, monthToDateCents: 0 } });
  } finally { await selected.fixture.stop(); }
});

it('erases copied source input and refuses Bedrock publication when deletion occurs during its response', async () => {
  const selected = await selectedAnswer();
  try {
    const adapter = createBedrockAskAnswerAdapter({ endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer', surface: { async converse(input) {
      const payload = JSON.parse(input.messages[0]!.content[0]!.text) as { windows: { id: string }[] };
      expect((await selected.post('/crm/imports/delete', { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, sourceId: selected.sourceId, expectedSourceRevision: 1, expectedMetadataRevision: 1 })).status).toBe(200);
      return { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10 }, output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ claims: [{ text: selected.text, kind: 'extractive', citationWindowIds: [payload.windows[0]!.id] }], abstained: false }) }] } } };
    } } });
    await selected.run(adapter.run);
    const read = await selected.post('/ask/answers/read', { requestId: selected.requestId });
    expect(read.body).toMatchObject({ answer: null });
    expect(JSON.stringify(read.body)).not.toContain(selected.text);
    expect((await selected.post('/research/firm', { firmId: selected.firmId })).body).toMatchObject({ spend: { todayCents: 1, monthToDateCents: 1 } });
  } finally { await selected.fixture.stop(); }
});

it.each([
  ['service timeout', Object.assign(new Error('private timeout'), { name: 'ModelTimeoutException', $metadata: { httpStatusCode: 408 } })],
  ['unproved authorization exception', Object.assign(new Error('private denial'), { name: 'AccessDeniedException' })],
])('keeps the full reservation for %s rather than treating it as a free refusal', async (_label, error) => {
  const selected = await selectedAnswer();
  try {
    const adapter = createBedrockAskAnswerAdapter({ endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer', surface: { async converse() { throw error; } } });
    await selected.run(adapter.run);
    expect((await selected.post('/ask/answers/read', { requestId: selected.requestId })).body).toMatchObject({ state: 'unknown_acceptance', answer: null });
    expect((await selected.post('/research/firm', { firmId: selected.firmId })).body).toMatchObject({ spend: { todayCents: 1, monthToDateCents: 1 } });
  } finally { await selected.fixture.stop(); }
});

it('does not publish apparently valid JSON when provider usage is absent', async () => {
  const selected = await selectedAnswer();
  try {
    const adapter = createBedrockAskAnswerAdapter({ endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer', surface: { async converse(input) {
      const payload = JSON.parse(input.messages[0]!.content[0]!.text) as { windows: { id: string }[] };
      return { stopReason: 'end_turn', output: { message: { role: 'assistant', content: [{ text: JSON.stringify({ claims: [{ text: selected.text, kind: 'extractive', citationWindowIds: [payload.windows[0]!.id] }], abstained: false }) }] } } };
    } } });
    await selected.run(adapter.run);
    expect((await selected.post('/ask/answers/read', { requestId: selected.requestId })).body).toMatchObject({ state: 'unknown_acceptance', answer: null });
  } finally { await selected.fixture.stop(); }
});

it('extracts native transcript claims with original utterance locators and speaker attribution', async () => {
  const selected = await selectedAnswer();
  try {
    const workspaceId = selected.fixture.alpha.workspaceId;
    const meetingId = randomUUID(), recordingId = randomUUID(), transcriptId = randomUUID();
    await selected.fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'bedrock-native','bedrock-native','booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())", [workspaceId, meetingId, selected.firmId]);
    await selected.fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Synthetic native transcript',$4,100,$5,'ready')", [workspaceId, recordingId, meetingId, 'a'.repeat(64), `meetings/${meetingId}/${'a'.repeat(64)}.m4a`]);
    const quote = 'We need a repair coordinator.';
    const utterances = [{ startMs: 0, endMs: 5000, text: quote, speaker: 'Fixture speaker', attribution: 'source_label' }];
    await selected.fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)", [workspaceId, transcriptId, recordingId, JSON.stringify(utterances)]);
    const source = { workspaceId, kind: 'meeting_transcript', sourceId: transcriptId, revision: 1, contentHash: createHash('sha256').update(JSON.stringify(utterances)).digest('hex'), locator: null };
    await selected.fixture.db.query(`INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,1,true,'controlled-extraction','literal-v1','extraction-only-grant','fixture-no-retention',10,100,1,1,$2)`, [workspaceId, selected.fixture.alpha.admin.userId]);
    expect((await selected.post('/crm/processing/request', { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, source })).status).toBe(200);
    const composition = composeCrmBedrock({ surface: { async converse(input) {
      expect(input.system[0]!.text).toContain('utterance:N:text:start:end');
      expect(input.system[0]!.text).toContain('not serialized JSON');
      expect(Buffer.byteLength(input.system[0]!.text)).toBeLessThanOrEqual(1024);
      expect(JSON.parse(input.messages[0]!.content[0]!.text)).toMatchObject([{ utterance: 0, speaker: 'Fixture speaker', text: quote, locator: 'utterance:0:text:0:29' }]);
      return { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 30 }, output: { message: { role: 'assistant', content: [{ text: JSON.stringify([{ kind: 'need', interpretation: 'Repair coordinator', status: 'stated', locator: 'utterance:0:text:0:29', quote }]) }] } } };
    } }, extraction: { endpointId: 'controlled-extraction', modelVersion: 'literal-v1', accessGrantVersion: 'extraction-only-grant', dataHandlingVersion: 'fixture-no-retention', providerKey: 'fixture.crm_extraction', fundingVerifiedUntil: '2099-01-01T00:00:00Z' } });
    const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, ...composition });
    await runOnce(selected.fixture.db, { registry, owner: 'controlled-bedrock-native-extraction', limit: 20 });
    expect((await selected.post('/crm/processing/read', { source })).body).toMatchObject({ state: 'complete', claims: [{ kind: 'need', quote, source: { sourceId: transcriptId, kind: 'meeting_transcript', speaker: 'Fixture speaker', locator: 'utterance:0:text:0:29' } }] });
  } finally { await selected.fixture.stop(); }
});
