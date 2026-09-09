/** Renderer view lifetime guard, not an execution authority or status store.
 * Prevents delayed edits from an old workspace reaching a reused bridge. */
const scopes = new WeakMap<object, string | null>();
export function setDailySessionScope(api: object, workspaceId: string | null) {
  scopes.set(api, workspaceId);
}
export function assertDailySessionScope(api: object, workspaceId: string) {
  if (scopes.has(api) && scopes.get(api) !== workspaceId)
    throw Error('Daily view scope changed');
}
