import type { RepositoryContext } from '../db/workspaceScope.ts';
/** Body-free projection invalidation in the caller's source-deletion transaction. */
export async function invalidateSelectedIdentitySources(context: RepositoryContext, sourceIds: readonly string[]) {
  const values = [context.scope.workspaceId, [...new Set(sourceIds)].sort()];
  const endpoints = (await context.db.query<{
    endpoint_id: string;
  }>('SELECT DISTINCT endpoint_id FROM crm_endpoint_claims WHERE workspace_id=$1 AND source_id=ANY($2::uuid[]) ORDER BY endpoint_id', values)).rows;
  for (const endpoint of endpoints)
    await context.db.query('SELECT id FROM crm_identity_endpoints WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, endpoint.endpoint_id]);
  const affectedRelationships = (await context.db.query<{
    id: string;
  }>('SELECT id FROM crm_relationships WHERE workspace_id=$1 AND source_id=ANY($2::uuid[]) ORDER BY id', values)).rows;
  for (const relation of affectedRelationships)
    await context.db.query('SELECT id FROM crm_relationships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, relation.id]);
  const relationships = await context.db.query("UPDATE crm_relationships SET source_invalidated=true,context_review='required' WHERE workspace_id=$1 AND source_id=ANY($2::uuid[])", values);
  const contexts = await context.db.query("UPDATE crm_source_relationship_contexts SET review='required' WHERE workspace_id=$1 AND (source_id=ANY($2::uuid[]) OR relationship_id IN(SELECT id FROM crm_relationships WHERE workspace_id=$1 AND source_id=ANY($2::uuid[])))", values);
  const claims = await context.db.query('UPDATE crm_endpoint_claims SET source_invalidated=true WHERE workspace_id=$1 AND source_id=ANY($2::uuid[])', values);
  const redacted = await context.db.query(`UPDATE crm_identity_endpoints e SET value=NULL WHERE e.workspace_id=$1 AND e.id=ANY($2::uuid[]) AND e.value IS NOT NULL AND NOT EXISTS (SELECT 1 FROM crm_endpoint_claims c JOIN crm_selected_sources s ON s.workspace_id=c.workspace_id AND s.id=c.source_id WHERE c.workspace_id=e.workspace_id AND c.endpoint_id=e.id AND NOT c.source_invalidated AND s.availability='available' AND s.revision=c.source_revision AND s.content_hash=c.source_hash)`, [context.scope.workspaceId, endpoints.map(endpoint => endpoint.endpoint_id)]);
  return { relationships: relationships.rowCount ?? 0, contexts: contexts.rowCount ?? 0, claims: claims.rowCount ?? 0, endpoints: redacted.rowCount ?? 0 };
}
