import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { selectedImportPageSchema, askAnswerReadResultSchema } from '@fss/contracts';
import { MockLanguageModelV3 } from '../../worker/test/support/controlledAskSdkModel.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { createAuthFixture } from './support/authFixture.ts';
import { configuredAskFixture } from './support/configuredAskFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

it.each(['quote', 'source_interpretation', 'mixed_interpretation', 'missing_exact', 'unseen_quote', 'unknown_window'] as const)('constructs source evidence safely for %s and erases it on deletion', async mode => {
  const fixture = await createAuthFixture();
  try {
    const route = { region: 'us-east-1' as const, endpointId: 'bedrock-runtime.us-east-1.amazonaws.com' as const, modelVersion: 'us.anthropic.claude-sonnet-4-6' as const, providerKey: 'controlled.ask_sdk', accessGrantVersion: 'controlled-access', dataHandlingVersion: 'controlled-handling', fundingVerifiedUntil: '2099-01-01T00:00:00Z', agentLimits: { maxSteps: 4, maxInputBytes: 50000, maxOutputTokens: 1000, deadlineMs: 60000 } };
    const { db, post, command, saveDisabledPurpose, composeWorker } = await configuredAskFixture(fixture, route);
    const firmId = await seedFirm(fixture, { name: 'Anonymous offer firm', assignedUserId: fixture.alpha.admin.userId });
    const text = 'I could show a demo once the samples arrive.';
    const selection = { text, subtype: 'pasted_text', label: 'Conditional offer', direction: 'unknown', participants: [], occurredAt: null, attachments: [] };
    const preview = await post('/crm/imports/preview', selection);
    expect((await post('/crm/imports/commit', command({ ...selection, personId: null, firmId, importKey: randomUUID(), previewHash: (preview.body as { previewHash: string }).previewHash, parserVersion: 'selected-v1' }))).status).toBe(200);
    const imported = selectedImportPageSchema.parse((await post('/crm/imports/read', { firmId, limit: 10 })).body).imports[0]!;
    expect((await saveDisabledPurpose('c'.repeat(64))).status).toBe(200);
    expect((await post('/ask/purpose/activate', command({ capability: 'ask_answer', purpose: 'answer', expectedRevision: 1, approval: { consentAcknowledged: true, qualityTier: 'provisional_owner', criticalControlsPassed: true, modelIntegrationVerified: true, reviewedEvaluationReference: 'controlled-construction-not-provider-proof', limitations: ['representative_quality_unverified'] } }))).status).toBe(200);
    let step = 0;
    const interpretation = mode === 'mixed_interpretation' || mode === 'missing_exact' ? 'The note tentatively offers a demo, while CRM records no opportunities; its initiative is unidentified.' : 'The note tentatively offers a demo; its initiative is unidentified.';
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      step++;
      const mixed = mode === 'mixed_interpretation' || mode === 'missing_exact';
      const read = mixed && step === 1;
      const construction = mode === 'source_interpretation' || mixed
        ? { mode: 'interpretation', premises: mixed ? 'mixed' : 'source' }
        : { mode: 'source_quote', windowId: mode === 'unknown_window' ? 'missing' : 'w1', quote: mode === 'unseen_quote' ? 'We promise a demo tomorrow.' : text };
      return { content: [read
        ? { type: 'tool-call' as const, toolCallId: 'current-opportunities', toolName: 'read_exact', input: JSON.stringify({ operation: 'opportunities', firmId }) }
        : { type: 'tool-call' as const, toolCallId: 'final', toolName: 'emit_answer', input: JSON.stringify({ claims: [{ text: construction.mode === 'interpretation' ? interpretation : 'The team promised a demo.', kind: 'fact', citationWindowIds: ['w1'], exactResultToolCallIds: mode === 'mixed_interpretation' ? ['e1'] : [], construction }], abstained: false }) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' }, usage: { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] };
    } });
    const registry = await composeWorker(model);
    const request = await post('/ask/answers/request', command({ question: 'What was offered?', execution: 'agent_v1', scope: { sources: [{workspaceId: imported.source.workspaceId, sourceId: imported.source.sourceId, kind: imported.source.kind, revision: imported.source.revision, contentHash: imported.source.contentHash, locator: null}] } }));
    expect(request.status, JSON.stringify(request.body)).toBe(200);
    const requestId = (request.body as { result: { requestId: string } }).result.requestId;
    expect((await runOnce(db, { registry, owner: 'constructed-quote', limit: 20 })).failed).toBe(0);
    const answer = askAnswerReadResultSchema.parse((await post('/ask/answers/read', { requestId, includeExactResultCitations: true })).body);
    if (['missing_exact', 'unseen_quote', 'unknown_window'].includes(mode)) {
      expect(answer).toMatchObject({ state: 'unavailable', reason: 'unsupported_answer', answer: null });
      return;
    }
    expect(answer).toMatchObject({ state: 'complete', answer: { claims: [{ text: mode === 'quote' ? 'The note records an unidentified speaker: "I could show a demo once the samples arrive."' : interpretation, kind: mode === 'quote' ? 'fact' : 'inference', verification: 'cited_unverified', exactResultToolCallIds: mode === 'mixed_interpretation' ? ['current-opportunities'] : [] }] } });
    const citation = answer.answer!.claims[0]!.citationWindowIds[0]!;
    expect((await post('/ask/answers/source/read', { requestId, expectedVersion: 1, windowId: citation })).body).toMatchObject({ source: { passage: { text } } });
    expect((await post('/crm/imports/delete', command({ sourceId: imported.source.sourceId, expectedSourceRevision: 1, expectedMetadataRevision: 1 }))).status).toBe(200);
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'deleted', question: null, answer: null, fallback: null });
  } finally { await fixture.stop(); }
});

