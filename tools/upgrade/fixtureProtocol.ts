/**
 * The one line the fixture loader's process prints for its parent to read.
 *
 * It lives in a module of its own because `fixtureMain.ts` runs on import — it is an
 * entry point — and a parent that imported the constant from there would load the
 * fixture in its own process as a side effect of wanting a string.
 */
export const FIXTURE_JSON_PREFIX = 'FIXTURE_JSON ';
