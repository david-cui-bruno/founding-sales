import type { RepositoryContext } from '../db/workspaceScope.ts';

type Scope = { readonly firmId: string; readonly contactId: string | null };
const IN_SCOPE = 'workspace_id=$1 AND firm_id=$2 AND ($3::uuid IS NULL OR contact_id=$3)';
const ATTEMPT_IN_SCOPE = `workspace_id=$1 AND ((firm_id=$2 AND ($3::uuid IS NULL OR contact_id=$3))
  OR phone_route_id IN (SELECT id FROM phone_routes WHERE ${IN_SCOPE}))`;

/** Include frozen old endpoints as well as current routes in the erasure closure. */
export async function measurePhoneHandoffDeletion(context: RepositoryContext, scope: Scope): Promise<{ attempts: number; scrubs: number; handles: string[] }> {
  const values = [context.scope.workspaceId, scope.firmId, scope.contactId];
  const handles = (await context.db.query<{ e164: string }>(`SELECT e164 FROM phone_handoff_attempts WHERE ${ATTEMPT_IN_SCOPE} AND erased_at IS NULL
    UNION SELECT e164 FROM phone_routes WHERE ${IN_SCOPE}`, values)).rows.map(row => row.e164);
  const attempts = (await context.db.query<{ count: string }>(`SELECT count(*) AS count FROM phone_handoff_attempts WHERE ${ATTEMPT_IN_SCOPE} AND erased_at IS NULL`, values)).rows[0];
  const scrubs = (await context.db.query<{ count: string }>('SELECT count(*) AS count FROM national_registry_endpoint_scrubs WHERE workspace_id=$1 AND e164=ANY($2::text[])',
    [context.scope.workspaceId, handles])).rows[0];
  return { attempts: Number(attempts?.count ?? 0), scrubs: Number(scrubs?.count ?? 0), handles };
}

/** Gate and firm already held. Clear every prospect binding before route/log deletion. */
export async function erasePhoneHandoffs(context: RepositoryContext, scope: Scope): Promise<{ attempts: number; scrubs: number }> {
  const measured = await measurePhoneHandoffDeletion(context, scope);
  const erased = await context.db.query(`UPDATE phone_handoff_attempts SET erased_at=clock_timestamp(), e164=NULL,phone_route_id=NULL,
    route_version=NULL,contact_id=NULL,opportunity_id=NULL,item_id=NULL,registry_snapshot_id=NULL,registry_scrubbed_at=NULL,call_log_id=NULL
    WHERE ${ATTEMPT_IN_SCOPE} AND erased_at IS NULL`, [context.scope.workspaceId, scope.firmId, scope.contactId]);
  const scrubs = await context.db.query('DELETE FROM national_registry_endpoint_scrubs WHERE workspace_id=$1 AND e164=ANY($2::text[])',
    [context.scope.workspaceId, measured.handles]);
  return { attempts: erased.rowCount ?? 0, scrubs: scrubs.rowCount ?? 0 };
}
