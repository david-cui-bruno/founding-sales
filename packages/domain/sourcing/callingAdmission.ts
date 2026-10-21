import {callingAdmissionInputSchema, callingAssessmentInputSchema, type CallingAdmissionInput, type CallingAssessmentInput, type CandidateInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {QualificationRunRow, SourcingResult} from './qualificationStore.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {createFirm, loadFirmForUpdate, resolveZoneForFirm} from '../crm/firms.ts';
import {firmNameKey, websiteDomain} from '../crm/import.ts';
import {addPhoneRoute} from '../crm/routes.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {lockTodayForFirmChange, refreshTodayForFirm} from '../today/build.ts';
import {firstSuppressed} from '../suppression/effective.ts';
import {suppressionKeys} from '../dial/authorize.ts';
import {applicablePosture} from '../policy/postures.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {officeNow} from '../research/officeAssessmentTarget.ts';
import {recordCallingAssessment, type CallingAssessmentResult} from '../research/callingAssessmentStore.ts';
import {assessCallingEvidence} from './callingEvidence.ts';
import {sourcingTimeZone} from './admission.ts';
import {isLegacyCandidatePayload} from './discoveryIntake.ts';

const refused = (reason: string): {ok: false; reason: string} => ({ok: false, reason});
const cityKey = (value: string) => firmNameKey(value).replace(/[^a-z ]/gu, '');
export type CallingAdmissionResult = CallingAssessmentResult & {createdFirm: boolean};

/** Explicit calling command owns the admission gate. Research only stores and reads source evidence. */
export async function assessCallingOffice(ctx: RepositoryContext, input: CallingAssessmentInput): Promise<SourcingResult<CallingAssessmentResult>> {
  if (!decideAdminOnly(ctx).permitted || ctx.scope.actor.kind !== 'user') return refused('admin_only');
  if (!callingAssessmentInputSchema.safeParse(input).success) return refused('invalid_input');
  await lockSendGateForStopFact(ctx);
  const row = (await ctx.db.query<{phone_route_id: string; route_version: number}>(`SELECT phone_route_id,route_version FROM firm_office_assessments WHERE workspace_id=$1 AND id=$2 AND firm_id=$3`, [ctx.scope.workspaceId, input.officeAssessmentId, input.firmId])).rows[0];
  if (!row) return refused('not_found');
  const route = (await ctx.db.query<{e164: string}>('SELECT e164 FROM phone_routes WHERE workspace_id=$1 AND id=$2 AND firm_id=$3 AND version=$4', [ctx.scope.workspaceId, row.phone_route_id, input.firmId, row.route_version])).rows[0];
  if (!route) return refused('route_changed');
  return recordCallingAssessment(ctx, {parentKind: 'office_assessment', parentId: input.officeAssessmentId, candidateId: null, candidateRevision: null}, {firmId: input.firmId, routeId: row.phone_route_id, routeVersion: row.route_version, e164: route.e164, at: await officeNow(ctx)});
}

/** Separate owner-reviewed CALLING onboarding. Never writes sourcing_admissions,
 * qualification state/verdict, email/SMS routes, enrollments or call receipts. */
export async function admitCallingCandidate(ctx: RepositoryContext, input: CallingAdmissionInput): Promise<SourcingResult<CallingAdmissionResult>> {
  if (!decideAdminOnly(ctx).permitted || ctx.scope.actor.kind !== 'user') return refused('admin_only');
  if (!callingAdmissionInputSchema.safeParse(input).success) return refused('invalid_input');
  await ctx.db.query('SAVEPOINT calling_admission');
  try {
    const result = await admit(ctx, input, ctx.scope.actor.userId);
    if (!result.ok) await ctx.db.query('ROLLBACK TO SAVEPOINT calling_admission');
    await ctx.db.query('RELEASE SAVEPOINT calling_admission');
    return result;
  } catch (error) {
    await ctx.db.query('ROLLBACK TO SAVEPOINT calling_admission');
    await ctx.db.query('RELEASE SAVEPOINT calling_admission');
    throw error;
  }
}
async function admit(ctx: RepositoryContext, input: CallingAdmissionInput, owner: string): Promise<SourcingResult<CallingAdmissionResult>> {
  const w = ctx.scope.workspaceId;
  await lockSendGateForStopFact(ctx);
  await lockTodayForFirmChange(ctx);
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sourcing-identity:${w}`]);
  const peek = (await ctx.db.query<{payload: CandidateInput}>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2', [w, input.candidateId])).rows[0];
  if (!peek) return refused('not_found');
  if (!isLegacyCandidatePayload(peek.payload)) return refused('candidate_format_not_supported');
  const name = firmNameKey(peek.payload.firmName), domain = websiteDomain(peek.payload.website);
  const matches = (await ctx.db.query<{id: string; name: string; website: string | null; locality: string | null; region_code: string | null}>(`SELECT id,name,website,locality,region_code FROM firms WHERE workspace_id=$1 AND (lower(regexp_replace(trim(name),'\\s+',' ','g'))=$2 OR regexp_replace(lower(split_part(website,'/',3)),'^www\\.','')=$3) ORDER BY id FOR UPDATE`, [w, name, domain])).rows;
  const candidate = (await ctx.db.query<{payload: CandidateInput; revision: number; status: string; qualification_blocked: boolean}>('SELECT payload,revision,status,qualification_blocked FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [w, input.candidateId])).rows[0];
  const run = (await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 AND candidate_id=$3 FOR SHARE', [w, input.qualificationRunId, input.candidateId])).rows[0];
  if (!candidate || !run) return refused('not_found');
  if (!isLegacyCandidatePayload(candidate.payload)) return refused('candidate_format_not_supported');
  if (candidate.qualification_blocked) return refused('identity_review_required');
  if (candidate.status === 'dismissed' || candidate.revision !== input.expectedRevision || run.candidate_revision !== candidate.revision) return refused('candidate_changed');
  if (!['review', 'eligible', 'unavailable', 'admitted'].includes(run.state)) return refused('qualification_unfinished');
  const now = await officeNow(ctx);
  const personal = (await ctx.db.query('SELECT id FROM phone_routes WHERE workspace_id=$1 AND e164=$2 AND known_personal_cell_at IS NOT NULL FOR SHARE', [w, input.phone])).rows.length > 0;
  const assessment = assessCallingEvidence({candidate: candidate.payload, observations: run.observations, facts: run.facts, phone: input.phone, knownPersonalCell: personal, now});
  if (assessment.kind !== 'source_evidence_eligible') return refused(assessment.reason);
  const zone = sourcingTimeZone(candidate.payload.region, candidate.payload.locality);
  if (!zone) return refused('zone_unresolved');
  if ((await applicablePosture(ctx, candidate.payload.region, now)).decision.kind === 'refused') return refused('calling_state_not_enabled');
  if (!(await ctx.db.query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND role='admin' AND status='active' FOR SHARE", [w, owner])).rows.length) return refused('sourcing_owner_inactive');
  const exact = matches.filter(firm => firmNameKey(firm.name) === name && firm.website === candidate.payload.website
    && cityKey(firm.locality ?? '') === cityKey(candidate.payload.locality) && firm.region_code === candidate.payload.region);
  if (exact.length > 1 || (exact.length === 0 && matches.some(firm => websiteDomain(firm.website) === domain || (cityKey(firm.locality ?? '') === cityKey(candidate.payload.locality) && firm.region_code === candidate.payload.region)))) return refused('firm_identity_ambiguous');
  let firm = exact[0] ? await loadFirmForUpdate(ctx, exact[0].id) : null;
  if (firm && firm.status !== 'active') return refused('firm_unavailable');
  if (firm && firm.assigned_user_id !== owner) return refused('firm_assigned_elsewhere');
  if (await firstSuppressed(ctx, [{scope: 'handle', canonicalKey: input.phone}, ...(firm ? [{scope: 'firm' as const, canonicalKey: firm.id}] : [])], 'phone')) return refused('phone_or_firm_stopped');
  const other = (await ctx.db.query<{firm_id: string}>(`SELECT firm_id FROM phone_routes WHERE workspace_id=$1 AND e164=$2 AND retired_at IS NULL AND firm_id<>COALESCE($3::uuid,'00000000-0000-0000-0000-000000000000') LIMIT 1`, [w, input.phone, firm?.id ?? null])).rows[0];
  if (other) return refused('phone_association_ambiguous');
  if (firm && (await ctx.db.query('SELECT id FROM sequence_enrollments WHERE workspace_id=$1 AND firm_id=$2 AND ended_at IS NULL LIMIT 1', [w, firm.id])).rows.length) return refused('firm_already_enrolled');
  if ((await listApplicableHolds(ctx, {actionKind: 'dial_authorization', ...(firm ? {firmId: firm.id} : {}), ownerUserId: owner, channel: 'call'})).length) return refused('calling_held');
  if (!firm) {
    // Preserve the ordinary createFirm research behavior and its existing guards.
    const made = await createFirm(ctx, {name: candidate.payload.firmName, website: candidate.payload.website, locality: candidate.payload.locality, regionCode: candidate.payload.region, assignedUserId: owner});
    if (!made.ok) return refused(made.reason);
    firm = made.value;
  }
  const existing = (await ctx.db.query<{id: string; contact_id: string | null; e164: string; eligibility: string; version: number; retired_at: Date | null}>(`SELECT id,contact_id,e164,eligibility,version,retired_at FROM phone_routes WHERE workspace_id=$1 AND firm_id=$2 AND e164=$3 ORDER BY id LIMIT 1 FOR UPDATE`, [w, firm.id, input.phone])).rows[0];
  if (existing && (existing.retired_at || !['candidate', 'usable'].includes(existing.eligibility))) return refused('route_unavailable');
  if (existing && await firstSuppressed(ctx, await suppressionKeys(ctx, firm, existing, undefined), 'phone')) return refused('phone_or_firm_stopped');
  const phoneSource = assessment.audit.find(entry => entry.rule === 'phone_anywhere_first_party')!;
  const route = existing ? {ok: true as const, value: existing} : await addPhoneRoute(ctx, {firmId: firm.id, e164: input.phone, source: 'website', retrievedAt: new Date(phoneSource.retrievedAt)});
  if (!route.ok) return refused(route.reason);
  if (firm.time_zone === null) {
    const resolved = await resolveZoneForFirm(ctx, {firmId: firm.id, recordedZone: zone});
    if (!resolved.ok) return refused(resolved.reason);
  }
  const current = (await ctx.db.query<{version: number}>('SELECT version FROM phone_routes WHERE workspace_id=$1 AND id=$2 AND firm_id=$3 FOR SHARE', [w, route.value.id, firm.id])).rows[0];
  if (!current) return refused('route_unavailable');
  const recorded = await recordCallingAssessment(ctx, {parentKind: 'qualification_run', parentId: run.id, candidateId: input.candidateId, candidateRevision: input.expectedRevision}, {firmId: firm.id, routeId: route.value.id, routeVersion: current.version, e164: input.phone, at: await officeNow(ctx)});
  if (!recorded.ok) return recorded;
  await refreshTodayForFirm(ctx, {firmId: firm.id});
  return {ok: true, value: {...recorded.value, createdFirm: !exact[0]}};
}
