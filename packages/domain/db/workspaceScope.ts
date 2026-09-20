import type { Queryable } from './queryable.ts';

/**
 * The typed workspace scope (specification section 6).
 *
 * A `WorkspaceScope` carries a brand keyed on a `unique symbol` this module does not
 * export, so the only way to obtain one is `workspaceScope(...)`. That is what makes
 * "a repository function cannot be written without a scope" a compile error rather
 * than a convention: the context a repository function receives contains a scope, and
 * a plain object literal cannot stand in for one.
 */

declare const workspaceScopeBrand: unique symbol;
declare const workspaceIdBrand: unique symbol;

/** A workspace identifier that has been through `workspaceId()`. */
export type WorkspaceId = string & { readonly [workspaceIdBrand]: 'WorkspaceId' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceScopeError extends Error {
  constructor(readonly code: 'WORKSPACE_ID_INVALID' | 'SCOPE_ACTOR_INVALID', message: string) {
    super(message);
    this.name = 'WorkspaceScopeError';
  }
}

export function workspaceId(value: string): WorkspaceId {
  if (!UUID_PATTERN.test(value)) {
    throw new WorkspaceScopeError('WORKSPACE_ID_INVALID', 'a workspace id is a UUID');
  }
  return value.toLowerCase() as WorkspaceId;
}

/** Who the scope acts for. The worker and the scheduler act for the system, never for a user. */
export type ScopeActor =
  | { readonly kind: 'user'; readonly userId: string; readonly role: 'admin' | 'salesperson' }
  | { readonly kind: 'system'; readonly component: 'scheduler' | 'worker' | 'migration' };

export interface WorkspaceScope {
  readonly [workspaceScopeBrand]: 'WorkspaceScope';
  readonly workspaceId: WorkspaceId;
  readonly actor: ScopeActor;
}

/** The only constructor of a `WorkspaceScope`. */
export function workspaceScope(id: string | WorkspaceId, actor: ScopeActor): WorkspaceScope {
  if (actor.kind === 'user' && !UUID_PATTERN.test(actor.userId)) {
    throw new WorkspaceScopeError('SCOPE_ACTOR_INVALID', 'a user actor names a UUID user id');
  }
  // The brand is a type-level `unique symbol` with no runtime value: it exists to make
  // an object literal unassignable to WorkspaceScope, and nothing ever reads it.
  return { workspaceId: workspaceId(id), actor } as unknown as WorkspaceScope;
}

/** Whether a scope is an admin's. Admin-only commands ask this, never the caller's word. */
export function isAdminScope(scope: WorkspaceScope): boolean {
  return scope.actor.kind === 'user' && scope.actor.role === 'admin';
}

/**
 * Everything a repository function is given. There is no second form: a function that
 * takes a bare `Queryable`, or a bare id, is not a repository function and
 * `defineRepository` refuses it.
 */
export interface RepositoryContext {
  readonly scope: WorkspaceScope;
  readonly db: Queryable;
}

/** Build a context. Takes a scope value, so it cannot be called without one either. */
export function repositoryContext(scope: WorkspaceScope, db: Queryable): RepositoryContext {
  return { scope, db };
}

/**
 * The shape every repository function has. `...args: never[]` accepts any further
 * parameters (never is assignable to all of them) while pinning the first one, so
 * `(id: string) => ...` is refused: `RepositoryContext` is not assignable to `string`.
 */
export type RepositoryFunction = (context: RepositoryContext, ...args: never[]) => Promise<unknown>;

/**
 * Declare a repository. Identity at runtime; the work is done by the constraint,
 * which is what the `@ts-expect-error` cases in test/db/workspaceScope.test.ts prove.
 */
export function defineRepository<Functions extends Readonly<Record<string, RepositoryFunction>>>(
  functions: Functions,
): Functions {
  return functions;
}
