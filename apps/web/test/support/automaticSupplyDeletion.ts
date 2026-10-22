import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { dispatch } from '../../../api/src/server.ts';
import { issueSessionFor } from '../../../api/test/support/sessionFixture.ts';
import { CURRENT_CLIENT_VERSION } from '../../../api/test/support/authFixture.ts';
import type { ThinHostApp } from './thinHostApp.ts';
/** Ordinary preview/commit deletion via authenticated API dispatcher. The browser
 * allowlist intentionally offers no privacy deletion command. A separate real
 * signed synthetic OIDC grant authenticates this fixture-only cleanup action.
 * Never mint a session row, inject a principal or erase snapshots to bypass policy.
 */
export async function deleteAutomaticSupplyFirm(app: ThinHostApp, firmId: string) {
  const f = app.fixture;
  const grant = await issueSessionFor(f, f.alpha, f.alpha.admin, { deviceLabel: 'Automatic supply deletion acceptance' });
  const journal = recordingSuppressionJournal();
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await dispatch({ method: 'POST', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${grant.accessToken}` }, body: { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION, ...body } }, { session: f.db, auth: f.deps, supportedClientVersions: f.deps.config.supportedClientVersions, sendingEnabled: false, suppressionJournal: journal });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as { result: { requestId: string; previewHash: string } };
  };
  const preview = await post('/retention/deletions/preview', { targetKind: 'firm', firmId });
  await post('/retention/deletions/commit', { requestId: preview.result.requestId, previewHash: preview.result.previewHash });
  const retained = (await f.db.query<{ name: string; website: string | null }>('SELECT name,website FROM firms WHERE workspace_id=$1 AND id=$2', [f.alpha.workspaceId, firmId])).rows[0];
  assert.equal(retained?.name, '[deleted]');
  assert.equal(retained.website, null);
}
