import { describe, expect, it } from 'vitest';
import { automaticResearchFirmSchema, automaticResearchTargetSchema, todayActionsV4ResponseSchema, todayActionOpenV4ResponseSchema } from '../src/automaticResearch.ts';
import { todayActionsV3ResponseSchema } from '../src/qualifiedResearch.ts';
const id = '10000000-0000-4000-8000-000000000001';
const now = '2026-10-22T00:00:00.000Z';
const target = { kind: 'automatic_research', publicationId: id, publicationRevision: 1, firmId: id, candidateId: id, candidateRevision: 2, runId: id, evidenceFingerprint: 'a'.repeat(64) } as const;
const citation = { kind: 'firm_identity', observationId: id, blockId: 'identity', url: 'https://example.test/', contentHash: 'b'.repeat(64), retrievedAt: now, quote: 'Example residential property management.' } as const;
const proof = { target, source: { kind: 'search_hit', attemptId: id, sourceUrl: 'https://example.test/' }, ownerUserId: id, firmName: 'Example PM', website: 'https://example.test/', locality: 'Dallas', region: 'TX', policyVersion: 'automatic-research-v1', nativePolicyVersion: 'native-firm-eligibility-v1', checkedAt: now, validUntil: '2026-10-23T00:00:00.000Z', citations: [citation, { ...citation, kind: 'service_area' }, { ...citation, kind: 'residential_management' }], emailFit: 'eligible', channelAuthority: 'not_granted', maintenanceNeed: 'not_established', nextStep: 'prepare_discovery_conversation', question: 'What would be useful to learn before a discovery conversation?' };
describe('automatic qualified research contract', () => {
  it('carries source-linked current proof without discovery or phone identity inventions', () => {
    expect(automaticResearchFirmSchema.safeParse(proof).success).toBe(true);
    expect(automaticResearchTargetSchema.safeParse({ ...target, promotionId: id }).success).toBe(false);
    expect(automaticResearchFirmSchema.safeParse({ ...proof, channelAuthority: 'granted' }).success).toBe(false);
    expect(automaticResearchFirmSchema.safeParse({ ...proof, emailFit: 'unresolved' }).success).toBe(false);
    expect(automaticResearchFirmSchema.safeParse({ ...proof, reviewed: true }).success).toBe(false);
  });
  it('adds V4 without silently changing V3 or accepting a sending action', () => {
    const empty = { workspaceId: id, businessTimeZone: 'America/Chicago', asOf: now, actions: [], promiseCoverage: { scope: 'current_authorized_work', truncated: false, nextAfterId: null } };
    expect(todayActionsV3ResponseSchema.safeParse({ ...empty, version: 3 }).success).toBe(true);
    expect(todayActionsV3ResponseSchema.safeParse({ ...empty, version: 4 }).success).toBe(false);
    const action = { actionId: `automatic-research:${id}`, kind: 'research', subject: 'Example PM', reason: 'automatic_research_ready', dueAt: now, state: 'open', target };
    expect(todayActionsV4ResponseSchema.safeParse({ ...empty, version: 4, actions: [action] }).success).toBe(true);
    expect(todayActionsV4ResponseSchema.safeParse({ ...empty, version: 4, actions: [{ ...action, kind: 'send' }] }).success).toBe(false);
  });
  it('keeps current open refusal explicit and versioned', () => {
    expect(todayActionOpenV4ResponseSchema.safeParse({ version: 4, target: null, research: null, automaticResearch: null }).success).toBe(true);
    expect(todayActionOpenV4ResponseSchema.safeParse({ version: 4, target, research: null, automaticResearch: proof }).success).toBe(true);
    expect(todayActionOpenV4ResponseSchema.safeParse({ version: 4, target, research: null, automaticResearch: proof, commandId: id }).success).toBe(false);
  });
});
