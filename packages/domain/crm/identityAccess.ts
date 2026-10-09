import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { QueryResultRowLike } from '../db/queryable.ts';
import type { IdentityEvidence } from '@fss/contracts';
interface Person extends QueryResultRowLike {
  id: string;
  owner_user_id: string | null;
  full_name: string;
  firm_id: string | null;
  assigned_user_id: string | null;
  contact_status: string | null;
  firm_status: string | null;
}
interface Source extends QueryResultRowLike {
  id: string;
  person_id: string | null;
  firm_id: string | null;
  owner_user_id: string;
  revision: number;
  availability: string;
  content_hash: string | null;
}
export async function activeIdentityActor(context: RepositoryContext): Promise<boolean> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return false;
  const { rows } = await context.db.query<{
    role: string;
    status: string;
  }>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [context.scope.workspaceId, actor.userId]);
  return rows[0]?.status === 'active' && rows[0]?.role === actor.role;
}
/** Exact live revision, or the last explicit version for content-free restoration identity. */
export function sourceContextPredicate(alias = 's', contextAlias = 'cx'): string {
  return `${contextAlias}.workspace_id=${alias}.workspace_id AND ${contextAlias}.source_id=${alias}.id AND ${contextAlias}.source_revision=CASE WHEN ${alias}.availability='available' THEN ${alias}.revision ELSE (SELECT max(px.source_revision) FROM crm_source_relationship_contexts px WHERE px.workspace_id=${alias}.workspace_id AND px.source_id=${alias}.id AND px.source_revision<${alias}.revision) END AND (${alias}.availability<>'available' OR ${contextAlias}.source_hash=${alias}.content_hash)`;
}
export async function hasExplicitSourceContext(context: RepositoryContext, sourceId: string): Promise<boolean> {
  return (await context.db.query(`SELECT 1 FROM crm_selected_sources s JOIN crm_source_relationship_contexts cx ON ${sourceContextPredicate()} WHERE s.workspace_id=$1 AND s.id=$2 LIMIT 1`, [context.scope.workspaceId, sourceId])).rows.length === 1;
}
/** Trusted SQL fragment: current-version explicit snapshots replace only the source's legacy default. */
export function sourceAccessPredicate(adminParameter: string, actorParameter: string, alias = 's'): string {
  const exact = sourceContextPredicate(alias);
  return `(${adminParameter}::boolean OR (${alias}.owner_user_id=${actorParameter} AND (${alias}.firm_id IS NULL OR EXISTS(SELECT 1 FROM firms af WHERE af.workspace_id=${alias}.workspace_id AND af.id=${alias}.firm_id AND af.assigned_user_id=${actorParameter} AND af.status='active')) AND CASE
 WHEN EXISTS(SELECT 1 FROM crm_source_relationship_contexts cx WHERE ${exact})
 THEN NOT EXISTS(SELECT 1 FROM crm_source_relationship_contexts cx JOIN firms xf ON xf.workspace_id=cx.workspace_id AND xf.id=cx.firm_id WHERE ${exact} AND (xf.assigned_user_id IS DISTINCT FROM ${actorParameter} OR xf.status<>'active'))
 WHEN ${alias}.firm_id IS NOT NULL THEN EXISTS(SELECT 1 FROM firms sf WHERE sf.workspace_id=${alias}.workspace_id AND sf.id=${alias}.firm_id AND sf.assigned_user_id=${actorParameter} AND sf.status='active')
 ELSE EXISTS(SELECT 1 FROM crm_people sp LEFT JOIN crm_legacy_contact_people sb ON sb.workspace_id=sp.workspace_id AND sb.person_id=sp.id LEFT JOIN contacts sc ON sc.workspace_id=sb.workspace_id AND sc.id=sb.contact_id LEFT JOIN firms sf ON sf.workspace_id=sc.workspace_id AND sf.id=sc.firm_id WHERE sp.workspace_id=${alias}.workspace_id AND sp.id=${alias}.person_id AND CASE WHEN sb.contact_id IS NULL THEN sp.owner_user_id=${actorParameter} ELSE sc.status='active' AND sf.status='active' AND sf.assigned_user_id=${actorParameter} END)
 END))`;
}
async function people(context: RepositoryContext, ids: readonly string[]): Promise<Person[]> {
  return (await context.db.query<Person>(`SELECT p.id,p.owner_user_id,p.full_name,c.firm_id,c.status AS contact_status,f.status AS firm_status,f.assigned_user_id FROM crm_people p LEFT JOIN crm_legacy_contact_people b ON b.workspace_id=p.workspace_id AND b.person_id=p.id LEFT JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id LEFT JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE p.workspace_id=$1 AND p.id=ANY($2::uuid[])`, [context.scope.workspaceId, ids])).rows;
}
function defaultPersonAccess(context: RepositoryContext, person: Person): boolean {
  const actor = context.scope.actor;
  return actor.kind === 'user' && (actor.role === 'admin' || (person.firm_id === null ? person.owner_user_id === actor.userId : person.contact_status === 'active' && person.firm_status === 'active' && person.assigned_user_id === actor.userId));
}
export async function sourceVisible(context: RepositoryContext, sourceId: string): Promise<boolean> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return false;
  return (await context.db.query(`SELECT 1 FROM crm_selected_sources s WHERE s.workspace_id=$1 AND s.id=$2 AND ${sourceAccessPredicate('$3', '$4')}`, [context.scope.workspaceId, sourceId, actor.role === 'admin', actor.userId])).rows.length === 1;
}
async function identityProof(context: RepositoryContext, person: Person): Promise<Source | null> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return null;
  return (await context.db.query<Source>(`SELECT s.id,s.person_id,s.firm_id,s.owner_user_id,s.revision,s.availability,s.content_hash FROM crm_selected_sources s WHERE s.workspace_id=$1 AND s.person_id=$2 AND EXISTS(SELECT 1 FROM crm_source_relationship_contexts cx WHERE ${sourceContextPredicate()}) AND ${sourceAccessPredicate('$3', '$4')} ORDER BY s.id LIMIT 1`, [context.scope.workspaceId, person.id, actor.role === 'admin', actor.userId])).rows[0] ?? null;
}
async function contextFirms(context: RepositoryContext, source: Source, persons: readonly Person[]): Promise<string[] | null> {
  const { rows } = await context.db.query<{
    firm_id: string;
  }>(`SELECT DISTINCT cx.firm_id FROM crm_selected_sources s JOIN crm_source_relationship_contexts cx ON ${sourceContextPredicate()} WHERE s.workspace_id=$1 AND s.id=$2 ORDER BY cx.firm_id LIMIT 101`, [context.scope.workspaceId, source.id]);
  if (rows.length > 100)
    return null;
  if (rows.length > 0)
    return [...new Set([...rows.map(row => row.firm_id), ...(source.firm_id === null ? [] : [source.firm_id])])].sort();
  const fallback = source.firm_id ?? persons.find(person => person.id === source.person_id)?.firm_id ?? null;
  return fallback === null ? [] : [fallback];
}
/** Collect every context firm before person/source locks; any context drift fails closed. */
export async function lockIdentityContext(context: RepositoryContext, input: {
  personIds?: readonly string[];
  firmIds?: readonly string[];
  sourceIds?: readonly string[];
  requireActiveFirms?: boolean;
}): Promise<boolean> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return false;
  const supplied = [...new Set(input.sourceIds ?? [])].sort();
  const initialSources = (await context.db.query<Source>('SELECT id,person_id,firm_id,owner_user_id,revision,availability,content_hash FROM crm_selected_sources WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [context.scope.workspaceId, supplied])).rows;
  if (initialSources.length !== supplied.length)
    return false;
  const personIds = [...new Set([...(input.personIds ?? []), ...initialSources.flatMap(source => source.person_id === null ? [] : [source.person_id])])].sort();
  const initialPeople = await people(context, personIds);
  if (initialPeople.length !== personIds.length)
    return false;
  const sources = [...initialSources];
  const defaultFirms: string[] = [];
  for (const person of initialPeople) {
    if (defaultPersonAccess(context, person)) {
      if (person.firm_id !== null && !(initialSources.some(source => source.person_id === person.id)))
        defaultFirms.push(person.firm_id);
      continue;
    }
    const proof = await identityProof(context, person);
    if (proof === null)
      return false;
    if (!sources.some(source => source.id === proof.id))
      sources.push(proof);
  }
  const sourceContexts = new Map<string, string[]>();
  for (const source of sources) {
    const firms = await contextFirms(context, source, initialPeople);
    if (firms === null)
      return false;
    sourceContexts.set(source.id, firms);
  }
  const firmIds = [...new Set([...(input.firmIds ?? []), ...defaultFirms, ...[...sourceContexts.values()].flat()])].sort();
  for (const firmId of firmIds) {
    const firm = (await context.db.query<{
      assigned_user_id: string | null;
      status: string;
    }>('SELECT assigned_user_id,status FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, firmId])).rows[0];
    if (firm === undefined || actor.role !== 'admin' && firm.assigned_user_id !== actor.userId)
      return false;
    if (input.requireActiveFirms !== false && (input.firmIds ?? []).includes(firmId) && firm.status !== 'active')
      return false;
  }
  for (const personId of personIds)
    await context.db.query('SELECT id FROM crm_people WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, personId]);
  const currentPeople = await people(context, personIds);
  if (currentPeople.some(person => person.firm_id !== initialPeople.find(initial => initial.id === person.id)?.firm_id))
    return false;
  for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id)))
    await context.db.query('SELECT id FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, source.id]);
  for (const original of sources) {
    const current = (await context.db.query<Source>('SELECT id,person_id,firm_id,owner_user_id,revision,availability,content_hash FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, original.id])).rows[0];
    if (current === undefined || current.person_id !== original.person_id || current.firm_id !== original.firm_id || current.revision !== original.revision || current.content_hash !== original.content_hash)
      return false;
    const firms = await contextFirms(context, current, currentPeople);
    if (firms === null || JSON.stringify(firms) !== JSON.stringify(sourceContexts.get(current.id)))
      return false;
    if (!await sourceVisible(context, current.id))
      return false;
  }
  for (const person of currentPeople)
    if (!defaultPersonAccess(context, person) && await identityProof(context, person) === null)
      return false;
  return activeIdentityActor(context);
}
export async function evidenceAvailable(context: RepositoryContext, evidence: IdentityEvidence): Promise<boolean> {
  const source = (await context.db.query<Source>('SELECT id,person_id,firm_id,owner_user_id,revision,availability,content_hash FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, evidence.sourceId])).rows[0];
  return source !== undefined && await sourceVisible(context, source.id) && source.availability === 'available' && source.revision === evidence.sourceRevision && source.content_hash === evidence.contentHash;
}
export async function readIdentityPerson(context: RepositoryContext, personId: string): Promise<{
  fullName: string;
  legacyFirmVisible: boolean;
} | null> {
  const row = (await people(context, [personId]))[0];
  if (row === undefined)
    return null;
  const direct = defaultPersonAccess(context, row);
  return direct || await identityProof(context, row) !== null ? { fullName: row.full_name, legacyFirmVisible: direct } : null;
}
