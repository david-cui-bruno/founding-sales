import type {RepositoryContext} from '../db/workspaceScope.ts';

/**
 * Acquired before identity, request, job and spending locks by Ask worker stages
 * and scoped deletion. Recovery must conserve money even after private authority
 * is erased, so it cannot rely on the original source locks to serialize deletion.
 * Transaction-scoped only: no verifier or provider wait may hold this lock.
 */
export async function lockAskLifecycle(context:RepositoryContext):Promise<void>{
 await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${context.scope.workspaceId}:crm-ask-lifecycle`]);
}
