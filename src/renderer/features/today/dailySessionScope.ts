/** Renderer lifetime guard only. A later same-workspace mount cannot revive
 * continuations invalidated by teardown or a held local read. */
const scopes = new WeakMap<
  object,
  { workspaceId: string | null; generation: number }
>();
export function setDailySessionScope(api: object, workspaceId: string | null) {
  const prior = scopes.get(api);
  scopes.set(api, {
    workspaceId,
    generation:
      (prior?.generation ?? 0) +
      (workspaceId === null || prior?.workspaceId !== workspaceId ? 1 : 0),
  });
}
export function assertDailySessionScope(api: object, workspaceId: string) {
  if (scopes.has(api) && scopes.get(api)?.workspaceId !== workspaceId)
    throw Error('Daily view scope changed');
}
export function captureDailySessionScope(api: object, workspaceId: string) {
  assertDailySessionScope(api, workspaceId);
  const generation = scopes.get(api)?.generation;
  return () => {
    assertDailySessionScope(api, workspaceId);
    if (scopes.get(api)?.generation !== generation)
      throw Error('Daily operation cancelled');
  };
}
