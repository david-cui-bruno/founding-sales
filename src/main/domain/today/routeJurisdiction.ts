import type { AppDatabase } from '../../db/database';

/**
 * The firm's local time zone as its latest route policy receipt records it
 * (`policy_json.jurisdiction.timezone`, written by the territory clearance
 * lane). The newest receipt decides: a firm without a receipt, or whose newest
 * receipt names no jurisdiction or an unusable zone, is absent from the map so
 * the caller falls back to the workspace zone. Nothing here throws: the
 * morning list must still open over a malformed receipt.
 */
export function readRouteJurisdictionTimezones(database: AppDatabase, accountIds: readonly string[]): ReadonlyMap<string, string> {
  const zones = new Map<string, string>();
  if (accountIds.length === 0) return zones;
  const rows = database.raw.prepare(`
    SELECT account_id AS accountId, policy_json AS policyJson
    FROM pm_account_route_policy_receipts
    WHERE account_id IN (SELECT value FROM json_each(?))
    ORDER BY account_id, revision DESC, admitted_at DESC, id
  `).all(JSON.stringify([...new Set(accountIds)])) as { accountId: string; policyJson: string }[];
  const decided = new Set<string>();
  for (const row of rows) {
    if (decided.has(row.accountId)) continue;
    decided.add(row.accountId);
    let timezone: unknown;
    try { timezone = (JSON.parse(row.policyJson) as { jurisdiction?: { timezone?: unknown } | null }).jurisdiction?.timezone; }
    catch { continue; }
    if (typeof timezone !== 'string' || timezone.length === 0) continue;
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { continue; }
    zones.set(row.accountId, timezone);
  }
  return zones;
}
