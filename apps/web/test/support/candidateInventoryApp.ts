import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { startQualifiedResearchApp } from './qualifiedResearchApp.ts';

/** Explicit opt-in is set only after root grants the frozen UI/App exclusive lane.
 * Collection, typechecking and source tests cannot accidentally start PostgreSQL. */
export async function startCandidateInventoryApp() {
  assert.equal(process.env['FSS_CANDIDATE_INVENTORY_EXCLUSIVE_LANE'], '749-frozen-ui-app', 'Root exclusive lane grant required');
  const executable = process.env['FSS_LOCAL_BROWSER_EXECUTABLE'];
  assert(executable, 'Installed headless Chrome executable required, no downloads');
  await access(executable);
  return await startQualifiedResearchApp();
}
