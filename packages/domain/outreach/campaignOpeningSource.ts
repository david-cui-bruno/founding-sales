import { candidateInputSchema, discoveryOriginSchema, campaignOpeningPolicySchema } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { canonicalWebsite, firmNameKey, websiteDomain, workspaceIndex } from '../crm/import.ts';
import { readTemplateVersion } from '../templates/templates.ts';
import { nativeFirmCitations } from '../sourcing/nativeFirmEligibility.ts';
import {hasPreparedIdentity} from '../sourcing/preparedIdentity.ts';
import { discoveryPreparationMatches } from '../sourcing/discoveryPromotion.ts';
import { retainedCandidateOnly } from '../sourcing/retainedAcquisition.ts';
import { QUALIFICATION_POLICY_VERSION, QUALIFICATION_PROMPT_VERSION, type QualificationRunRow } from '../sourcing/qualificationStore.ts';
import { researchFingerprint } from '../sourcing/qualifiedResearchProof.ts';
import { automaticCampaignSourceProof, automaticCampaignTarget } from './emailCampaignAutomatic.ts';
import { authorizationForMailbox } from './authorization.ts';
import { qualifyEmailCandidate } from './selection.ts';
import { campaignDatabaseNow } from './emailCampaignAuthority.ts';
import { openingSnapshotCurrent, type CampaignOpeningSnapshot } from './campaignOpening.ts';

interface OpeningExecution extends Record<string, unknown> {
  campaign_id: string; campaign_revision: number; owner_user_id: string; mailbox_id: string;
  authorization_revision: number; campaign_expires_at: Date; revoked_at: Date | null; regions: string[];
  sequence_version_id: string; template_version_id: string; enrollment_id: string; firm_id: string;
  assigned_user_id: string; candidate_id: string; qualification_run_id: string;
  source_kind: string; publication_id: string | null; publication_revision: number | null; policy_revoked_at: Date | null;
  candidate_revision: number | null; evidence_fingerprint: string | null; policy: unknown;
  name: string; website: string | null; locality: string | null; region_code: string | null;
}
export type CurrentOpening = { kind: 'exact_template' } | { kind: 'held' } | { kind: 'current'; snapshot: CampaignOpeningSnapshot };

/** Narrow read authority for an already admitted first execution, not general
 * research/admission authority. Keep the actual worker actor, never forge a user.
 * Policy absence is distinct from a present but unresolved/invalid policy. */
