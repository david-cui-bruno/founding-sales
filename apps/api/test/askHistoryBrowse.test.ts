import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { selectedImportPageSchema } from '@fss/contracts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import type { AskAgentStepAdapter } from '@fss/domain/crm/askAnswerPorts.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';

const requestReceipt = z.object({ result: z.object({ requestId: z.uuid() }) });
const previewReceipt = z.object({ previewHash: z.string() });
const browseResult = z.object({
  windows: z.array(z.object({ id: z.uuid(), text: z.string(), source: z.object({ sourceId: z.uuid() }), evidenceAuthority: z.union([z.object({kind:z.literal('selected_unverified_text'),inlineMetadata:z.literal('untrusted_source_content'),occurredAt:z.literal('supplied_or_parsed_event_date'),observedAt:z.literal('copy_observation_time')}),z.object({kind:z.literal('retained_mail_copy'),inlineMetadata:z.literal('untrusted_source_content'),occurredAt:z.literal('retained_message_event_date'),observedAt:z.literal('copy_observation_time')}),z.object({kind:z.literal('retained_transcript'),speakerLabels:z.literal('not_verified_human_identity'),occurredAt:z.literal('record_event_date'),observedAt:z.literal('copy_observation_time')})]) })),
  partial: z.boolean(),
  retrieval: z.literal('bounded_catalog'),
  semantic: z.literal('unavailable'),
  scannedCandidates: z.number().int(),
  nextAfter: z.object({ kind: z.enum(['selected_note', 'mail', 'call_transcript', 'meeting_transcript']), sourceId: z.uuid() }).nullable(),
});
function latestBrowse(transcript: readonly unknown[]) {
  const entry = transcript.map(item => z.object({ name: z.string(), result: z.unknown() }).safeParse(item))
    .filter(item => item.success && item.data.name === 'browse_history').at(-1);
  if (!entry?.success) throw new Error('browse_result_missing');
  return browseResult.parse(entry.data.result);
}
async function fixtureForBrowse() {
  const fixture = await createAuthFixture();
  const token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  const post = (path: string, body: unknown) => dispatch({ method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` } }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false });
  const command = (fields: object) => ({ commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...fields });
  const firmId = await seedFirm(fixture, { name: 'Browse firm', assignedUserId: fixture.alpha.salesperson.userId });
  async function add(text: string, occurredAt = '2026-10-01T14:00:00Z', target = firmId) {
    const selection = { text, subtype: 'pasted_text', label: 'Browse original', direction: 'unknown', participants: [], occurredAt, attachments: [] };
    const preview = await post('/crm/imports/preview', selection); expect(preview.status).toBe(200);
    const committed = await post('/crm/imports/commit', command({ ...selection, personId: null, firmId: target, importKey: randomUUID(), previewHash: previewReceipt.parse(preview.body).previewHash, parserVersion: 'selected-v1' })); expect(committed.status).toBe(200);
    const id = z.object({ result: z.object({ sourceId: z.uuid() }) }).parse(committed.body).result.sourceId;
    const page = selectedImportPageSchema.parse((await post('/crm/imports/read', { firmId: target, limit: 100 })).body);
    return page.imports.find(item => item.source.sourceId === id)!.source;
  }
  await fixture.db.query(`INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',1000,10000,1,1,$3)`, [fixture.alpha.workspaceId, 'a'.repeat(64), fixture.alpha.admin.userId]);
  async function run(agent: AskAgentStepAdapter, agentScope: object, maxSteps = 3) {
    const requested = await post('/ask/answers/request', command({ question: 'What maintenance coordination need is supported?', execution: 'agent_v1', agentScope, scope: { sources: [] } })); expect(requested.status).toBe(200);
    const requestId = requestReceipt.parse(requested.body).result.requestId;
    let adapterFailure: unknown;
    const checkedAgent: AskAgentStepAdapter = { ...agent, async runStep(input) { try { return await agent.runStep(input); } catch (error) { adapterFailure = error; throw error; } } };
    const registry = registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, crmAskAnswers: { agent: checkedAgent, agentLimits: { maxSteps, maxInputBytes: 100000, maxOutputTokens: 1000, deadlineMs: 60000 }, allowControlledEvaluation: true, verifyPurpose: async proof => ({ configFingerprint: proof.configFingerprint, authorizationFingerprint: proof.authorizationFingerprint, validUntil: '2099-01-01T00:00:00Z', evaluationKind: 'controlled_fixture' }) } });
    const worker = await fixture.database.appRuntimeSession();
    await runOnce(worker, { registry, owner: 'browse-controlled-worker', limit: 100 });
    if (adapterFailure !== undefined) throw adapterFailure;
    return post('/ask/answers/read', { requestId });
  }
  return { fixture, post, command, firmId, add, run };
}
const route = { endpointId: 'controlled-answer', modelVersion: 'literal-v1', providerKey: 'fixture.ask.answer' };
const usage = { inputTokens: 20, outputTokens: 10 };
it('browses unseen firm originals then reads conversation and answers within three model steps', async () => {
  const f = await fixtureForBrowse(); try {
    const text = 'Coordinating repair contractors across our rentals is taking too much time.';
    const source = await f.add(text); let calls = 0;
    const result = await f.run({ ...route, async runStep(input) {
      calls++;
      if (calls === 1) { expect(JSON.stringify(input.transcript)).not.toContain(text); return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'browse', name: 'browse_history', input: { limit: 5 } }] }; }
      const browse = latestBrowse(input.transcript); expect(browse).toMatchObject({ partial: false, scannedCandidates: 1, nextAfter: null }); expect(browse.windows).toEqual([expect.objectContaining({ text, source: expect.objectContaining({ sourceId: source.sourceId }) })]);
      if (calls === 2) return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'conversation', name: 'read_conversation', input: { sourceId: source.sourceId, kind: 'selected_note', limit: 3 } }] };
      return { acceptance: 'accepted', usage, answer: { claims: [{ text, kind: 'fact', citationWindowIds: [browse.windows[0]!.id] }], abstained: false }, toolCalls: [] };
    } }, { kind: 'firm', firmId: f.firmId });
    expect(result.body).toMatchObject({ state: 'complete', answer: { claims: [{ text }] } }); expect(calls).toBe(3);
  } finally { await f.fixture.stop(); }
});
it('continues from the returned source without skipping prefetched copies, including selected scope', async () => {
  const f = await fixtureForBrowse(); try {
    const sources = [];
    for (const text of ['First retained original.', 'Second retained original.', 'Third retained original.']) sources.push(await f.add(text));
    const expected = sources.map(source => source.sourceId).sort();
    for (const scope of [{ kind: 'firm', firmId: f.firmId }, { kind: 'selected', sources: [...sources].reverse().map(source => ({ workspaceId: source.workspaceId, sourceId: source.sourceId, kind: 'selected_note', revision: source.revision, contentHash: source.contentHash, locator: null })) }]) {
      const seen: string[] = []; let calls = 0;
      const result = await f.run({ ...route, async runStep(input) {
        calls++;
        if (calls > 1) {
          const browse = latestBrowse(input.transcript); expect(browse.windows).toHaveLength(1); seen.push(browse.windows[0]!.source.sourceId);
          if (seen.length === 3) { expect(browse).toMatchObject({ partial: false, nextAfter: null }); return { acceptance: 'accepted', usage, answer: { claims: [], abstained: true }, toolCalls: [] }; }
          expect(browse.partial).toBe(true); expect(browse.nextAfter).toEqual({ kind: 'selected_note', sourceId: seen.at(-1) });
          return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: `page-${calls}`, name: 'browse_history', input: { limit: 1, after: browse.nextAfter } }] };
        }
        return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'page-1', name: 'browse_history', input: { limit: 1 } }] };
      } }, scope, 4);
      expect(result.body).toMatchObject({ state: 'complete' }); expect(seen).toEqual(expected); expect(calls).toBe(4);
    }
  } finally { await f.fixture.stop(); }
});
it('keeps immutable firm/date scope and omits deleted copies from browse', async () => {
  const f = await fixtureForBrowse(); try {
    const kept = await f.add('Allowed dated original.');
    const erased = await f.add('Deleted private original.');
    await f.add('Outside date original.', '2026-09-01T14:00:00Z');
    const otherFirm = await seedFirm(f.fixture, { name: 'Other browse firm', assignedUserId: f.fixture.alpha.salesperson.userId });
    await f.add('Other firm original.', '2026-10-01T14:00:00Z', otherFirm);
    expect((await f.post('/crm/imports/delete', f.command({ sourceId: erased.sourceId, expectedSourceRevision: 1, expectedMetadataRevision: 1 }))).status).toBe(200);
    let calls = 0;
    const result = await f.run({ ...route, async runStep(input) {
      calls++;
      if (calls === 1) return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'scoped', name: 'browse_history', input: { limit: 5 } }] };
      const browse = latestBrowse(input.transcript); expect(browse.windows.map(window => window.source.sourceId)).toEqual([kept.sourceId]); expect(JSON.stringify(browse)).not.toContain('Deleted private original'); expect(JSON.stringify(browse)).not.toContain('Outside date original'); expect(JSON.stringify(browse)).not.toContain('Other firm original'); expect(browse).toMatchObject({ partial: false, nextAfter: null });
      return { acceptance: 'accepted', usage, answer: { claims: [], abstained: true }, toolCalls: [] };
    } }, { kind: 'firm', firmId: f.firmId, from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' });
    expect(result.body).toMatchObject({ state: 'complete' }); expect(calls).toBe(2);
  } finally { await f.fixture.stop(); }
});
it('refuses malformed cursors and model-supplied scope changes without copying a source', async () => {
  const f = await fixtureForBrowse(); try {
    await f.add('Scope protected original.');
    for (const input of [{ limit: 5, after: { kind: 'selected_note', sourceId: 'not-a-uuid' } }, { limit: 6 }, { limit: 5, firmId: randomUUID() }]) {
      let calls = 0;
      const result = await f.run({ ...route, async runStep() { calls++; return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'invalid', name: 'browse_history', input }] }; } }, { kind: 'firm', firmId: f.firmId });
      expect(result.body).toMatchObject({ state: 'unavailable', reason: 'unsupported_answer', answer: null }); expect(calls).toBe(1);
    }
  } finally { await f.fixture.stop(); }
});

