import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { QualifiedResearchSelection, QualificationFact } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { seedDiscoveryCandidate } from '@fss/domain/test/sourcing/support/discoverySeed.ts';
import { prepareDiscoveryCandidate, readDiscoveryPreparation } from '@fss/domain/sourcing/discoveryPromotion.ts';
import { requestQualification, finishQualification } from '@fss/domain/sourcing/qualificationStore.ts';
import { evaluateQualification } from '@fss/domain/sourcing/qualificationDecision.ts';
import type { ThinHostApp } from './thinHostApp.ts';

/** Controlled provider evidence only. No model invocation or model-quality claim.
 * Retain raw source, use ordinary preparation and normal qualification owners. */
export async function seedQualifiedResearch(app: ThinHostApp, suffix: string, ambiguous = false) {
  const { fixture: f } = app;
  const context = repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'user', userId: f.alpha.admin.userId, role: 'admin' }), f.db);
  const tx = <T>(work: () => Promise<T>) => withTransaction(f.db, work);
  const name = `Controlled Research ${suffix}`;
  const website = `https://research-${suffix.toLowerCase()}.example.test/`;
  const source = { provider: 'overture_places' as const, release: 'controlled-browser-fixture', recordId: randomUUID(), retrievedAt: null, sourceUrl: 'https://example.test/retained-source' };
  const saved = await tx(() => seedDiscoveryCandidate(context, {
    row: { source, observations: [source], firmName: name, website, locality: 'Dallas', region: 'TX', sourceConfidence: null, residentialFit: 'unknown', websiteAssociation: 'unknown', officePhoneEvidence: 'unknown', probableGroupKey: null },
    origins: [{ source, sourceMetadata: { sourcesJson: '[]' }, licenses: ['controlled-fixture'], notices: [{ label: 'Controlled fixture', url: 'https://example.test/license', sha256: 'a'.repeat(64) }] }],
  }));
  const prepared = await tx(() => prepareDiscoveryCandidate(context, {
    discoveryCandidateId: saved.id, expectedRevision: saved.revision,
    source: { provider: source.provider, release: source.release, recordId: source.recordId },
    candidate: { firmName: name, website, locality: 'Dallas', region: 'TX', signal: 'fit_only', evidence: 'Controlled human seed, not a qualification fact.', sourceUrl: website, observedOn: new Date().toISOString().slice(0, 10), preparedBy: 'Controlled browser acceptance' },
  }));
  assert(prepared.ok, prepared.ok ? '' : prepared.reason);
  const preparation = await readDiscoveryPreparation(context, prepared.value.promotionId);
  assert(preparation);
  // Explicit enqueue:false prevents provider work even during fixture preparation.
  await f.db.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true', [f.alpha.workspaceId]);
  const requested = await tx(() => requestQualification(context, { candidateId: preparation.qualificationCandidateId, expectedRevision: 1 }, { enqueue: false }));
  assert(requested.ok, requested.ok ? '' : requested.reason);
  const observationId = randomUUID();
  const text = `${name} provides residential property management in Dallas, TX.`;
  const email = `info@${new URL(website).hostname}`;
  const blocks = [{ id: 'native', text }, { id: 'email', text: `${name} Dallas TX office ${email}` }, ...(ambiguous ? [{ id: 'other', text: 'Other Company' }] : [])];
  const facts: QualificationFact[] = (['firm_identity', 'service_area', 'residential_management'] as const).map(kind => ({ kind, value: text, observationId, blockId: 'native' }));
  facts.push({ kind: 'business_email', value: blocks[1]!.text, observationId, blockId: 'email' });
  if (ambiguous) facts.push({ kind: 'firm_identity', value: 'Other Company', observationId, blockId: 'other' });
  const finished = await tx(() => finishQualification(context, { runId: requested.value.runId, reason: null, observations: [{ id: observationId, url: website, contentHash: 'a'.repeat(64), relevantTextHash: 'b'.repeat(64), retrievedAt: new Date().toISOString(), publishedAt: null, publishedAtBlockId: null, firstParty: true, truncated: false, blocks }], facts }));
  assert(finished.ok, finished.ok ? '' : finished.reason);
  const evaluated = await tx(() => evaluateQualification(context, { runId: requested.value.runId }));
  assert(evaluated.ok, evaluated.ok ? '' : evaluated.reason);
  // Ordinary createFirm best-effort research must remain disabled during journey.
  await f.db.query('UPDATE research_settings SET enabled=false WHERE workspace_id=$1', [f.alpha.workspaceId]);
  const selection: QualifiedResearchSelection = { discoveryCandidateId: saved.id, discoveryRevision: saved.revision, candidateId: preparation.qualificationCandidateId, candidateRevision: 1, runId: requested.value.runId };
  return { selection, name, website, text, email, source, promotionId: prepared.value.promotionId, observationId };
}
export type QualifiedResearchSeed = Awaited<ReturnType<typeof seedQualifiedResearch>>;
