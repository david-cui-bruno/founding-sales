import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { QualificationFact, QualifiedResearchSelection } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { saveCandidate } from '@fss/domain/sourcing/candidates.ts';
import { seedDiscoveryCandidate } from '@fss/domain/test/sourcing/support/discoverySeed.ts';
import { prepareDiscoveryCandidate, readDiscoveryPreparation } from '@fss/domain/sourcing/discoveryPromotion.ts';
import { requestQualification, finishQualification } from '@fss/domain/sourcing/qualificationStore.ts';
import { evaluateQualification } from '@fss/domain/sourcing/qualificationDecision.ts';
import { createQualifiedResearchFirm } from '@fss/domain/sourcing/qualifiedResearch.ts';
import { saveAnswerBlock, approveAnswerBlock } from '@fss/domain/outreach/facts.ts';
import { readSocialDraftSources } from '@fss/domain/social/draftSources.ts';
import { SOCIAL_DRAFT_MODEL, socialDraftPromptVersion } from '@fss/domain/social/draftPolicy.ts';
import { manualOrdinaryFixture } from '../../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
import { seedFirm } from '../../../api/test/support/crmSeed.ts';
import { seedReplyBrief } from './replyBriefSeed.ts';
import { glassCase, type GlassWorkspaceApp } from './glassWorkspaceApp.ts';

/** Controlled retained records, through ordinary domain owners. Fixture setup is
 * separate from app_runtime HTTP requests. No acquisition, workers or paid work. */
