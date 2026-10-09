import { createHash } from 'node:crypto';
import type { PersonPage } from '@fss/contracts';
import { recordCrmAuditEvent } from './audit.ts';
import type { QueryResultRowLike } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
interface PersonRow extends QueryResultRowLike {
  id: string;
  full_name: string;
  owner_user_id: string | null;
  revision: number;
  contact_id: string | null;
  contact_status: string | null;
  firm_id: string | null;
  firm_name: string | null;
  assigned_user_id: string | null;
}
const columns = `p.id,p.full_name,p.owner_user_id,p.revision,b.contact_id,c.status AS contact_status,c.firm_id,f.name AS firm_name,f.assigned_user_id`;
async function load(context: RepositoryContext, personId: string, lock = false): Promise<PersonRow | null> {
  const relation = lock ? await load(context, personId) : null;
  if (lock) {
    if (relation?.firm_id !== null && relation?.firm_id !== undefined)
      await context.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, relation.firm_id]);
  }
  const { rows } = await context.db.query<PersonRow>(`SELECT ${columns} FROM crm_people p LEFT JOIN crm_legacy_contact_people b ON b.workspace_id=p.workspace_id AND b.person_id=p.id LEFT JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id LEFT JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE p.workspace_id=$1 AND p.id=$2 ${lock ? 'FOR UPDATE OF p' : ''}`, [context.scope.workspaceId, personId]);
  const row = rows[0] ?? null;
  return lock && row?.firm_id !== relation?.firm_id ? null : row;
}
async function currentMembership(context: RepositoryContext): Promise<boolean> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return false;
  const membership = await context.db.query<{
    status: string;
    role: string;
  }>('SELECT status,role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2', [context.scope.workspaceId, actor.userId]);
  return membership.rows[0]?.status === 'active' && membership.rows[0]?.role === actor.role;
}
function allowed(context: RepositoryContext, row: PersonRow): boolean {
  const actor = context.scope.actor;
  return actor.kind === 'user' && (actor.role === 'admin' || (row.contact_id === null ? row.owner_user_id === actor.userId : row.assigned_user_id === actor.userId));
}
function dto(row: PersonRow): PersonPage['person'] {
  return { personId: row.id, fullName: row.full_name, firm: row.firm_id === null ? null : { firmId: row.firm_id, name: row.firm_name ?? '' }, revision: row.revision };
}
export async function createPerson(context: RepositoryContext, fullName: string) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || !await currentMembership(context))
    return { ok: false as const, reason: 'person_access_denied' };
  const { rows } = await context.db.query<{
    id: string;
  }>('INSERT INTO crm_people(workspace_id,owner_user_id,full_name) VALUES($1,$2,$3) RETURNING id', [context.scope.workspaceId, actor.userId, fullName]);
  return { ok: true as const, value: { personId: rows[0]?.id } };
}
export async function addSelectedSource(context: RepositoryContext, input: {
  personId: string;
  sourceKey: string;
  excerpt: string;
  occurredAt: string;
}) {
  const row = await load(context, input.personId, true);
  if (row === null || !await currentMembership(context) || !allowed(context, row) || (row.contact_id !== null && row.contact_status !== 'active') || context.scope.actor.kind !== 'user')
    return { ok: false as const, reason: 'person_access_denied' };
  const sourceKeyHash = createHash('sha256').update(input.sourceKey).digest('hex');
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${context.scope.workspaceId}:${context.scope.actor.userId}:${sourceKeyHash}`]);
  const previous = await context.db.query<{
    id: string;
    availability: string;
    person_id: string;
    content_hash: string | null;
    occurred_at: Date | null;
  }>('SELECT id,availability,person_id,content_hash,occurred_at FROM crm_selected_sources WHERE workspace_id=$1 AND owner_user_id=$2 AND source_key_hash=$3 FOR UPDATE', [context.scope.workspaceId, context.scope.actor.userId, sourceKeyHash]);
  if (!await currentMembership(context))
    return { ok: false as const, reason: 'person_access_denied' };
  const existing = previous.rows[0];
  const contentHash = createHash('sha256').update(input.excerpt).digest('hex');
  if (existing !== undefined) {
    if (existing.person_id !== input.personId)
      return { ok: false as const, reason: 'source_identity_conflict' };
    if (existing.availability === 'deleted')
      return { ok: false as const, reason: 'source_deleted' };
    if (existing.availability === 'available')
      return existing.content_hash === contentHash && existing.occurred_at?.toISOString() === new Date(input.occurredAt).toISOString() ? { ok: true as const, value: { sourceId: existing.id } } : { ok: false as const, reason: 'source_identity_conflict' };
    await context.db.query(`UPDATE crm_selected_sources SET availability='available',excerpt=$3,content_hash=$4,occurred_at=$5,observed_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, existing.id, input.excerpt, contentHash, input.occurredAt]);
    return { ok: true as const, value: { sourceId: existing.id } };
  }
  const { rows } = await context.db.query<{
    id: string;
  }>(`INSERT INTO crm_selected_sources(workspace_id,person_id,owner_user_id,source_key_hash,excerpt,content_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [context.scope.workspaceId, input.personId, context.scope.actor.userId, sourceKeyHash, input.excerpt, contentHash, input.occurredAt]);
  // Receipts contain identifiers only: deleted source text cannot leak through replay.
  return { ok: true as const, value: { sourceId: rows[0]?.id } };
}
interface SourceRow extends QueryResultRowLike {
  id: string;
  revision: number;
  content_hash: string | null;
  excerpt: string | null;
  occurred_at: Date | null;
  observed_at: Date;
  availability: 'available' | 'deleted' | 'awaiting_recapture';
}
export async function readPerson(context: RepositoryContext, personId: string, paging: {
  afterSourceId?: string | undefined;
  limit?: number | undefined;
} = {}): Promise<PersonPage | null> {
  const row = await load(context, personId, true);
  if (row === null || !await currentMembership(context) || !allowed(context, row))
    return null;
  const limit = paging.limit ?? 50;
  const { rows } = await context.db.query<SourceRow>('SELECT id,revision,content_hash,excerpt,occurred_at,observed_at,availability FROM crm_selected_sources WHERE workspace_id=$1 AND person_id=$2 AND ($3::uuid IS NULL OR owner_user_id=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5', [context.scope.workspaceId, personId, context.scope.actor.kind === 'user' && context.scope.actor.role !== 'admin' ? context.scope.actor.userId : null, paging.afterSourceId ?? null, limit + 1]);
  if (!await currentMembership(context))
    return null;
  if (context.scope.actor.kind === 'user' && context.scope.actor.role === 'admin')
    await recordCrmAuditEvent(context, { action: 'crm.person_source_read', subjectKind: 'person', subjectId: personId });
  return { person: dto(row), nextAfterSourceId: rows.length > limit ? rows[limit - 1]?.id ?? null : null, sources: rows.slice(0, limit).map(source => ({ workspaceId: context.scope.workspaceId, sourceId: source.id, kind: 'selected_note', revision: source.revision, contentHash: source.content_hash, locator: source.availability === 'available' ? 'selected_excerpt' : null, speaker: null, occurredAt: source.occurred_at?.toISOString() ?? null, observedAt: source.observed_at.toISOString(), completeness: source.availability === 'available' ? 'selected_excerpt' : 'unavailable', availability: source.availability, excerpt: source.excerpt })) };
}
export async function changeSelectedSource(context: RepositoryContext, input: {
  personId: string;
  sourceId: string;
  expectedRevision: number;
}, action: 'delete' | 'restore') {
  const person = await load(context, input.personId, true);
  if (person === null || !await currentMembership(context) || !allowed(context, person) || (person.contact_id !== null && person.contact_status !== 'active') || context.scope.actor.kind !== 'user')
    return { ok: false as const, reason: 'person_access_denied' };
  const { rows } = await context.db.query<{
    revision: number;
    owner_user_id: string;
    availability: string;
  }>('SELECT revision,owner_user_id,availability FROM crm_selected_sources WHERE workspace_id=$1 AND person_id=$2 AND id=$3 FOR UPDATE', [context.scope.workspaceId, input.personId, input.sourceId]);
  const source = rows[0];
  if (source === undefined || (context.scope.actor.role !== 'admin' && source.owner_user_id !== context.scope.actor.userId))
    return { ok: false as const, reason: 'source_access_denied' };
  if (source.revision !== input.expectedRevision)
    return { ok: false as const, reason: 'source_revision_changed' };
  if (action === 'restore' && source.availability !== 'deleted')
    return { ok: false as const, reason: 'source_not_deleted' };
  await context.db.query(`UPDATE crm_selected_sources SET availability=$3,excerpt=NULL,content_hash=NULL,occurred_at=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, input.sourceId, action === 'delete' ? 'deleted' : 'awaiting_recapture']);
  return { ok: true as const, value: { sourceId: input.sourceId, revision: source.revision + 1 } };
}
/** Bounded explicit bridge. Equal labels never merge people; operational rows are untouched. */
export async function bridgeLegacyContacts(context: RepositoryContext, contactIds: readonly string[]) {
  const people: {
    personId: string;
    contactId: string;
  }[] = [];
  const ids = [...new Set(contactIds)].sort();
  const initial = await context.db.query<{
    firm_id: string;
  }>('SELECT firm_id FROM contacts WHERE workspace_id=$1 AND id=ANY($2::uuid[])', [context.scope.workspaceId, ids]);
  const firmIds = [...new Set(initial.rows.map(row => row.firm_id))].sort();
  for (const firmId of firmIds)
    await context.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, firmId]);
  const contacts: {
    contactId: string;
    full_name: string;
    assigned_user_id: string | null;
  }[] = [];
  for (const contactId of ids) {
    const { rows } = await context.db.query<{
      full_name: string;
      status: string;
      assigned_user_id: string | null;
      firm_id: string;
    }>('SELECT c.full_name,c.status,c.firm_id,f.assigned_user_id FROM contacts c JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE c.workspace_id=$1 AND c.id=$2 FOR UPDATE OF c', [context.scope.workspaceId, contactId]);
    const contact = rows[0];
    const actor = context.scope.actor;
    if (contact === undefined || !firmIds.includes(contact.firm_id) || contact.status !== 'active' || actor.kind !== 'user' || (actor.role !== 'admin' && contact.assigned_user_id !== actor.userId))
      return { ok: false as const, reason: 'person_access_denied' };
    contacts.push({ contactId, ...contact });
  }
  if (!await currentMembership(context))
    return { ok: false as const, reason: 'person_access_denied' };
  for (const contact of contacts) {
    const contactId = contact.contactId;
    await context.db.query('INSERT INTO crm_people(workspace_id,id,owner_user_id,full_name) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO NOTHING', [context.scope.workspaceId, contactId, contact.assigned_user_id, contact.full_name]);
    await context.db.query('INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,$2) ON CONFLICT(workspace_id,contact_id) DO NOTHING', [context.scope.workspaceId, contactId]);
    people.push({ personId: contactId, contactId });
  }
  return { ok: true as const, value: { people } };
}
export async function listPeople(context: RepositoryContext, input: {
  afterId?: string | undefined;
  limit: number;
}) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return { people: [], nextAfterId: null };
  const { rows } = await context.db.query<PersonRow>(`SELECT ${columns} FROM crm_people p LEFT JOIN crm_legacy_contact_people b ON b.workspace_id=p.workspace_id AND b.person_id=p.id LEFT JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id LEFT JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE p.workspace_id=$1 AND ($2::uuid IS NULL OR p.id>$2) AND ($3::boolean OR CASE WHEN b.contact_id IS NULL THEN p.owner_user_id=$4 ELSE f.assigned_user_id=$4 END) ORDER BY p.id LIMIT $5`, [context.scope.workspaceId, input.afterId ?? null, actor.role === 'admin', actor.userId, input.limit + 1]);
  if (!await currentMembership(context))
    return { people: [], nextAfterId: null };
  return { people: rows.slice(0, input.limit).map(dto), nextAfterId: rows.length > input.limit ? rows[input.limit - 1]?.id ?? null : null };
}
export async function recaptureSelectedSource(context: RepositoryContext, input: {
  personId: string;
  sourceId: string;
  expectedRevision: number;
  excerpt: string;
  occurredAt: string;
}) {
  const person = await load(context, input.personId, true);
  if (person === null || !await currentMembership(context) || !allowed(context, person) || (person.contact_id !== null && person.contact_status !== 'active') || context.scope.actor.kind !== 'user')
    return { ok: false as const, reason: 'person_access_denied' };
  const { rows } = await context.db.query<{
    revision: number;
    owner_user_id: string;
    availability: string;
  }>('SELECT revision,owner_user_id,availability FROM crm_selected_sources WHERE workspace_id=$1 AND person_id=$2 AND id=$3 FOR UPDATE', [context.scope.workspaceId, input.personId, input.sourceId]);
  const source = rows[0];
  if (source === undefined || (context.scope.actor.role !== 'admin' && source.owner_user_id !== context.scope.actor.userId))
    return { ok: false as const, reason: 'source_access_denied' };
  if (source.availability !== 'awaiting_recapture')
    return { ok: false as const, reason: 'source_not_restored' };
  if (source.revision !== input.expectedRevision)
    return { ok: false as const, reason: 'source_revision_changed' };
  await context.db.query(`UPDATE crm_selected_sources SET availability='available',excerpt=$3,content_hash=$4,occurred_at=$5,observed_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, input.sourceId, input.excerpt, createHash('sha256').update(input.excerpt).digest('hex'), input.occurredAt]);
  return { ok: true as const, value: { sourceId: input.sourceId, revision: source.revision + 1 } };
}
