import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE } from '@fss/domain/db/testing/testDatabase.ts';
import { startQualifiedResearchApp } from './qualifiedResearchApp.ts';

/** Explicit opt-in is set only after root grants the frozen UI/App exclusive lane.
 * Collection, typechecking and source tests cannot accidentally start PostgreSQL. */
export async function startCandidateInventoryApp() {
  assert.equal(process.env['FSS_CANDIDATE_INVENTORY_EXCLUSIVE_LANE'], '749-frozen-ui-app', 'Root exclusive lane grant required');
  const executable = process.env['FSS_LOCAL_BROWSER_EXECUTABLE'];
  assert(executable, 'Installed headless Chrome executable required, no downloads');
  await access(executable);
  const owned = await startQualifiedResearchApp();
  try {
    const port = (await owned.app.fixture.db.query<{ port: string }>('SHOW port')).rows[0]!.port;
    console.log('CANDIDATE_INVENTORY_EXACT_RESOURCES', JSON.stringify({
      database: owned.app.fixture.database.name, template: process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE],
      postgresPort: Number(port), httpsPort: Number(new URL(owned.app.origin).port),
    }));
    return owned;
  } catch (error) { await owned.stop(); throw error; }
}