it('deletion during a model wait blocks publication of a previously browsed original', async () => {
  const f = await fixtureForBrowse(); try {
    const source = await f.add('Private original erased during a model wait.'); let calls = 0;
    const result = await f.run({ ...route, async runStep(input) {
      calls++;
      if (calls === 1) return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'admit', name: 'browse_history', input: { limit: 5 } }] };
      const browse = latestBrowse(input.transcript); expect(browse.windows[0]!.source.sourceId).toBe(source.sourceId);
      expect((await f.post('/crm/imports/delete', f.command({ sourceId: source.sourceId, expectedSourceRevision: 1, expectedMetadataRevision: 1 }))).status).toBe(200);
      return { acceptance: 'accepted', usage, answer: { claims: [{ text: 'Private original erased during a model wait.', kind: 'fact', citationWindowIds: [browse.windows[0]!.id] }], abstained: false }, toolCalls: [] };
    } }, { kind: 'firm', firmId: f.firmId });
    expect(result.body).toMatchObject({ state: 'stale', question: null, answer: null, fallback: null }); expect(calls).toBe(2);
  } finally { await f.fixture.stop(); }
});
it('shows one preview from each source even when the first native copy has more than twenty windows', async () => {
  const f = await fixtureForBrowse(); try {
    const selected = await f.add('Second source must remain discoverable.');
    const meetingId = randomUUID(), recordingId = randomUUID(), sourceId = randomUUID();
    await f.fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$2::uuid::text,$2::uuid::text,'booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())", [f.fixture.alpha.workspaceId, meetingId, f.firmId]);
    await f.fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status,crm_capture_owner_user_id) VALUES($1,$2,$3,1,'Controlled native copy',$4,100,$5,'ready',$6)", [f.fixture.alpha.workspaceId, recordingId, meetingId, 'b'.repeat(64), `meetings/${meetingId}/${'b'.repeat(64)}.m4a`, f.fixture.alpha.salesperson.userId]);
    const utterances = Array.from({ length: 25 }, (_, index) => ({ startMs: index * 1000, endMs: (index + 1) * 1000, text: `Original utterance ${index}.`, speaker: 'Speaker 1', attribution: 'unknown' }));
    await f.fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,25000,'en-US',$4::jsonb)", [f.fixture.alpha.workspaceId, sourceId, recordingId, JSON.stringify(utterances)]);
    let calls = 0;
    const result = await f.run({ ...route, async runStep(input) {
      calls++;
      if (calls === 1) return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'wide-native', name: 'browse_history', input: { limit: 5 } }] };
      const browse = latestBrowse(input.transcript); expect(browse.windows).toHaveLength(2); expect(browse.windows.map(window => window.source.sourceId)).toEqual([sourceId, selected.sourceId]); expect(browse.windows[0]!.text).toBe('Original utterance 0.'); expect(browse.windows[1]!.text).toBe('Second source must remain discoverable.');
      return { acceptance: 'accepted', usage, answer: { claims: [], abstained: true }, toolCalls: [] };
    } }, { kind: 'firm', firmId: f.firmId });
    expect(result.body).toMatchObject({ state: 'complete' }); expect(calls).toBe(2);
  } finally { await f.fixture.stop(); }
});
it('continues only after the source actually admitted when the request source ceiling truncates a browse page', async () => {
  const f = await fixtureForBrowse(); try {
    const sources = [];
    for (let index = 0; index < 14; index++) sources.push(await f.add(`Bounded original ${index}.`));
    const expected = sources.map(source => source.sourceId).sort(); let calls = 0;
    const result = await f.run({ ...route, async runStep(input) {
      calls++;
      if (calls === 1) return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'five', name: 'browse_history', input: { limit: 5 } }] };
      const browse = latestBrowse(input.transcript);
      if (calls === 2) { expect(browse.windows.map(window => window.source.sourceId)).toEqual(expected.slice(0, 5)); return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'four', name: 'browse_history', input: { limit: 4, after: browse.nextAfter } }] }; }
      if (calls === 3) { expect(browse.windows.map(window => window.source.sourceId)).toEqual(expected.slice(5, 9)); return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'only-one-room', name: 'browse_history', input: { limit: 5, after: browse.nextAfter } }] }; }
      expect(browse.windows.map(window => window.source.sourceId)).toEqual([expected[9]]); expect(browse).toMatchObject({ partial: true, nextAfter: { kind: 'selected_note', sourceId: expected[9] } });
      const last = input.transcript.map(item => z.object({ name: z.string(), result: z.unknown() }).safeParse(item)).filter(item => item.success && item.data.name === 'browse_history').at(-1); if (!last?.success) throw new Error('browse_result_missing'); expect(last.data.result).toMatchObject({ sourceCeilingReached: true });
      return { acceptance: 'accepted', usage, answer: { claims: [], abstained: true }, toolCalls: [] };
    } }, { kind: 'firm', firmId: f.firmId }, 4);
    expect(result.body).toMatchObject({ state: 'complete' }); expect(calls).toBe(4);
  } finally { await f.fixture.stop(); }
});
it('business browse does not expose another owner’s firm original', async () => {
  const f = await fixtureForBrowse(); try {
    const visible = await f.add('Owner-visible original.');
    const otherFirm = await seedFirm(f.fixture, { name: 'Private admin firm', assignedUserId: f.fixture.alpha.admin.userId });
    const adminToken = (await issueSessionFor(f.fixture, f.fixture.alpha, f.fixture.alpha.admin)).accessToken;
    const adminPost = (path: string, body: unknown) => dispatch({ method: 'POST', path, body, query: new URLSearchParams(), headers: { authorization: `Bearer ${adminToken}` } }, { session: f.fixture.db, auth: f.fixture.deps, supportedClientVersions: f.fixture.deps.config.supportedClientVersions, sendingEnabled: false });
    const selection = { text: 'Another owner’s private copied original.', subtype: 'pasted_text', label: 'Private copied source', direction: 'unknown', participants: [], occurredAt: '2026-10-01T14:00:00Z', attachments: [] };
    const preview = await adminPost('/crm/imports/preview', selection); expect(preview.status).toBe(200);
    expect((await adminPost('/crm/imports/commit', f.command({ ...selection, personId: null, firmId: otherFirm, importKey: randomUUID(), previewHash: previewReceipt.parse(preview.body).previewHash, parserVersion: 'selected-v1' }))).status).toBe(200);
    let calls = 0;
    const result = await f.run({ ...route, async runStep(input) {
      calls++;
      if (calls === 1) return { acceptance: 'accepted', usage, answer: null, toolCalls: [{ id: 'business', name: 'browse_history', input: { limit: 5 } }] };
      const browse = latestBrowse(input.transcript); expect(browse.windows.map(window => window.source.sourceId)).toEqual([visible.sourceId]); expect(JSON.stringify(browse)).not.toContain('Another owner'); expect(browse).toMatchObject({ partial: false, nextAfter: null });
      return { acceptance: 'accepted', usage, answer: { claims: [], abstained: true }, toolCalls: [] };
    } }, { kind: 'business' });
    expect(result.body).toMatchObject({ state: 'complete' }); expect(calls).toBe(2);
  } finally { await f.fixture.stop(); }
});
