import type { IdentityEvidence, LinkedinRouteAssessment } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { activeIdentityActor, evidenceAvailable, lockIdentityContext, readIdentityPerson, sourceVisible } from './identityAccess.ts';
import { normalizeIdentityEndpoint } from './endpoints.ts';
import { isTargetGeography, supportsResidentialManagement } from '../sourcing/qualificationPolicy.ts';
import { lockSendGateForDispatch } from '../policy/sendGate.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { firmNameKey, websiteDomain } from './import.ts';
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
const uncertain = /\b(?:not|never|formerly|former|previously|might|maybe|guess|unverified|unknown|example|hypothetical|no longer|could|would)\b/iu;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const roles = 'owner|founder|president|principal|partner|director|property manager|operations manager';
function supportedProfile(text: string, name: string, profile: string): boolean {
  const assertion = new RegExp(`(?:^|[.!?]\\s+)${escape(name)}['’]s LinkedIn profile (?:is\\s+|:\\s*)(https:\\/\\/[^\\s<>"']+)`, 'giu');
  return text.split(/\n/u).filter(line => !uncertain.test(line)).some(line => [...line.matchAll(assertion)].some(match => normalizeIdentityEndpoint('linkedin', (match[1] ?? '').replace(/[.,)]$/u, '')) === profile));
}
function supportedRole(text: string, name: string, firm: string): string | null {
  const assertion = new RegExp(`(?:^|[.!?]\\s+)${escape(name)} (?:is (?:the |a )?|, ?)(?<role>${roles}) (?:of|at|for) ${escape(firm)}(?:[.,]|$)`, 'iu');
  for (const line of text.split(/\n/u)) {
    if (!uncertain.test(line)) {
      const role = assertion.exec(line)?.groups?.['role'];
      if (role !== undefined) return role.toLowerCase();
    }
  }
  return null;
}
function supportedFirmFit(text: string, firm: { name: string; locality: string | null; region_code: string | null }): boolean {
  if (firm.locality === null || firm.region_code === null) return false;
  const region = ({ RI: 'Rhode Island', MA: 'Massachusetts', TX: 'Texas' } as Record<string, string>)[firm.region_code];
  if (region === undefined) return false;
  const assertion = new RegExp(`(?:^|[.!?]\\s+)${escape(firm.name)} is (?:an? |the )?(?:independent|regional)(?: and (?:independent|regional))? residential property management (?:firm|company|business) (?:serving|based in) ${escape(firm.locality)},? (?:${escape(region)}|${escape(firm.region_code)})(?:[.!?]|$)`, 'iu');
  return text.split(/\n/u).some(line => !uncertain.test(line) && supportsResidentialManagement(line) && assertion.test(line));
}
const current = (row: Claim | Relationship, today: string) => row.status === 'current' && !row.source_invalidated && (row.start_date === null || row.start_date <= today) && (row.end_date === null || row.end_date >= today);
const claims = (context: RepositoryContext, endpointId: string) => context.db.query<Claim>(`SELECT c.*,e.value,c.start_date::text,c.end_date::text FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id WHERE c.workspace_id=$1 AND c.endpoint_id=$2 ORDER BY c.id LIMIT 101`, [context.scope.workspaceId, endpointId]);
const relationships = (context: RepositoryContext, personIds: string[]) => context.db.query<Relationship>(`SELECT r.*,r.start_date::text,r.end_date::text FROM crm_relationships r WHERE r.workspace_id=$1 AND r.person_id=ANY($2::uuid[]) ORDER BY r.id LIMIT 101`, [context.scope.workspaceId, personIds]);
const fingerprint = (rows: readonly (Claim | Relationship)[]) => JSON.stringify(rows.map(row => [row.id, row.revision, row.person_id, row.firm_id, row.source_id, row.source_revision, row.source_hash, row.source_invalidated, row.status, row.start_date, row.end_date, row.value, row.endpoint_id, row.context_review]));
async function excerpt(context: RepositoryContext, ref: IdentityEvidence): Promise<string | null> {
  if (!await evidenceAvailable(context, ref)) return null;
  return (await context.db.query<{ excerpt: string | null }>('SELECT excerpt FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, ref.sourceId])).rows[0]?.excerpt ?? null;
}

async function sourceBindsPerson(context: RepositoryContext, sourceId: string, personId: string, firmId: string): Promise<boolean> {
  const row = (await context.db.query<{ person_id: string | null; firm_id: string | null }>('SELECT person_id,firm_id FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, sourceId])).rows[0];
  if (row?.person_id !== null) return row?.person_id === personId;
  if (row?.firm_id !== firmId) return false;
  return (await context.db.query(`SELECT 1 FROM crm_source_relationship_contexts cx JOIN crm_selected_sources s ON s.workspace_id=cx.workspace_id AND s.id=cx.source_id WHERE cx.workspace_id=$1 AND cx.source_id=$2 AND cx.person_id=$3 AND cx.firm_id=$4 AND cx.source_revision=s.revision AND cx.source_hash=s.content_hash AND cx.review='current' LIMIT 1`, [context.scope.workspaceId, sourceId, personId, firmId])).rows.length === 1;
}

/** A fit read, never an action claim. All source/context closures are collected before row locks. */
export async function assessLinkedinRoute(context: RepositoryContext, input: { claimId: string }): Promise<LinkedinRouteAssessment | null> {
  await lockSendGateForDispatch(context);
  if (!await activeIdentityActor(context)) return null;
  const first = (await context.db.query<Claim>(`SELECT c.*,e.value FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id WHERE c.workspace_id=$1 AND c.id=$2 AND e.kind='linkedin'`, [context.scope.workspaceId, input.claimId])).rows[0];
  if (first === undefined || !await sourceVisible(context, first.source_id) || (first.person_id !== null && await readIdentityPerson(context, first.person_id) === null)) return null;
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
  if (!await sourceBindsPerson(context, claim.source_id, claim.person_id, relation.firm_id)) return held('profile_identity_unsupported');
  if (!await sourceBindsPerson(context, relation.source_id, claim.person_id, relation.firm_id)) return held('role_or_firm_unsupported');
  const duplicateFirm = await context.db.query(`SELECT id FROM firms WHERE workspace_id=$1 AND id<>$2 AND status='active' AND ((lower(regexp_replace(trim(name),'\\s+',' ','g'))=$3 AND lower(locality)=$4 AND region_code=$5) OR ($6::text IS NOT NULL AND regexp_replace(lower(split_part(website,'/',3)),'^www\\.','')=$6)) LIMIT 1`, [context.scope.workspaceId, relation.firm_id, firmNameKey(firm.name), firm.locality?.toLowerCase() ?? null, firm.region_code, websiteDomain(firm.website)]);
  if (duplicateFirm.rows.length > 0) return held('firm_identity_ambiguous');
  const profileText = await excerpt(context, evidence(claim));
  const relationshipText = await excerpt(context, evidence(relation));
  if (profileText === null || relationshipText === null) return held('evidence_unavailable');
  // Only explicit named assertions in stored selected evidence are supported. Other prose stays reviewable.
  const role = supportedRole(relationshipText, person.fullName, firm.name);
  if (!supportedProfile(profileText, person.fullName, claim.value)) return held('profile_identity_unsupported');
  if (role === null) return held('role_or_firm_unsupported');
  if (!isTargetGeography(firm.region_code ?? '', firm.locality ?? '')) return held('target_geography_unsupported');
  const fit = supportedFirmFit(relationshipText, firm);
  if (!fit) return held('firm_fit_unsupported');
  const stops = (await context.db.query<{ scope: string }>(`WITH RECURSIVE lineage(id) AS (SELECT $3::uuid UNION SELECT f.id FROM firms f JOIN lineage l ON f.merged_into_firm_id=l.id WHERE f.workspace_id=$1 AND f.status='merged') SELECT scope FROM linkedin_route_refusals WHERE workspace_id=$1 AND ((scope='person' AND (person_id=$2 OR endpoint_id=$4)) OR (scope IN ('firm','ambiguous') AND firm_id IN (SELECT id FROM lineage))) ORDER BY recorded_at,id`, [context.scope.workspaceId, claim.person_id, relation.firm_id, claim.endpoint_id])).rows;
  if (stops.some(stop => stop.scope === 'ambiguous')) return held('refusal_scope_needs_review');
  if (stops.length > 0) return held('person_or_firm_stopped');
  const suppressed = await context.db.query(`WITH RECURSIVE lineage(id) AS (SELECT $3::uuid UNION SELECT f.id FROM firms f JOIN lineage l ON f.merged_into_firm_id=l.id WHERE f.workspace_id=$1 AND f.status='merged'), handles(value) AS (
    SELECT e.value FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id JOIN crm_selected_sources s ON s.workspace_id=c.workspace_id AND s.id=c.source_id WHERE c.workspace_id=$1 AND c.person_id=$2 AND c.status='current' AND NOT c.shared AND NOT c.source_invalidated AND s.availability='available' AND s.revision=c.source_revision AND s.content_hash=c.source_hash AND (c.start_date IS NULL OR c.start_date<=$4::date) AND (c.end_date IS NULL OR c.end_date>=$4::date)
    UNION SELECT a.address FROM crm_legacy_contact_people b JOIN email_addresses a ON a.workspace_id=b.workspace_id AND a.contact_id=b.contact_id WHERE b.workspace_id=$1 AND b.person_id=$2
    UNION SELECT p.e164 FROM crm_legacy_contact_people b JOIN phone_routes p ON p.workspace_id=b.workspace_id AND p.contact_id=b.contact_id WHERE b.workspace_id=$1 AND b.person_id=$2
  ) SELECT event_id FROM effective_suppressions WHERE workspace_id=$1 AND ((scope='firm' AND canonical_key IN (SELECT id::text FROM lineage)) OR (scope='handle' AND canonical_key IN (SELECT lower(value) FROM handles))) LIMIT 1`, [context.scope.workspaceId, claim.person_id, relation.firm_id, today]);
  if (suppressed.rows.length > 0 || await isSuppressed(context, { scope: 'handle', canonicalKey: claim.value })) return held('person_or_firm_stopped');
  if (!await activeIdentityActor(context)) return null;
  if (context.scope.actor.kind === 'user' && context.scope.actor.role === 'admin') {
    for (const sourceId of [...new Set([claim.source_id, relation.source_id])].sort()) {
      const owner = (await context.db.query<{ owner_user_id: string }>('SELECT owner_user_id FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, sourceId])).rows[0];
      if (owner?.owner_user_id !== context.scope.actor.userId) await recordCrmAuditEvent(context, { action: 'crm.linkedin_private_evidence_read', subjectKind: 'selected_source', subjectId: sourceId, detail: { claimId: claim.id, claimRevision: claim.revision, relationshipId: relation.id, relationshipRevision: relation.revision } });
    }
  }
  return { state: 'eligible', reason: 'supported_fit', ...unknownAuthority, route: { routeId: claim.endpoint_id, claimId: claim.id, claimRevision: claim.revision, profile: claim.value, personId: claim.person_id, personName: person.fullName, firmId: relation.firm_id, firmName: firm.name, role, relationshipId: relation.id, relationshipRevision: relation.revision, evidence: evidence(claim), relationshipEvidence: evidence(relation) } };
}