export async function seedGlassWorkspace(app: GlassWorkspaceApp) {
  const f = app.fixture;
  // Privileged fixture owner only. Actual authenticated HTTP remains app_runtime.
  // This does not qualify the separate createQualifiedResearchFirm runtime-write path.
  const fixtureSession = f.db;
  const ctx = repositoryContext(workspaceScope(f.alpha.workspaceId, { kind: 'user', userId: f.alpha.admin.userId, role: 'admin' }), fixtureSession);
  const tx = <T>(work: () => Promise<T>) => withTransaction(fixtureSession, work);
  const candidateIds: string[] = [];
  for (const [index, name] of ['FICTIONAL Glass783 raw observation', 'FICTIONAL Glass783 other observation'].entries()) {
    const input = manualOrdinaryFixture(78300 + index);
    input.firmName = name;
    input.website = `https://glass783-raw-${index}.example.test/`;
    input.evidence = `FICTIONAL retained evidence ${index}. Phone not observed. Not a canonical Firm.`;
    input.sourceUrl = input.website;
    input.preparedBy = 'FICTIONAL goal783 controlled retained fixture';
    const saved = await tx(() => saveCandidate(ctx, input));
    assert(saved.ok, saved.ok ? '' : saved.reason);
    candidateIds.push(saved.value.id);
  }
  const name = 'FICTIONAL Glass783 prepared research';
  const website = 'https://glass783-prepared.example.test/';
  const source = { provider: 'overture_places' as const, release: 'fictional-glass783', recordId: randomUUID(), retrievedAt: null, sourceUrl: 'https://glass783-source.example.test/record' };
  const discovery = await tx(() => seedDiscoveryCandidate(ctx, {
    row: { source, observations: [source], firmName: name, website, locality: 'Dallas', region: 'TX', sourceConfidence: null, residentialFit: 'unknown', websiteAssociation: 'unknown', officePhoneEvidence: 'unknown', probableGroupKey: null },
    origins: [{ source, sourceMetadata: { sourcesJson: '[]' }, licenses: ['fictional-controlled-fixture'], notices: [{ label: 'Fictional fixture', url: 'https://glass783-source.example.test/license', sha256: 'a'.repeat(64) }] }],
  }));
  const prepared = await tx(() => prepareDiscoveryCandidate(ctx, {
    discoveryCandidateId: discovery.id, expectedRevision: discovery.revision,
    source: { provider: source.provider, release: source.release, recordId: source.recordId },
    candidate: { firmName: name, website, locality: 'Dallas', region: 'TX', signal: 'fit_only', evidence: 'FICTIONAL preparation, not contact authority.', sourceUrl: website, observedOn: new Date().toISOString().slice(0, 10), preparedBy: 'FICTIONAL goal783' },
  }));
  assert(prepared.ok, prepared.ok ? '' : prepared.reason);
  const preparation = await readDiscoveryPreparation(ctx, prepared.value.promotionId);
  assert(preparation);
  await f.db.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true', [f.alpha.workspaceId]);
  const requested = await tx(() => requestQualification(ctx, { candidateId: preparation.qualificationCandidateId, expectedRevision: 1 }, { enqueue: false }));
  assert(requested.ok, requested.ok ? '' : requested.reason);
  const observationId = randomUUID();
  const text = `${name} provides residential property management in Dallas, TX.`;
  const blocks = [{ id: 'identity', text }, { id: 'email', text: `${name} Dallas TX office hello@glass783-prepared.example.test` }];
  const facts: QualificationFact[] = (['firm_identity', 'service_area', 'residential_management'] as const).map(kind => ({ kind, value: text, observationId, blockId: 'identity' }));
  facts.push({ kind: 'business_email', value: blocks[1]!.text, observationId, blockId: 'email' });
  const finished = await tx(() => finishQualification(ctx, { runId: requested.value.runId, reason: null, observations: [{ id: observationId, url: website, contentHash: 'a'.repeat(64), relevantTextHash: 'b'.repeat(64), retrievedAt: new Date().toISOString(), publishedAt: null, publishedAtBlockId: null, firstParty: true, truncated: false, blocks }], facts }));
  assert(finished.ok, finished.ok ? '' : finished.reason);
  const evaluated = await tx(() => evaluateQualification(ctx, { runId: requested.value.runId }));
  assert(evaluated.ok, evaluated.ok ? '' : evaluated.reason);
  await f.db.query('UPDATE research_settings SET enabled=false WHERE workspace_id=$1', [f.alpha.workspaceId]);
  const selection: QualifiedResearchSelection = { discoveryCandidateId: discovery.id, discoveryRevision: discovery.revision, candidateId: preparation.qualificationCandidateId, candidateRevision: 1, runId: requested.value.runId };
  const canonical = await tx(() => createQualifiedResearchFirm(ctx, selection));
  assert(canonical.ok, canonical.ok ? '' : canonical.reason);
  const fact = await tx(() => saveAnswerBlock(ctx, { kind: 'product', text: 'FICTIONAL goal783: a maintenance intake feature is planned, not shipped.', socialInput: { topic: 'build', status: 'planned', sanitized: true } }));
  assert(fact.ok, fact.ok ? '' : fact.reason);
  const ref = { id: fact.value.id, version: fact.value.version };
  assert((await tx(() => approveAnswerBlock(ctx, ref))).ok);
  const socialSelection = { mode: 'linkedin_grounded' as const, sourceRefs: [], factBlocks: [ref] };
  const socialSources = await tx(() => readSocialDraftSources(ctx, socialSelection));
  assert(socialSources.ok, socialSources.ok ? '' : socialSources.reason);
  const socialText = 'FICTIONAL goal783 retained suggestion. A maintenance intake feature is planned, not shipped.';
  const social = (await fixtureSession.query<{ id: string }>("INSERT INTO social_draft_requests(workspace_id,owner_user_id,source_selection,source_hash,prompt_version,model_name,state,concepts) VALUES($1,$2,$3::jsonb,$4,$5,$6,'ready',$7::jsonb) RETURNING id", [f.alpha.workspaceId, f.alpha.admin.userId, JSON.stringify(socialSelection), socialSources.value.hash, socialDraftPromptVersion(socialSelection.mode), SOCIAL_DRAFT_MODEL, JSON.stringify([{ theme: 'build', factRefs: [ref], variants: [{ platform: 'linkedin', text: socialText }] }])])).rows[0]!;
  const secondFirmId = await seedFirm(f, { name: 'FICTIONAL Glass783 independent conversation', regionCode: 'TX', assignedUserId: f.alpha.salesperson.userId });
  const secondCase = { ...glassCase, firm: 'FICTIONAL Glass783 independent conversation', messages: glassCase.messages.map(message => ({ ...message, id: `${message.id}-OTHER`, body: `OTHER CONVERSATION: ${message.body}`, subject: 'FICTIONAL independent original' })) };
  const secondReply = await seedReplyBrief(f, secondFirmId, secondCase);
  return { candidateId: candidateIds[0]!, otherCandidateId: candidateIds[1]!, name, website, source, selection, preparedFirmId: canonical.value.firmId, socialRequestId: social.id, socialText, secondReply };
}
export type GlassWorkspaceSeed = Awaited<ReturnType<typeof seedGlassWorkspace>>;
