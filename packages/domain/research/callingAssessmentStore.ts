import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {type QualificationFact, type SourceObservation} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {QualificationCandidateContext} from '../sourcing/qualificationCitationRoles.ts';
import type {SourcingResult} from '../sourcing/qualificationStore.ts';
import {assessCallingEvidence, CALLING_EVIDENCE_POLICY_VERSION, hasKnownPersonalPhoneEvidence} from '../sourcing/callingEvidence.ts';
import {officeHash, officeNow, readOfficeAssessmentBinding} from './officeAssessmentTarget.ts';
import {readFirmOfficeAssessment} from './officeAssessmentStore.ts';
import {actorKind, actorUserId} from '../crm/types.ts';

export const CALLING_ASSESSMENT_ACTION = 'calling.source_evidence_assessed';
const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const selectorSchema = z.strictObject({rule: z.enum(['positive_firm_identity', 'phone_anywhere_first_party', 'texas_anywhere_first_party', 'residential_rentals_anywhere_first_party']), observationId: uuid, blockId: z.string().min(1).max(80)});
const detailSchema = z.strictObject({policyVersion: z.literal(CALLING_EVIDENCE_POLICY_VERSION), parentKind: z.enum(['qualification_run', 'office_assessment']), parentId: uuid,
  candidateId: uuid.nullable(), candidateRevision: z.number().int().positive().nullable(), firmId: uuid, routeId: uuid, routeVersion: z.number().int().positive(),
  endpointHash: digest, identityFingerprint: digest, sourceFingerprint: digest, expectedSourceCount: z.number().int().min(1).max(8), audit: z.array(selectorSchema).min(4).max(5), expiresAt: z.iso.datetime()});
export type CallingAssessmentDetail = z.infer<typeof detailSchema>;
export interface CallingAssessmentReference {parentKind: 'qualification_run' | 'office_assessment'; parentId: string; candidateId: string | null; candidateRevision: number | null}
interface FirmRow extends Record<string, unknown> {name: string; website: string | null; locality: string | null; region_code: string | null; status: string; assigned_user_id: string | null}
interface Target {firmId: string; routeId: string; routeVersion: number; e164: string; at: string}
interface Parent {candidate: QualificationCandidateContext; observations: SourceObservation[]; facts: QualificationFact[]; expiresAt: string; sourceVersion: string}
export interface CallingAssessmentResult {assessmentId: string; firmId: string; routeId: string; routeVersion: number; policyVersion: typeof CALLING_EVIDENCE_POLICY_VERSION; expiresAt: string}
export type CallingProofRead = {kind: 'none'} | {kind: 'invalid'} | ({kind: 'proof'} & CallingAssessmentResult);
const refused = (reason: string): {ok: false; reason: string} => ({ok: false, reason});
const identityHash = (firm: FirmRow) => officeHash(JSON.stringify([firm.name, firm.website, firm.locality, firm.region_code]));
const sourceHash = (parent: Parent) => officeHash(JSON.stringify([parent.sourceVersion, parent.observations, parent.facts]));
const fold = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

