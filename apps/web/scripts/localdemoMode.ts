/** Local fixture selection only. The caller must still enforce synthetic-only
 * configuration, resource ownership and the existing no-send boundaries. */
export function localDemoManualPreparation(env: NodeJS.ProcessEnv): boolean {
  const value = env['FSS_LOCAL_DEMO_MANUAL_PREPARATION'];
  if (value === undefined) return false;
  if (value !== '1') throw Error('FSS_LOCAL_DEMO_MANUAL_PREPARATION must be absent or exactly 1');
  if (env['FSS_SYNTHETIC_LOCAL_DEMO'] !== '1') throw Error('Manual preparation requires explicit synthetic local demo');
  return true;
}
