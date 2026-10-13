import type { IdentityEvidence, LinkedinRouteAssessment } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { activeIdentityActor, evidenceAvailable, lockIdentityContext, readIdentityPerson } from './identityAccess.ts';
import { normalizeIdentityEndpoint } from './endpoints.ts';
import { isTargetGeography, supportsResidentialManagement } from '../sourcing/qualificationPolicy.ts';
import { lockSendGateForDispatch } from '../policy/sendGate.ts';
import { isSuppressed } from '../suppression/effective.ts';

interface Claim {
  id: string; endpoint_id: string; value: string | null; person_id: string | null; firm_id: string | null;
  shared: boolean; status: string; revision: number; source_id: string; source_revision: number;
  source_hash: string; source_invalidated: boolean; start_date: string | null; end_date: string | null;
  [key: string]: unknown;
}
interface Relationship {
  id: string; person_id: string; firm_id: string; revision: number; status: string;
  source_id: string; source_revision: number; source_hash: string; source_invalidated: boolean;
  context_review: string; start_date: string | null; end_date: string | null;
  [key: string]: unknown;
}
const evidence = (row: Claim | Relationship): IdentityEvidence => ({ sourceId: row.source_id, sourceRevision: row.source_revision, contentHash: row.source_hash });
const unknownAuthority = { sendingPermission: false as const, connectionState: 'unknown' as const, maintenanceNeed: 'unknown' as const, buyingIntent: 'unknown' as const };
const held = (reason: string): LinkedinRouteAssessment => ({ state: 'held', reason, route: null, ...unknownAuthority });
const fold = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const uncertain = /\b(?:not|never|formerly|former|previously|might|maybe|guess|unverified|unknown|example|hypothetical|no longer|could|would)\b/iu;
const current = (row: Claim | Relationship, today: string) => row.status === 'current' && !row.source_invalidated && (row.start_date === null || row.start_date <= today) && (row.end_date === null || row.end_date >= today);
const claims = (context: RepositoryContext, endpointId: string) => context.db.query<Claim>(`SELECT c.*,e.value,c.start_date::text,c.end_date::text FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id WHERE c.workspace_id=$1 AND c.endpoint_id=$2 ORDER BY c.id LIMIT 101`, [context.scope.workspaceId, endpointId]);
const relationships = (context: RepositoryContext, personIds: string[]) => context.db.query<Relationship>(`SELECT r.*,r.start_date::text,r.end_date::text FROM crm_relationships r WHERE r.workspace_id=$1 AND r.person_id=ANY($2::uuid[]) ORDER BY r.id LIMIT 101`, [context.scope.workspaceId, personIds]);
const fingerprint = (rows: readonly (Claim | Relationship)[]) => JSON.stringify(rows.map(row => [row.id, row.revision, row.person_id, row.firm_id, row.source_id, row.source_revision, row.source_hash, row.source_invalidated, row.status, row.start_date, row.end_date, row.value, row.endpoint_id, row.context_review]));
async function excerpt(context: RepositoryContext, ref: IdentityEvidence): Promise<string | null> {
  if (!await evidenceAvailable(context, ref)) return null;
  return (await context.db.query<{ excerpt: string | null }>('SELECT excerpt FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, ref.sourceId])).rows[0]?.excerpt ?? null;
}

/** A fit read, never an action claim. All source/context closures are collected before row locks. */
export async function assessLinkedinRoute(context: RepositoryContext, input: { claimId: string }): Promise<LinkedinRouteAssessment | null> {
  await lockSendGateForDispatch(context);
  if (!await activeIdentityActor(context)) return null;
  const first = (await context.db.query<Claim>(`SELECT c.*,e.value FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id WHERE c.workspace_id=$1 AND c.id=$2 AND e.kind='linkedin'`, [context.scope.workspaceId, input.claimId])).rows[0];
  if (first === undefined) return null;
  const initialClaims = (await claims(context, first.endpoint_id)).rows;
  const personIds = initialClaims.flatMap(row => row.person_id === null ? [] : [row.person_id]);
  const initialRelationships = (await relationships(context, personIds)).rows;
  if (initialClaims.length > 100 || initialRelationships.length > 100) return held('identity_needs_review');
  if (!await lockIdentityContext(context, { personIds, firmIds: [...initialRelationships.map(row => row.firm_id), ...initialClaims.flatMap(row => row.firm_id === null ? [] : [row.firm_id])], sourceIds: [...initialClaims.map(row => row.source_id), ...initialRelationships.map(row => row.source_id)], requireActiveFirms: false })) return null;
  await context.db.query('SELECT id FROM crm_identity_endpoints WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, first.endpoint_id]);
  const liveClaims = (await claims(context, first.endpoint_id)).rows;
  const liveRelationships = (await relationships(context, personIds)).rows;
  if (fingerprint(initialClaims) !== fingerprint(liveClaims) || fingerprint(initialRelationships) !== fingerprint(liveRelationships)) return held('identity_changed');
  const claim = liveClaims.find(row => row.id === input.claimId);
  if (!claim || claim.value === null || claim.source_invalidated) return held('evidence_unavailable');
  if (claim.shared || claim.person_id === null) return held('shared_profile');
  const today = (await context.db.query<{ today: string }>(`SELECT (clock_timestamp() AT TIME ZONE business_time_zone)::date::text AS today FROM workspaces WHERE id=$1`, [context.scope.workspaceId])).rows[0]?.today;
  if (today === undefined || !current(claim, today)) return held('profile_not_current');
  if (liveClaims.filter(row => !row.source_invalidated).length !== 1) return held('duplicate_profile');
  const candidates = liveRelationships.filter(row => row.person_id === claim.person_id && current(row, today));
  if (candidates.length !== 1) return held('relationship_needs_review');
  const relation = candidates[0]!;
  if (relation.context_review !== 'current') return held('relationship_needs_review');
  const person = await readIdentityPerson(context, claim.person_id);
  const firm = (await context.db.query<{ name: string; locality: string | null; region_code: string | null; status: string; website: string | null }>('SELECT name,locality,region_code,status,website FROM firms WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, relation.firm_id])).rows[0];
  if (!person || !firm) return null;
  if (firm.status !== 'active') return held('firm_unavailable');
  const profileText = await excerpt(context, evidence(claim));
  const relationshipText = await excerpt(context, evidence(relation));
  if (profileText === null || relationshipText === null) return held('evidence_unavailable');
  // Only explicit named assertions in stored selected evidence are supported. Other prose stays reviewable.
  const lines = profileText.split(/\n/u).filter(line => !uncertain.test(line));
  const profileSupported = lines.some(line => fold(line).includes(fold(person.fullName)) && [...line.matchAll(/https:\/\/(?:www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?/gu)].some(match => normalizeIdentityEndpoint('linkedin', match[0]) === claim.value));
  const association = relationshipText.split(/\n/u).find(line => !uncertain.test(line) && fold(line).includes(fold(person.fullName)) && fold(line).includes(fold(firm.name)) && /\b(?:owner|founder|president|principal|partner|director|property manager|operations manager)\b/iu.test(line));
  if (!profileSupported) return held('profile_identity_unsupported');
  if (association === undefined) return held('role_or_firm_unsupported');
  const role = association.match(/\b(?:owner|founder|president|principal|partner|director|property manager|operations manager)\b/iu)?.[0] ?? '';
  if (!isTargetGeography(firm.region_code ?? '', firm.locality ?? '')) return held('target_geography_unsupported');
  const fit = relationshipText.split(/\n/u).some(line => !uncertain.test(line) && fold(line).includes(fold(firm.name)) && supportsResidentialManagement(line) && /\b(?:independent|regional)\b/iu.test(line) && fold(line).includes(fold(firm.locality ?? '__unknown__')) && (fold(line).includes(({ RI: 'rhode island', MA: 'massachusetts', TX: 'texas' } as Record<string, string>)[firm.region_code ?? ''] ?? '__unknown__') || new RegExp(`\\b${firm.region_code?.toLowerCase()}\\b`, 'u').test(fold(line))));
  if (!fit) return held('firm_fit_unsupported');
  if (await isSuppressed(context, { scope: 'firm', canonicalKey: relation.firm_id }) || await isSuppressed(context, { scope: 'handle', canonicalKey: claim.value })) return held('person_or_firm_stopped');
  if (!await activeIdentityActor(context)) return null;
  return { state: 'eligible', reason: 'supported_fit', ...unknownAuthority, route: { routeId: claim.endpoint_id, claimId: claim.id, claimRevision: claim.revision, profile: claim.value, personId: claim.person_id, personName: person.fullName, firmId: relation.firm_id, firmName: firm.name, role, relationshipId: relation.id, relationshipRevision: relation.revision, evidence: evidence(claim), relationshipEvidence: evidence(relation) } };
}