async function currentTarget(ctx: RepositoryContext, input: Target): Promise<FirmRow | null> {
  const actor = ctx.scope.actor;
  if (actor.kind !== 'user' || actor.role !== 'admin') return null;
  const w = ctx.scope.workspaceId;
  const member = (await ctx.db.query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE", [w, actor.userId])).rows[0];
  const firm = (await ctx.db.query<FirmRow>('SELECT name,website,locality,region_code,status,assigned_user_id FROM firms WHERE workspace_id=$1 AND id=$2 FOR SHARE', [w, input.firmId])).rows[0];
  const route = (await ctx.db.query<{known_personal_cell_at: Date | null; eligibility: string; retired_at: Date | null}>(`SELECT known_personal_cell_at,eligibility,retired_at FROM phone_routes
    WHERE workspace_id=$1 AND firm_id=$2 AND id=$3 AND version=$4 AND e164=$5 FOR SHARE`, [w, input.firmId, input.routeId, input.routeVersion, input.e164])).rows[0];
  const personal = (await ctx.db.query('SELECT id FROM phone_routes WHERE workspace_id=$1 AND e164=$2 AND known_personal_cell_at IS NOT NULL FOR SHARE', [w, input.e164])).rows.length > 0;
  return member && firm?.status === 'active' && firm.assigned_user_id === actor.userId && route && !route.retired_at
    && ['candidate', 'usable'].includes(route.eligibility) && route.known_personal_cell_at === null && !personal ? firm : null;
}
async function personalSourceEvidence(ctx: RepositoryContext, e164: string): Promise<boolean> {
  const runs = (await ctx.db.query<{observations: SourceObservation[]}>(`SELECT observations FROM sourcing_qualification_runs WHERE workspace_id=$1 AND state NOT IN ('pending','running') ORDER BY id FOR SHARE`, [ctx.scope.workspaceId])).rows;
  const sources = (await ctx.db.query<{observation: SourceObservation}>(`SELECT s.observation FROM firm_office_assessment_sources s JOIN evidence_items e ON e.workspace_id=s.workspace_id AND e.id=s.evidence_id AND e.firm_id=s.firm_id WHERE s.workspace_id=$1 ORDER BY s.assessment_id,s.ordinal FOR SHARE OF s,e`, [ctx.scope.workspaceId])).rows;
  return hasKnownPersonalPhoneEvidence([...runs.flatMap(row => row.observations), ...sources.map(row => row.observation)], e164);
}
async function loadParent(ctx: RepositoryContext, reference: CallingAssessmentReference, firm: FirmRow, input: Target): Promise<Parent | null> {
  const w = ctx.scope.workspaceId;
  if (reference.parentKind === 'qualification_run') {
    if (!reference.candidateId || !reference.candidateRevision) return null;
    const candidate = (await ctx.db.query<{payload: QualificationCandidateContext; revision: number; status: string; qualification_blocked: boolean}>('SELECT payload,revision,status,qualification_blocked FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR SHARE', [w, reference.candidateId])).rows[0];
    const run = (await ctx.db.query<{candidate_revision: number; state: string; policy_version: string; prompt_version: string; reason: string | null; observations: SourceObservation[]; facts: QualificationFact[]}>(`SELECT candidate_revision,state,policy_version,prompt_version,reason,observations,facts FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 AND id=$3 FOR SHARE`, [w, reference.candidateId, reference.parentId])).rows[0];
    if (!candidate || !run || candidate.status === 'dismissed' || candidate.qualification_blocked || candidate.revision !== reference.candidateRevision
      || run.candidate_revision !== candidate.revision || !['review', 'eligible', 'unavailable', 'admitted'].includes(run.state)) return null;
    const c = candidate.payload;
    if (fold(c.firmName) !== fold(firm.name) || c.website !== firm.website || fold(c.locality) !== fold(firm.locality ?? '') || c.region !== firm.region_code) return null;
    if (!Array.isArray(run.observations) || !run.observations.length) return null;
    const expiresAt = new Date(Math.min(...run.observations.map(source => Date.parse(source.retrievedAt) + 7 * 86400000)));
    if (!Number.isFinite(expiresAt.getTime())) return null;
    return {candidate: c, observations: run.observations, facts: run.facts, expiresAt: expiresAt.toISOString(), sourceVersion: JSON.stringify([run.policy_version, run.prompt_version, run.state, run.reason])};
  }
  if (reference.candidateId !== null || reference.candidateRevision !== null) return null;
  const parent = (await ctx.db.query<{research_run_id: string; expected_source_count: number; expires_at: Date}>(`SELECT research_run_id,expected_source_count,expires_at FROM firm_office_assessments WHERE workspace_id=$1 AND id=$2 AND firm_id=$3 FOR SHARE`, [w, reference.parentId, input.firmId])).rows[0];
  if (!parent) return null;
  const bound = await readOfficeAssessmentBinding(ctx, parent.research_run_id);
  if ('reason' in bound || bound.parent.id !== reference.parentId || bound.parent.phone_route_id !== input.routeId || bound.parent.route_version !== input.routeVersion || bound.parent.route_endpoint_hash !== officeHash(input.e164)) return null;
  const rows = (await ctx.db.query<{observation: SourceObservation; facts: QualificationFact[]; expires_at: Date}>(`SELECT s.observation,s.facts,s.expires_at FROM firm_office_assessment_sources s JOIN evidence_items e ON e.workspace_id=s.workspace_id AND e.id=s.evidence_id AND e.firm_id=s.firm_id WHERE s.workspace_id=$1 AND s.assessment_id=$2 ORDER BY s.ordinal FOR SHARE OF s,e`, [w, reference.parentId])).rows;
  // Validate after acquiring source/evidence locks, including any lock waits.
  // Canonical strict result is inspected, never reclassified or overwritten.
  const view = await readFirmOfficeAssessment(ctx, {firmId: input.firmId});
  if (view.assessmentId !== reference.parentId || !['supported', 'pending', 'unclear'].includes(view.status) || view.sourceCount !== parent.expected_source_count || !view.sourceCount) return null;
  if (rows.length !== parent.expected_source_count || rows.some(row => row.expires_at.getTime() <= Date.parse(input.at))) return null;
  return {candidate: bound.candidate, observations: rows.map(row => row.observation), facts: rows.flatMap(row => row.facts), sourceVersion: view.policyVersion ?? '', expiresAt: new Date(Math.min(parent.expires_at.getTime(), ...rows.map(row => row.expires_at.getTime()))).toISOString()};
}
async function reconstruct(ctx: RepositoryContext, reference: CallingAssessmentReference, input: Target): Promise<CallingAssessmentDetail | null> {
  const firm = await currentTarget(ctx, input);
  if (!firm) return null;
  const parent = await loadParent(ctx, reference, firm, input);
  if (!parent || await personalSourceEvidence(ctx, input.e164)) return null;
  // A source lock may have waited beyond the original request timestamp.
  const now = new Date(Math.max(Date.parse(input.at), Date.parse(await officeNow(ctx)))).toISOString();
  const result = assessCallingEvidence({candidate: parent.candidate, observations: parent.observations, facts: parent.facts, phone: input.e164, knownPersonalCell: false, now});
  if (result.kind !== 'source_evidence_eligible') return null;
  const expiresAt = new Date(Math.min(Date.parse(parent.expiresAt), Date.parse(result.expiresAt))).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(now)) return null;
  return {policyVersion: CALLING_EVIDENCE_POLICY_VERSION, ...reference, firmId: input.firmId, routeId: input.routeId, routeVersion: input.routeVersion,
    endpointHash: officeHash(input.e164), identityFingerprint: identityHash(firm), sourceFingerprint: sourceHash(parent), expectedSourceCount: parent.observations.length,
    audit: result.audit.map(({rule, observationId, blockId}) => ({rule, observationId, blockId})), expiresAt};
}

