import type {RepositoryContext} from '../db/workspaceScope.ts';

/**
 * Shared by retained human-work updates and scoped deletion before identity and
 * action locks. Historical Ask copies still participate in the deletion closure.
 * Keep the existing advisory key so those retained paths serialize consistently.
 * Transaction-scoped only: no verifier or provider wait may hold this lock.
 */
export async function lockAskLifecycle(context:RepositoryContext):Promise<void>{
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-ask-lifecycle`]);
}
