import { beforeEach, expect, it, vi } from 'vitest';
import { readCurrentCampaignOpening } from '../../outreach/campaignOpeningSource.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { id, other, now, openingFixture } from './campaignOpeningFixture.ts';
const mocks = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), template: vi.fn(), proof: vi.fn(), clock: vi.fn() }));
vi.mock('../../outreach/authorization.ts', () => ({ authorizationForMailbox: mocks.auth }));
vi.mock('../../templates/templates.ts', () => ({ readTemplateVersion: mocks.template }));
vi.mock('../../outreach/emailCampaignAutomatic.ts', () => ({ automaticCampaignTarget: (value: unknown) => value, automaticCampaignSourceProof: mocks.proof }));
vi.mock('../../outreach/emailCampaignAuthority.ts', () => ({ campaignDatabaseNow: mocks.clock }));
const ctx = repositoryContext(workspaceScope(id, { kind: 'system', component: 'worker' }), { query: mocks.query });
let row: Record<string, unknown>, prior: boolean;
beforeEach(() => {
  vi.clearAllMocks(); prior = false;
  row = { campaign_id: id, campaign_revision: 1, owner_user_id: id, mailbox_id: id, authorization_revision: 1,
    campaign_expires_at: new Date('2026-10-28T14:00:00.000Z'), revoked_at: null, policy_revoked_at: null, regions: ['TX'],
    sequence_version_id: id, template_version_id: id, enrollment_id: id, firm_id: id, assigned_user_id: id,
    candidate_id: id, qualification_run_id: id, source_kind: 'automatic_research', publication_id: id,
    publication_revision: 1, candidate_revision: 1, evidence_fingerprint: 'b'.repeat(64), policy: openingFixture().policy };
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT a.*') ? [row] : sql.startsWith('WITH urls') ? [{ denied: false, expires_at: null }] : sql.startsWith('SELECT 1 FROM outreach_campaign_opening_attempts') ? (prior ? [{}] : []) : [{}] }));
  mocks.auth.mockResolvedValue({ allowed: true, revision: 1 }); mocks.clock.mockResolvedValue(now);
  mocks.template.mockResolvedValue({ approvedAt: now, retiredAt: null, contentHash: 'a'.repeat(64) });
  mocks.proof.mockResolvedValue({ owner: id, candidate: { firmName: 'Fictional Homes', locality: 'Dallas', region: 'TX' }, candidateRevision: 1, fingerprint: 'b'.repeat(64),
    validUntil: '2026-10-28T14:00:00.000Z', citations: [{ observationId: id, blockId: 'native' }, { observationId: id, blockId: 'native' }] });
});
it('uses actual worker scope, exact stored admission target, deduplicated current citations and shortest expiry', async () => {
  const current = await readCurrentCampaignOpening(ctx, id);
  expect(current).toMatchObject({ kind: 'current', snapshot: { citationIds: [`${id}:native`], binding: { validUntil: openingFixture().policy.expiresAt } } });
  expect(mocks.proof).toHaveBeenCalledWith(ctx, expect.objectContaining({ candidate_id: id, run_id: id, firm_id: id }));
  expect(ctx.scope.actor).toEqual({ kind: 'system', component: 'worker' });
});
it('only missing policy preserves exact-template behavior, no retroactive approval for an erased attempt', async () => {
  row['policy'] = null; expect(await readCurrentCampaignOpening(ctx, id)).toEqual({ kind: 'exact_template' });
  prior = true; expect(await readCurrentCampaignOpening(ctx, id)).toEqual({ kind: 'held' }); expect(mocks.proof).not.toHaveBeenCalled();
});
it.each([
  ['foreign workspace', () => { row['policy'] = { ...openingFixture().policy, workspaceId: other }; }],
  ['owner', () => { row['assigned_user_id'] = other; }],
  ['revoked policy', () => { row['policy_revoked_at'] = new Date(now); }],
  ['revision', () => { row['campaign_revision'] = 2; }],
  ['campaign expiry', () => { row['campaign_expires_at'] = new Date(now); }],
  ['invalid policy', () => { row['policy'] = {}; }],
  ['mailbox revision', () => { mocks.auth.mockResolvedValue({ allowed: true, revision: 2 }); }],
  ['retired template', () => { mocks.template.mockResolvedValue({ approvedAt: now, retiredAt: now, contentHash: 'a'.repeat(64) }); }],
  ['template hash', () => { mocks.template.mockResolvedValue({ approvedAt: now, retiredAt: null, contentHash: 'c'.repeat(64) }); }],
  ['current source deleted', () => { mocks.proof.mockResolvedValue(null); }],
  ['current source owner', () => { mocks.proof.mockResolvedValue({ owner: other }); }],
] as const)('holds on %s without silent baseline fallback', async (_label, change) => {
  change(); expect(await readCurrentCampaignOpening(ctx, id)).toEqual({ kind: 'held' });
});
it('rechecks wall clock after delayed source read, never uses the old transaction time for expiry', async () => {
  mocks.proof.mockImplementation(async () => { mocks.clock.mockResolvedValue(openingFixture().policy.expiresAt); return { owner: id, candidate: openingFixture().source, candidateRevision: 1, fingerprint: 'b'.repeat(64), validUntil: '2026-10-28T14:00:00.000Z', citations: [{ observationId: id, blockId: 'native' }] }; });
  expect(await readCurrentCampaignOpening(ctx, id)).toEqual({ kind: 'held' });
});
it('holds on a current retention denial and binds the earliest source retention expiry', async () => {
  const query = mocks.query.getMockImplementation()!;
  mocks.query.mockImplementation(async (sql: string, values: readonly unknown[]) => sql.startsWith('WITH urls') ? { rows: [{ denied: true, expires_at: null }] } : query(sql, values));
  expect(await readCurrentCampaignOpening(ctx, id)).toEqual({ kind: 'held' });
  const expiresAt = new Date(Date.parse(now) + 60_000);
  mocks.query.mockImplementation(async (sql: string, values: readonly unknown[]) => sql.startsWith('WITH urls') ? { rows: [{ denied: false, expires_at: expiresAt }] } : query(sql, values));
  expect(await readCurrentCampaignOpening(ctx, id)).toMatchObject({ kind: 'current', snapshot: { binding: { validUntil: expiresAt.toISOString() } } });
});
it('does not grant worker source read authority to unrelated system actors or foreign admins', async () => {
  for (const actor of [{ kind: 'system', component: 'migration' }, { kind: 'user', userId: other, role: 'admin' }] as const) {
    const foreign = repositoryContext(workspaceScope(id, actor), { query: mocks.query });
    expect(await readCurrentCampaignOpening(foreign, id)).toEqual({ kind: 'held' });
  }
  expect(mocks.proof).not.toHaveBeenCalled();
});