/** Called only by explicit owner commands inside their transaction, never reads. */
export async function recordCallingAssessment(ctx: RepositoryContext, reference: CallingAssessmentReference, input: Target): Promise<SourcingResult<CallingAssessmentResult>> {
  const detail = await reconstruct(ctx, reference, input);
  if (!detail) return refused('calling_evidence_held');
  const prior = (await ctx.db.query<{id: string}>(`SELECT id FROM audit_events WHERE workspace_id=$1 AND actor_user_id=$2 AND action=$3 AND subject_kind='firm' AND subject_id=$4 AND detail=$5::jsonb ORDER BY occurred_at,id LIMIT 1`, [ctx.scope.workspaceId, actorUserId(ctx), CALLING_ASSESSMENT_ACTION, input.firmId, JSON.stringify(detail)])).rows[0];
  const id = prior?.id ?? (await ctx.db.query<{id: string}>(`INSERT INTO audit_events(workspace_id,actor_kind,actor_user_id,action,subject_kind,subject_id,detail) VALUES($1,$2,$3,$4,'firm',$5,$6::jsonb) RETURNING id`, [ctx.scope.workspaceId, actorKind(ctx), actorUserId(ctx), CALLING_ASSESSMENT_ACTION, input.firmId, JSON.stringify(detail)])).rows[0]?.id;
  if (!id) throw new Error('Calling assessment audit missing');
  return {ok: true, value: {assessmentId: id, firmId: input.firmId, routeId: input.routeId, routeVersion: input.routeVersion, policyVersion: CALLING_EVIDENCE_POLICY_VERSION, expiresAt: detail.expiresAt}};
}

