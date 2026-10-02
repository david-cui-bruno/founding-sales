import { retryCallAnalysisCommandSchema, retryCallAnalysisResultSchema } from '@fss/contracts';
import { describe, expect, it } from 'vitest';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import { keyReasonsOf, operationHandlers, type OperationHostDeps } from '../src/main/operationHost.ts';
import { OPERATIONS } from '../src/shared/operations.ts';
import { evidencePhrase } from '../src/renderer/pipeline/cardText.ts';
import { HOLD_ITEM, PROPOSALS, STAGE_ITEM, analysisAnswer, proposalItem, reviewAnswer, ANALYSIS_ID, FIRM_ID, HASH, SESSION_ID, SHA } from './support/analysisAnswers.ts';

/**
 * Slice 3a, lane C: the contract check. One recorded `GET /calls/analysis` and one recorded
 * `GET /review` are parsed through the registry's own operations, and the commands send
 * exactly what the API's contract takes — nothing wider.
 */

function scripted(answers: Readonly<Record<string, HttpAnswer>>) {
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.28',
    accessToken: async () => await Promise.resolve({ token: 'token-value', generation: 0 }),
    send: async (url, init) => {
      const at = new URL(url);
      calls.push({ method: init.method, path: `${at.pathname}${at.search}`, body: init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>) });
      return await Promise.resolve(answers[at.pathname] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  const handlers = operationHandlers({ api } as unknown as OperationHostDeps);
  return { handlers, calls };
}

const ok = (body: unknown): HttpAnswer => ({ status: 200, body });
const accepted = (result: unknown): HttpAnswer => ({ status: 200, body: { status: 'accepted', replayed: false, result } });
const refused = (reason: string, extra: Record<string, unknown> = {}): HttpAnswer => ({ status: 409, body: { status: 'refused', replayed: false, reason, ...extra } });

describe('the recorded reads', () => {
  it('parses one GET /calls/analysis', async () => {
    const { handlers, calls } = scripted({ '/calls/analysis': ok(JSON.parse(JSON.stringify(analysisAnswer()))) });
    const view = (await handlers['calling.analysis']({ callSessionId: SESSION_ID } as never)) as { analysis: { authoritative: { proposalHash: string } } | null };
    expect(view.analysis?.authoritative?.proposalHash).toBe(HASH);
    expect(calls).toEqual([{ method: 'GET', path: `/calls/analysis?callSessionId=${SESSION_ID}`, body: null }]);
    expect(OPERATIONS['calling.analysis'].output.safeParse(view).success).toBe(true);
  });

  it('parses one GET /review, all three sources', async () => {
    const recorded = JSON.parse(JSON.stringify(reviewAnswer([HOLD_ITEM, proposalItem(PROPOSALS.correctedNumber), STAGE_ITEM])));
    const { handlers } = scripted({ '/review': ok(recorded) });
    const view = (await handlers['review.list'](undefined as never)) as { items: { source: string }[] | null };
    expect(view.items?.map(item => item.source)).toEqual(['pending_hold', 'proposal', 'stage']);
    expect(OPERATIONS['review.list'].output.safeParse(view).success).toBe(true);
  });

  it('a read an API does not serve (404) is null, never a thrown error: the block hides', async () => {
    const { handlers } = scripted({});
    expect(await handlers['calling.analysis']({ callSessionId: SESSION_ID } as never)).toEqual({ analysis: null, reason: 'not_found' });
    expect(await handlers['review.list'](undefined as never)).toEqual({ items: null, failed: false });
    expect(await handlers['calling.recap'](undefined as never)).toEqual({ recap: null });
    expect(await handlers['calling.acceptance'](undefined as never)).toEqual({ acceptance: null });
  });
});

describe('a failed review read is not a read the API does not serve', () => {
  it('a 500 and an unreadable answer are `failed`; only a 404 is quietly absent', async () => {
    const server = scripted({ '/review': { status: 500, body: { error: 'internal' } } });
    expect(await server.handlers['review.list'](undefined as never)).toEqual({ items: null, failed: true });
    const garbled = scripted({ '/review': ok({ nonsense: true }) });
    expect(await garbled.handlers['review.list'](undefined as never)).toEqual({ items: null, failed: true });
    expect(OPERATIONS['review.list'].output.safeParse({ items: null, failed: true }).success).toBe(true);
  });
});

describe('the commands send what the contract takes', () => {
  it('apply: the keys, the three identifiers and the edits, with the command id the page chose', async () => {
    const commandId = '14141414-1414-4141-8141-141414141414';
    const { handlers, calls } = scripted({
      '/calls/proposals/apply': accepted({ analysisId: ANALYSIS_ID, callSessionId: SESSION_ID, callLogId: null, results: [], followUps: [] }),
    });
    await handlers['calling.proposalsApply']({ analysisId: ANALYSIS_ID, transcriptSha256: SHA, proposalHash: HASH, keys: ['outcome'], commandId } as never);
    expect(calls[0]?.body).toMatchObject({ analysisId: ANALYSIS_ID, transcriptSha256: SHA, proposalHash: HASH, keys: ['outcome'], commandId });
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['analysisId', 'clientVersion', 'commandId', 'keys', 'proposalHash', 'transcriptSha256']);
  });

  it('apply is atomic: a refusal carries the batch code and each refused key’s own code', async () => {
    const { handlers } = scripted({
      '/calls/proposals/apply': refused('callback_exists', { keyReasons: { callback: 'callback_exists' } }),
    });
    const view = (await handlers['calling.proposalsApply']({ analysisId: ANALYSIS_ID, transcriptSha256: SHA, proposalHash: HASH, keys: ['outcome', 'callback'] } as never)) as {
      applied: unknown;
      reason: string;
      keyReasons: Record<string, string>;
    };
    expect(view).toEqual({ applied: null, reason: 'callback_exists', keyReasons: { callback: 'callback_exists' } });
  });

  it('reads the 409’s keyReasons exactly and never invents one', () => {
    expect(keyReasonsOf({ keyReasons: { callback: 'callback_exists', follow_up: 'follow_up_not_granted' } })).toEqual({ callback: 'callback_exists', follow_up: 'follow_up_not_granted' });
    // The old tolerant shapes are gone.
    expect(keyReasonsOf({ keys: [{ key: 'follow_up', reason: 'follow_up_expired' }] })).toEqual({});
    expect(keyReasonsOf({ keyReasons: [{ key: 'callback', reason: 'x', detail: null }] })).toEqual({});
    expect(keyReasonsOf('nonsense')).toEqual({});
    expect(keyReasonsOf(null)).toEqual({});
  });

  it('the firm stop sends the firm scope, the firm and the prospect source, and nothing else', async () => {
    const { handlers, calls } = scripted({ '/suppressions/record': accepted({}) });
    expect(await handlers['suppressions.firmStop']({ firmId: FIRM_ID } as never)).toEqual({ stopped: true, reason: null });
    const body = calls[0]?.body ?? {};
    expect(body).toMatchObject({ scope: 'firm', firmId: FIRM_ID, source: 'prospect_do_not_call' });
    expect(Object.keys(body).sort()).toEqual(['clientVersion', 'commandId', 'firmId', 'scope', 'source']);
    expect(OPERATIONS['suppressions.firmStop'].input.safeParse({ firmId: FIRM_ID, scope: 'number' }).success).toBe(false);
  });

  it('retry is written against A2’s contract: callSessionId and a reason of retry or reanalysis', async () => {
    const { handlers, calls } = scripted({
      '/calls/analysis/retry': accepted({ callSessionId: SESSION_ID, queued: true }),
      '/calls/analysis': ok(JSON.parse(JSON.stringify(analysisAnswer({ state: 'pending' })))),
    });
    const view = (await handlers['calling.analysisRetry']({ callSessionId: SESSION_ID, reason: 'retry' } as never)) as { analysis: { pending: unknown } | null };
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/calls/analysis/retry' });
    expect(calls[0]?.body).toMatchObject({ callSessionId: SESSION_ID, reason: 'retry' });
    // The real route's own request and result schemas (apps/api/src/routes/callAnalysis.ts).
    expect(retryCallAnalysisCommandSchema.safeParse(calls[0]?.body).success).toBe(true);
    expect(retryCallAnalysisResultSchema.safeParse({ callSessionId: SESSION_ID, queued: true }).success).toBe(true);
    expect(view.analysis?.pending).not.toBeNull();
    expect(OPERATIONS['calling.analysisRetry'].input.safeParse({ callSessionId: SESSION_ID, reason: 'other' }).success).toBe(false);
  });

  it('retry’s refusals come back as its codes', async () => {
    const { handlers } = scripted({ '/calls/analysis/retry': refused('analysis_in_flight') });
    expect(await handlers['calling.analysisRetry']({ callSessionId: SESSION_ID, reason: 'retry' } as never)).toEqual({ analysis: null, reason: 'analysis_in_flight' });
  });
});

describe('the Pipeline wording', () => {
  it('says "buying signal on a call on <day>" for call.interested', () => {
    expect(evidencePhrase('call.interested', '2026-10-03T15:00:00.000Z')).toBe('buying signal on a call on Oct 3');
  });
});
