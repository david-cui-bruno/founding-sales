import { describe, expect, it, vi } from 'vitest';
import { createLinkedInDraftProvider } from '../../src/main/linkedin/linkedInDraftProvider';
import { LinkedInService } from '../../src/main/linkedin/linkedInService';
import { createLinkedInFixture } from '../fixtures/linkedInWorkspace';
const credentials = { model: { apiKey: 'fictional-key', model: 'fictional-model' } };
const productFacts = { approvalId: 'fictional-approval', facts: [{ id: 'product:one', text: 'Fictional approved product fact.' }] };
const response = (evidenceIds: string[] = ['product:one']) => new Response(JSON.stringify({ id: 'fixture_response', status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ body: 'Fictional prepared message', evidenceIds }) }] }] }));
describe('configured LinkedIn draft provider', () => {
  it('generates through actual HTTP parser with pinned B1 evidence, preserves human edits on repeated prepare', async () => {
    const f = await createLinkedInFixture();
    try {
      let request: RequestInit | undefined;
      const http = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { request = init; return response(); });
      const provider = createLinkedInDraftProvider({ credentials: { load: async () => credentials }, fetch: http });
      const service = new LinkedInService({ repository: f.drafts, provider, productFacts });
      const draft = await service.prepare({ stepId: f.version.steps[0]!.id, expectedVersion: 1 });
      expect(draft.body).toBe('Fictional prepared message');
      const payload = JSON.parse(String(request?.body));
      expect(payload.instructions).toContain('LinkedIn'); expect(payload.instructions).toContain('Never infer authority');
      expect(payload.input).toContain('Fictional Person'); expect(payload.input).toContain('product:one');
      expect(request?.redirect).toBe('error'); expect(payload.store).toBe(false);
      await service.save({ draftId: draft.id, expectedRevision: 1, body: 'Human edit' });
      expect((await service.prepare({ stepId: f.version.steps[0]!.id, expectedVersion: 1 })).body).toBe('Human edit');
      expect(http).toHaveBeenCalledTimes(1);
    } finally { f.close(); }
  });
  it('rejects unconfigured credentials and fabricated evidence before persistence', async () => {
    const f = await createLinkedInFixture();
    try {
      const http = vi.fn(async () => response(['invented-source']));
      const missing = createLinkedInDraftProvider({ credentials: { load: async () => null }, fetch: http });
      await expect(new LinkedInService({ repository: f.drafts, provider: missing, productFacts }).prepare({ stepId: f.version.steps[0]!.id, expectedVersion: 1 })).rejects.toThrow();
      expect(http).not.toHaveBeenCalled();
      const provider = createLinkedInDraftProvider({ credentials: { load: async () => credentials }, fetch: http });
      await expect(new LinkedInService({ repository: f.drafts, provider, productFacts }).prepare({ stepId: f.version.steps[0]!.id, expectedVersion: 1 })).rejects.toThrow();
      expect(f.db.raw.prepare('SELECT count(*) AS n FROM manual_linkedin_drafts').get()).toEqual({ n: 0 });
    } finally { f.close(); }
  });
  it('cancels a late model result and blocks context changes during generation', async () => {
    const f = await createLinkedInFixture();
    try {
      const http = async () => { f.repo.changeState({ commandId: '00000000-0000-4000-8000-000000000002', enrollmentId: f.enrollment.id, expectedVersion: 1, state: 'paused', reason: 'Fixture pause' }); return response(); };
      const provider = createLinkedInDraftProvider({ credentials: { load: async () => credentials }, fetch: http });
      const service = new LinkedInService({ repository: f.drafts, provider, productFacts });
      await expect(service.prepare({ stepId: f.version.steps[0]!.id, expectedVersion: 1 })).rejects.toThrow('stale_context');
      expect(f.db.raw.prepare('SELECT count(*) AS n FROM manual_linkedin_drafts').get()).toEqual({ n: 0 });
      service.dispose();
      await expect(service.prepare({ stepId: f.version.steps[0]!.id, expectedVersion: 1 })).rejects.toThrow('disposed');
    } finally { f.close(); }
  });
});