it.each(['count', 'record', 'unknown_record', 'unknown_exact', 'changed'] as const)('constructs source-free exact opportunity %s instead of model-invented state', async mode => {
  const fixture = await createAuthFixture();
  try {
    const route = { region: 'us-east-1' as const, endpointId: 'bedrock-runtime.us-east-1.amazonaws.com' as const, modelVersion: 'us.anthropic.claude-sonnet-4-6' as const, providerKey: 'controlled.ask_sdk', accessGrantVersion: 'controlled-access', dataHandlingVersion: 'controlled-handling', fundingVerifiedUntil: '2099-01-01T00:00:00Z', agentLimits: { maxSteps: 4, maxInputBytes: 50000, maxOutputTokens: 1000, deadlineMs: 60000 } };
    const { db, post, command, saveDisabledPurpose, composeWorker } = await configuredAskFixture(fixture, route);
    const firmId = await seedFirm(fixture, { name: 'Exact construction firm', assignedUserId: fixture.alpha.admin.userId });
    expect((await post('/pipeline/stages/create', command({ key: 'contacting', displayName: 'Contacting' }))).status).toBe(200);
    let opportunityId: string | undefined;
    if (mode !== 'count') {
      const opened = await post('/opportunities/v2/open', command({ firmId, name: 'East pilot' }));
      expect(opened.status).toBe(200);
      opportunityId = (opened.body as { result: { opportunityId: string } }).result.opportunityId;
    }
    expect((await saveDisabledPurpose('d'.repeat(64))).status).toBe(200);
    expect((await post('/ask/purpose/activate', command({ capability: 'ask_answer', purpose: 'answer', expectedRevision: 1, approval: { consentAcknowledged: true, qualityTier: 'provisional_owner', criticalControlsPassed: true, modelIntegrationVerified: true, reviewedEvaluationReference: 'controlled-construction-not-provider-proof', limitations: ['representative_quality_unverified'] } }))).status).toBe(200);
    let step = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      step++;
      if (mode === 'changed' && step === 2) expect((await post('/opportunities/stage', command({ opportunityId, toStageKey: 'contacting', expectedStageKey: 'new' }))).status).toBe(200);
      return { content: [step === 1
      ? { type: 'tool-call', toolCallId: 'current-opportunities', toolName: 'read_exact', input: JSON.stringify({ operation: 'opportunities', firmId }) }
      : { type: 'tool-call', toolCallId: 'final', toolName: 'emit_answer', input: JSON.stringify({ claims: [{ text: 'There are 300 qualified pilots.', kind: 'fact', citationWindowIds: [], exactResultToolCallIds: ['e1'], construction: mode === 'count' ? { mode: 'exact_count', toolCallId: 'e1' } : { mode: 'opportunity_record', toolCallId: mode === 'unknown_exact' ? 'missing' : 'e1', opportunityId: mode === 'unknown_record' ? randomUUID() : opportunityId } }], abstained: false }) }], finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } }, warnings: [] }; } });
    const registry = await composeWorker(model);
    const request = await post('/ask/answers/request', command({ question: 'How many opportunities are recorded?', execution: 'agent_v1', agentScope: { kind: 'firm', firmId }, scope: { sources: [] } }));
    expect(request.status, JSON.stringify(request.body)).toBe(200);
    const requestId = (request.body as { result: { requestId: string } }).result.requestId;
    expect((await runOnce(db, { registry, owner: 'constructed-exact', limit: 20 })).failed).toBe(0);
    if (['unknown_record', 'unknown_exact', 'changed'].includes(mode)) {
      expect((await post('/ask/answers/read', { requestId, includeExactResultCitations: true })).body).toMatchObject({ state: mode === 'changed' ? 'stale' : 'unavailable', reason: mode === 'changed' ? 'source_changed' : 'unsupported_answer', answer: null });
      return;
    }
    expect((await post('/ask/answers/read', { requestId, includeExactResultCitations: true })).body).toMatchObject({ state: 'complete', answer: { claims: [{ text: mode === 'count' ? 'CRM records 0 opportunities in this query scope.' : 'CRM currently records opportunity "East pilot" with stage "new" and status "open".', kind: 'fact', citationWindowIds: [], exactResultToolCallIds: ['current-opportunities'], verification: 'cited_unverified' }] } });
    expect((await post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'unavailable', answer: null });
  } finally { await fixture.stop(); }
});
