import { sourceObservationSchema, type QualificationFact, type SourceObservation } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { qualificationCitationRoles, type QualificationCandidateContext } from '../sourcing/qualificationCitationRoles.ts';
import { verifiedFirmEvidence, verifiedWebsiteKey } from '../sourcing/verifiedFirmPolicy.ts';
import { QUALIFICATION_POLICY_VERSION, QUALIFICATION_PROMPT_VERSION } from '../sourcing/qualificationStore.ts';
import { readFirmOfficeAssessment } from '../research/officeAssessmentStore.ts';
import { OFFICE_SOURCE_MILLISECONDS } from '../research/officeAssessmentContract.ts';
import { canonicalizePhone } from '../src/rules/suppressionCanonicalization.ts';
import { currentOfficeSources, validOfficeProof } from '../research/officeAssessmentEvidence.ts';

export interface PhoneOfficeProof { kind: 'admission' | 'office_assessment'; id: string; expiresAt: string }
interface SourceRow { [key: string]: unknown; observation: SourceObservation }
interface AdmissionRow {
  [key: string]: unknown; id: string; payload: QualificationCandidateContext; observations: SourceObservation[];
  facts: QualificationFact[]; policy_version: string; prompt_version: string;
}
const fold = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const phones = /(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]?\d{3}[ .-]?\d{4}/gu;
/** A contrary exact-phone association wins over positive office text, including unselected blocks. */
export function hasPersonalPhoneEvidence(observations: readonly SourceObservation[], e164: string): boolean {
  if (observations.some(source => !sourceObservationSchema.safeParse(source).success)) return true;
  const matches = (text: string) => [...text.matchAll(phones)].some(match => {
    const value = canonicalizePhone(match[0]);
    return value.ok && value.handle.value === e164;
  });
  return observations.some(source => source.blocks.some((block, index) => {
    if (!matches(block.text)) return false;
    const nearby = source.blocks.slice(Math.max(0, index - 1), index + 2);
    return nearby.some(value => /\b(?:personal|cell|mobile)\b/iu.test(value.text));
  }));
}

/** Gate and exact route/firm are held by admission. Advisory callers receive no authority. */
export async function readPhoneOfficeProof(context: RepositoryContext, input: {
  firmId: string; routeId: string; routeVersion: number; e164: string; at: string;
}): Promise<PhoneOfficeProof | null> {
  const w = context.scope.workspaceId;
  const firm = (await context.db.query<{ name: string; website: string | null; locality: string | null; region_code: string | null }>(
    'SELECT name,website,locality,region_code FROM firms WHERE workspace_id=$1 AND id=$2', [w, input.firmId])).rows[0];
  const route = (await context.db.query<{ known_personal_cell_at: Date | null }>(
    'SELECT known_personal_cell_at FROM phone_routes WHERE workspace_id=$1 AND id=$2 AND firm_id=$3 AND version=$4 AND e164=$5 FOR SHARE',
    [w, input.routeId, input.firmId, input.routeVersion, input.e164])).rows[0];
  if (!firm || !route || route.known_personal_cell_at !== null) return null;
  // Preserve every retained contrary association, not only the currently selected positive proof.
  const negativeRuns = (await context.db.query<{ observations: SourceObservation[] }>(`SELECT q.observations FROM sourcing_admissions a
    JOIN sourcing_qualification_runs q ON q.workspace_id=a.workspace_id AND q.candidate_id=a.candidate_id
    WHERE a.workspace_id=$1 AND a.firm_id=$2 ORDER BY q.id FOR SHARE OF a,q`, [w, input.firmId])).rows;
  await context.db.query('SELECT id FROM firm_office_assessments WHERE workspace_id=$1 AND firm_id=$2 ORDER BY id FOR SHARE', [w, input.firmId]);
  const sources = (await context.db.query<SourceRow>(`SELECT s.observation FROM firm_office_assessment_sources s
    JOIN evidence_items e ON e.workspace_id=s.workspace_id AND e.id=s.evidence_id AND e.firm_id=s.firm_id
    WHERE s.workspace_id=$1 AND s.firm_id=$2 ORDER BY s.assessment_id,s.ordinal FOR SHARE OF s,e`, [w, input.firmId])).rows;
  if (hasPersonalPhoneEvidence([...negativeRuns.flatMap(row => row.observations), ...sources.map(row => row.observation)], input.e164)) return null;
  const admissions = (await context.db.query<AdmissionRow>(`SELECT q.id,c.payload,q.observations,q.facts,q.policy_version,q.prompt_version
    FROM sourcing_admissions a JOIN sourcing_candidates c ON c.workspace_id=a.workspace_id AND c.id=a.candidate_id
    JOIN sourcing_qualification_runs q ON q.workspace_id=a.workspace_id AND q.id=a.run_id AND q.candidate_id=a.candidate_id
    WHERE a.workspace_id=$1 AND a.firm_id=$2 AND a.route_id=$3 AND NOT a.association_review_required
      AND NOT c.qualification_blocked AND c.status<>'dismissed' AND c.revision=q.candidate_revision
      AND q.state IN ('eligible','review','admitted') AND q.reason IS NULL ORDER BY q.id FOR SHARE OF a,c,q`, [w, input.firmId, input.routeId])).rows;
  for (const row of admissions) {
    const c = row.payload;
    if (row.policy_version !== QUALIFICATION_POLICY_VERSION || row.prompt_version !== QUALIFICATION_PROMPT_VERSION ||
        fold(c.firmName) !== fold(firm.name) || fold(c.locality) !== fold(firm.locality ?? '') || c.region !== firm.region_code ||
        !verifiedWebsiteKey(c.website) || verifiedWebsiteKey(c.website) !== verifiedWebsiteKey(firm.website)) continue;
    if (!validOfficeProof(row.observations, row.facts) || !currentOfficeSources(c, row.observations, input.at)) continue;
    const roles = qualificationCitationRoles(c, row.facts, row.observations);
    if (!roles.ok) continue;
    const verified = verifiedFirmEvidence({ candidate: c, facts: roles.facts, observations: row.observations, now: input.at });
    if (verified.kind !== 'verified' || verified.phone !== input.e164) continue;
    // All observations must still be complete/current, not just the selected positive citation.
    if (!row.observations.length || row.observations.some(source => !source.firstParty || source.truncated ||
        Date.parse(source.retrievedAt) > Date.parse(input.at) || Date.parse(source.retrievedAt) + OFFICE_SOURCE_MILLISECONDS <= Date.parse(input.at))) continue;
    const expiry = Math.min(...row.observations.map(source => Date.parse(source.retrievedAt) + OFFICE_SOURCE_MILLISECONDS));
    return { kind: 'admission', id: row.id, expiresAt: new Date(expiry).toISOString() };
  }
  // The reader reconstitutes source-owned literal proof, source count/terms/hash and current binding.
  const assessment = await readFirmOfficeAssessment(context, { firmId: input.firmId });
  if (assessment.status !== 'supported' || assessment.routeId !== input.routeId || assessment.routeVersion !== input.routeVersion ||
      !assessment.assessmentId || !assessment.expiresAt || Date.parse(assessment.expiresAt) <= Date.parse(input.at)) return null;
  return { kind: 'office_assessment', id: assessment.assessmentId, expiresAt: assessment.expiresAt };
}