/** An audit event UUID is intentionally stored in the existing office_assessment
 * proof slot. It identifies THIS calling policy, never a strict-supported parent.
 * Any existing expected event with wrong action/version/shape is terminal invalid. */
export async function readCallingAssessment(ctx: RepositoryContext, input: Target & {expectedAuditId?: string}): Promise<CallingProofRead> {
  const actor = ctx.scope.actor;
  if (actor.kind !== 'user') return {kind: 'invalid'};
  const rows = (await ctx.db.query<{id: string; action: string; subject_kind: string; subject_id: string | null; actor_user_id: string | null; occurred_at: Date; detail: unknown}>(input.expectedAuditId
    ? 'SELECT id,action,subject_kind,subject_id,actor_user_id,occurred_at,detail FROM audit_events WHERE workspace_id=$1 AND id=$2'
    : "SELECT id,action,subject_kind,subject_id,actor_user_id,occurred_at,detail FROM audit_events WHERE workspace_id=$1 AND action=$2 AND subject_kind='firm' AND subject_id=$3 ORDER BY occurred_at DESC,id DESC LIMIT 20",
  input.expectedAuditId ? [ctx.scope.workspaceId, input.expectedAuditId] : [ctx.scope.workspaceId, CALLING_ASSESSMENT_ACTION, input.firmId])).rows;
  if (!rows.length) return {kind: 'none'};
  for (const row of rows) {
    const parsed = detailSchema.safeParse(row.detail);
    if (row.action !== CALLING_ASSESSMENT_ACTION || row.subject_kind !== 'firm' || row.subject_id !== input.firmId || row.actor_user_id !== actor.userId || row.occurred_at.getTime() > Date.parse(input.at) || !parsed.success) {
      if (input.expectedAuditId) return {kind: 'invalid'};
      continue;
    }
    const detail = parsed.data;
    if (detail.firmId !== input.firmId || detail.routeId !== input.routeId || detail.routeVersion !== input.routeVersion || detail.endpointHash !== officeHash(input.e164) || Date.parse(detail.expiresAt) <= Date.parse(input.at)) {
      if (input.expectedAuditId) return {kind: 'invalid'};
      continue;
    }
    const live = await reconstruct(ctx, {parentKind: detail.parentKind, parentId: detail.parentId, candidateId: detail.candidateId, candidateRevision: detail.candidateRevision}, input);
    const same = live !== null && isDeepStrictEqual(detail, live);
    if (!same) { if (input.expectedAuditId) return {kind: 'invalid'}; continue; }
    return {kind: 'proof', assessmentId: row.id, firmId: input.firmId, routeId: input.routeId, routeVersion: input.routeVersion, policyVersion: CALLING_EVIDENCE_POLICY_VERSION, expiresAt: detail.expiresAt};
  }
  // Immutable calling history is not a veto over independent current strict
  // evidence. Only an explicitly expected event forbids trying another proof.
  return {kind: input.expectedAuditId ? 'invalid' : 'none'};
}
