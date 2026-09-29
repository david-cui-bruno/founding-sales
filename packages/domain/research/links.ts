import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isPublicResearchUrl, withoutFragment } from './sourcePolicy.ts';
import { accept, refuse, type ResearchResult } from './types.ts';

/**
 * The pages David adds by hand (`firm_links`).
 *
 * The only way a URL that is not on the firm's own host becomes readable. It is a
 * command with a receipt and an author, because that is what makes it a decision: a
 * link is permitted **once, as itself**, not by prefix, so approving one page does
 * not approve a directory.
 *
 * The URL still has to be an https URL on a public host that is not one of the
 * blocked ones (`isPublicResearchUrl`). A person may point research at a page; a
 * person may not point it at LinkedIn or at the metadata endpoint.
 *
 * And it may not carry a **query string**. A link is stored, and it becomes the
 * `source_reference` of every quote taken from the page, so it is a URL that outlives
 * the run. A query string is where a session token, a reset code and a signed URL's
 * signature live, and retention cannot find a secret inside a URL. Pasting the link
 * from a browser's address bar is exactly how one would arrive, so the refusal is
 * explicit — `link_not_permitted` — rather than a silent truncation of what somebody
 * typed. A fragment is dropped, because it never reaches the server and never names a
 * different page.
 */

export interface FirmLink {
  readonly id: string;
  readonly url: string;
  readonly addedByUserId: string;
  readonly addedAt: string;
}

export async function listFirmLinks(context: RepositoryContext, firmId: string): Promise<readonly FirmLink[]> {
  const { rows } = await context.db.query<{ id: string; url: string; added_by_user_id: string; added_at: Date }>(
    `SELECT id, url, added_by_user_id, added_at FROM firm_links
      WHERE workspace_id = $1 AND firm_id = $2 ORDER BY added_at DESC, id`,
    [context.scope.workspaceId, firmId],
  );
  return rows.map(row => ({
    id: row.id,
    url: row.url,
    addedByUserId: row.added_by_user_id,
    addedAt: row.added_at.toISOString(),
  }));
}

export async function addFirmLink(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly url: string },
): Promise<ResearchResult<FirmLink>> {
  const url = withoutFragment(input.url.trim());
  if (!isPublicResearchUrl(url) || url.length > 500) return refuse('link_not_permitted');

  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) {
    return refuse(decision.reason === 'firm_merged' ? 'firm_merged' : 'not_assigned');
  }
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuse('invalid_input');

  const { rows } = await context.db.query<{ id: string; url: string; added_by_user_id: string; added_at: Date }>(
    `INSERT INTO firm_links (workspace_id, firm_id, url, added_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT ON CONSTRAINT firm_links_one_per_url DO UPDATE SET url = EXCLUDED.url
     RETURNING id, url, added_by_user_id, added_at`,
    [context.scope.workspaceId, input.firmId, url, actor.userId],
  );
  const row = rows[0];
  if (row === undefined) return refuse('invalid_input');
  return accept({
    id: row.id,
    url: row.url,
    addedByUserId: row.added_by_user_id,
    addedAt: row.added_at.toISOString(),
  });
}