export async function readCurrentCampaignOpening(ctx: RepositoryContext, executionId: string): Promise<CurrentOpening> {
  const w = ctx.scope.workspaceId;
  const row = (await ctx.db.query<OpeningExecution>(`SELECT a.*,c.revision AS campaign_revision,c.owner_user_id,c.mailbox_id,c.authorization_revision,
    c.expires_at AS campaign_expires_at,c.revoked_at,c.regions,e.sequence_version_id,e.assigned_user_id,
    s.template_version_id,p.policy,p.revoked_at AS policy_revoked_at,f.name,f.website,f.locality,f.region_code
    FROM step_executions x JOIN sequence_enrollments e ON e.workspace_id=x.workspace_id AND e.id=x.enrollment_id
    JOIN sequence_steps s ON s.workspace_id=x.workspace_id AND s.id=x.step_id AND s.sequence_version_id=e.sequence_version_id
    JOIN outreach_email_campaign_admissions a ON a.workspace_id=e.workspace_id AND a.enrollment_id=e.id
    JOIN outreach_email_campaigns c ON c.workspace_id=a.workspace_id AND c.id=a.campaign_id
    JOIN firms f ON f.workspace_id=e.workspace_id AND f.id=e.firm_id
    LEFT JOIN outreach_campaign_opening_policies p ON p.workspace_id=c.workspace_id AND p.campaign_id=c.id
    WHERE x.workspace_id=$1 AND x.id=$2 AND x.channel='email' AND e.origin_kind='prospecting'
    AND s.ordinal=(SELECT min(s2.ordinal) FROM sequence_steps s2 WHERE s2.workspace_id=s.workspace_id AND s2.sequence_version_id=s.sequence_version_id AND s2.channel='email')`, [w, executionId])).rows[0];
  const prior = (await ctx.db.query('SELECT 1 FROM outreach_campaign_opening_attempts WHERE workspace_id=$1 AND execution_id=$2', [w, executionId])).rows.length > 0;
  if (!row || row.policy === null) return prior ? { kind: 'held' } : { kind: 'exact_template' };
  const parsed = campaignOpeningPolicySchema.safeParse(row.policy);
  if (!parsed.success) return { kind: 'held' };
  const p = parsed.data, actor = ctx.scope.actor;
  if (actor.kind === 'user' ? actor.role !== 'admin' || actor.userId !== row.owner_user_id : !['worker', 'scheduler'].includes(actor.component)) return { kind: 'held' };
  const now = await campaignDatabaseNow(ctx);
  if (row.revoked_at || row.policy_revoked_at || row.campaign_expires_at.getTime() <= Date.parse(now) || row.owner_user_id !== row.assigned_user_id
    || p.workspaceId !== w || p.campaignId !== row.campaign_id || p.campaignRevision !== row.campaign_revision
    || p.ownerUserId !== row.owner_user_id || p.sequenceVersionId !== row.sequence_version_id || p.templateVersionId !== row.template_version_id) return { kind: 'held' };
  const active = (await ctx.db.query(`SELECT 1 FROM firms f JOIN workspace_memberships m ON m.workspace_id=f.workspace_id AND m.user_id=f.assigned_user_id
    JOIN sequence_enrollments e ON e.workspace_id=f.workspace_id AND e.firm_id=f.id AND e.id=$4
    JOIN sequence_versions v ON v.workspace_id=e.workspace_id AND v.id=e.sequence_version_id
    WHERE f.workspace_id=$1 AND f.id=$2 AND f.assigned_user_id=$3 AND f.status='active' AND m.role='admin' AND m.status='active'
    AND e.assigned_user_id=$3 AND e.ended_at IS NULL AND v.state='published' AND v.retired_at IS NULL`, [w, row.firm_id, row.owner_user_id, row.enrollment_id])).rows.length === 1;
  const auth = await authorizationForMailbox(ctx, row.mailbox_id);
  const template = await readTemplateVersion(ctx, row.template_version_id);
  if (!active || !auth.allowed || auth.revision !== row.authorization_revision || !template?.approvedAt || template.retiredAt || template.contentHash !== p.templateContentHash) return { kind: 'held' };
  const source = row.source_kind === 'automatic_research' ? await automaticSource(ctx, row) : await discoverySource(ctx, row, now);
  if (!source || !row.regions.includes(source.region)) return { kind: 'held' };
  const retention = await openingSourceRetention(ctx, row);
  if (!retention || retention.denied) return { kind: 'held' };
  const snapshot: CampaignOpeningSnapshot = {
    policy: p, source: { firmName: source.firmName, locality: source.locality, region: source.region }, citationIds: source.citationIds,
    binding: { workspaceId: w, ownerUserId: row.owner_user_id, campaignId: row.campaign_id, campaignRevision: row.campaign_revision,
      policyId: p.id, sequenceVersionId: row.sequence_version_id, templateVersionId: row.template_version_id, templateContentHash: template.contentHash,
      enrollmentId: row.enrollment_id, executionId, firmId: row.firm_id, candidateId: row.candidate_id, candidateRevision: source.revision,
      qualificationRunId: row.qualification_run_id, sourceFingerprint: source.fingerprint,
      validUntil: new Date(Math.min(Date.parse(source.validUntil), Date.parse(p.expiresAt), row.campaign_expires_at.getTime(), retention.expires_at?.getTime() ?? Infinity)).toISOString() },
  };
  return openingSnapshotCurrent(snapshot, await campaignDatabaseNow(ctx)) ? { kind: 'current', snapshot } : { kind: 'held' };
}
async function automaticSource(ctx: RepositoryContext, row: OpeningExecution) {
  if (!row.publication_id || !row.publication_revision || !row.candidate_revision || !row.evidence_fingerprint) return null;
  const proof = await automaticCampaignSourceProof(ctx, automaticCampaignTarget({
    id: row.publication_id, revision: row.publication_revision, firm_id: row.firm_id, candidate_id: row.candidate_id,
    candidate_revision: row.candidate_revision, run_id: row.qualification_run_id, evidence_fingerprint: row.evidence_fingerprint,
    owner_user_id: row.owner_user_id, source_kind: '', source_attempt_id: '', source_url: '',
  }));
  return proof && proof.owner === row.owner_user_id ? { ...proof.candidate, revision: proof.candidateRevision, fingerprint: proof.fingerprint,
    validUntil: proof.validUntil, citationIds: [...new Set(proof.citations.map(c => `${c.observationId}:${c.blockId}`))] } : null;
}
/** Existing discovery readers require a human admin. This execution-scoped read
 * checks the same exact stored lineage and pure native/email rules without
 * broadening those readers or replacing the real system audit identity. */
async function discoverySource(ctx: RepositoryContext, row: OpeningExecution, now: string) {
  if (row.source_kind !== 'discovery_research' || await retainedCandidateOnly(ctx, row.candidate_id)) return null;
  const lineage = (await ctx.db.query<{ payload: unknown; revision: number; raw_payload: unknown; origin: unknown; source_metadata: unknown; licenses: unknown; notices: unknown }>(`SELECT c.payload,c.revision,r.payload AS raw_payload,o.source AS origin,o.source_metadata,o.licenses,o.notices
    FROM sourcing_discovery_research_firms l JOIN sourcing_discovery_promotions p ON p.workspace_id=l.workspace_id AND p.id=l.promotion_id
    JOIN sourcing_candidates c ON c.workspace_id=p.workspace_id AND c.id=p.legacy_candidate_id AND c.status<>'dismissed' AND NOT c.qualification_blocked
    JOIN sourcing_candidates r ON r.workspace_id=p.workspace_id AND r.id=p.raw_candidate_id AND r.revision=p.raw_candidate_revision AND r.status<>'dismissed' AND NOT r.qualification_blocked
    JOIN sourcing_candidate_discovery_origins o ON o.workspace_id=p.workspace_id AND o.candidate_id=r.id AND o.provider=p.provider AND o.release=p.release AND o.record_id=p.record_id
    WHERE l.workspace_id=$1 AND l.firm_id=$2 AND c.id=$3`, [ctx.scope.workspaceId, row.firm_id, row.candidate_id])).rows;
  if (lineage.length !== 1) return null;
  const l = lineage[0]!, parsed = candidateInputSchema.safeParse(l.payload);
  if (!parsed.success || !discoveryPreparationMatches(l.raw_payload, parsed.data)
    || !discoveryOriginSchema.safeParse({ source: l.origin, sourceMetadata: l.source_metadata, licenses: l.licenses, notices: l.notices }).success) return null;
  const candidate = parsed.data;
  if (row.name !== candidate.firmName.trim().replaceAll(/\s+/gu, ' ') || row.website !== canonicalWebsite(candidate.website)
    || row.locality !== candidate.locality || row.region_code !== candidate.region) return null;
  const index = await workspaceIndex(ctx), domain = websiteDomain(candidate.website);
  const ids = new Set([...(index.byName.get(firmNameKey(candidate.firmName)) ?? []), ...(domain ? index.byDomain.get(domain) ?? [] : [])].map(f => f.id));
  if (ids.size !== 1 || !ids.has(row.firm_id)) return null;
  const run = (await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1', [ctx.scope.workspaceId, row.candidate_id])).rows[0];
  if (!run || hasPreparedIdentity(run) || run.id !== row.qualification_run_id || run.candidate_revision !== l.revision || run.reason !== null
    || !['review', 'eligible', 'admitted'].includes(run.state) || run.policy_version !== QUALIFICATION_POLICY_VERSION || run.prompt_version !== QUALIFICATION_PROMPT_VERSION) return null;
  const native = nativeFirmCitations({ candidate, facts: run.facts, observations: run.observations, now });
  const email = qualifyEmailCandidate({ identity: { status: 'resolved', name: candidate.firmName, website: candidate.website, locality: candidate.locality, region: candidate.region }, facts: run.facts, observations: run.observations, now });
  const route = email.route;
  if ('status' in native || email.decision !== 'eligible' || !route) return null;
  const emailSource = run.observations.find(s => s.id === route.sourceObservationId);
  if (!emailSource) return null;
  // This historical fingerprint includes the full legacy row. Additive producer
  // metadata must not invalidate unchanged pending discovery opening snapshots.
  const legacyRun={...run};delete legacyRun['producer_version'];delete legacyRun['prepared_identity'];
  return { ...candidate, revision: l.revision, fingerprint: researchFingerprint({ lineage: l, run:legacyRun }),
    validUntil: new Date(Math.min(Date.parse(native.validUntil), Date.parse(emailSource.retrievedAt) + 7 * 86400000)).toISOString(),
    citationIds: [...new Set(native.citations.map(c => `${c.observationId}:${c.blockId}`))] };
}
async function openingSourceRetention(ctx: RepositoryContext, row: OpeningExecution) {
  return (await ctx.db.query<{ denied: boolean; expires_at: Date | null }>(`WITH urls AS (
    SELECT rtrim(o->>'url','/') AS url FROM sourcing_qualification_runs q,jsonb_array_elements(q.observations) o WHERE q.workspace_id=$1 AND q.id=$2
    UNION SELECT rtrim(c.payload->>'sourceUrl','/') FROM sourcing_candidates c WHERE c.workspace_id=$1 AND c.id=$3
    UNION SELECT rtrim(o.source->>'sourceUrl','/') FROM sourcing_discovery_promotions p JOIN sourcing_candidate_discovery_origins o ON o.workspace_id=p.workspace_id AND o.candidate_id=p.raw_candidate_id WHERE p.workspace_id=$1 AND p.legacy_candidate_id=$3
    UNION SELECT rtrim(source_url,'/') FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND id=$4
  ) SELECT EXISTS(SELECT 1 FROM urls u WHERE u.url IS NOT NULL AND (
    EXISTS(SELECT 1 FROM evidence_items e WHERE e.workspace_id=$1 AND rtrim(e.source_reference,'/')=u.url AND (e.retention_expires_at<=clock_timestamp() OR (NOT e.terms_allow_retention AND e.retention_expires_at IS NULL)))
    OR EXISTS(SELECT 1 FROM audit_events a WHERE a.workspace_id=$1 AND a.action='sourcing.manual_source_retention_expired' AND a.subject_kind='sourcing_source_hash' AND a.subject_id=encode(sha256(convert_to(u.url,'UTF8')),'hex'))
    OR EXISTS(SELECT 1 FROM sourcing_candidates c WHERE c.workspace_id=$1 AND c.source_check->>'state'='unavailable' AND c.source_check->>'reason' IN ('source_unavailable','source_not_permitted','no_readable_text') AND (rtrim(c.payload->>'sourceUrl','/')=u.url OR rtrim(c.source_check->'lastSuccess'->>'url','/')=u.url))
  )) AS denied,(SELECT min(e.retention_expires_at) FROM evidence_items e JOIN urls u ON rtrim(e.source_reference,'/')=u.url WHERE e.workspace_id=$1) AS expires_at`,
  [ctx.scope.workspaceId, row.qualification_run_id, row.candidate_id, row.publication_id])).rows[0] ?? null;
}
