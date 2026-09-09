import { z } from 'zod';
import type { AppDatabase } from '../db/database';
import { accountClaimSchema, accountIdSchema, accountInstantSchema, accountRouteSchema, accountSchema, accountSourceSchema } from '../../shared/contracts/accountContract';
import { accountRecordSchema, type AccountRecord } from '../../shared/contracts/accountRecordContract';
import { accountFingerprint } from '../domain/accounts/accountEvidence';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const SELECTED_ACCOUNT_LIMITS = Object.freeze({ maxHistory: 200, maxSources: 100, maxClaims: 500, maxRoutes: 500, maxBytes: 200000 });
const limitsSchema = z.strictObject({
  maxHistory: integer.positive().max(SELECTED_ACCOUNT_LIMITS.maxHistory).optional(),
  maxSources: integer.positive().max(SELECTED_ACCOUNT_LIMITS.maxSources).optional(),
  maxClaims: integer.positive().max(SELECTED_ACCOUNT_LIMITS.maxClaims).optional(),
  maxRoutes: integer.positive().max(SELECTED_ACCOUNT_LIMITS.maxRoutes).optional(),
  maxBytes: integer.positive().max(SELECTED_ACCOUNT_LIMITS.maxBytes).optional(),
});
export type SelectedAccountExportLimits = z.infer<typeof limitsSchema>;
const inputSchema = z.strictObject({ database: z.custom<AppDatabase>(), workspaceId: accountIdSchema, researchRevision: integer.positive(), accountId: accountIdSchema, asOf: accountInstantSchema, limits: limitsSchema.optional() });
const fail = (detail: string): never => { throw new Error(`Selected account export ${detail}`); };
const same = (a: unknown, b: unknown) => accountFingerprint(a) === accountFingerprint(b);
function exact<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.parse(value);
  if (!same(parsed, value)) fail('noncanonical record');
  return parsed;
}
/** Read-only selected evidence export. No attestation, authority, jobs or credentials.
 * Limits bound raw rows (including old route versions) and UTF-8 serialized bytes.
 * Equal-time commands are grouped into the actual SQL as-of projection, never
 * assigned fictional timestamps. asOf must include the entire current record. */
export function exportSelectedAccountRecord(input: {
  database: AppDatabase; workspaceId: string; researchRevision: number; accountId: string; asOf: string; limits?: SelectedAccountExportLimits;
}): AccountRecord {
  const { database, workspaceId, researchRevision, accountId, asOf } = inputSchema.parse(input);
  const limits = { ...SELECTED_ACCOUNT_LIMITS, ...limitsSchema.parse(input.limits ?? {}) };
  const raw = database.raw;
  const read = (): AccountRecord => {
    const row = raw.prepare('SELECT id,name,domain,version,created_at,updated_at FROM pm_accounts WHERE id=?').get(accountId) as {
      id: string; name: string; domain: string | null; version: number; created_at: string; updated_at: string;
    } | undefined;
    if (!row) return fail('missing selection');
    const account = exact(accountSchema, { id: row.id, name: row.name, domain: row.domain, version: row.version });
    const createdAt = accountInstantSchema.parse(row.created_at); const updatedAt = accountInstantSchema.parse(row.updated_at);
    if (createdAt > updatedAt || updatedAt > asOf) fail('historical truncation');
    // Reject oversized SQL strings before materializing arbitrary JSON or excerpts.
    for (const [table, columns] of [
      ['pm_account_commands', 'result_json'], ['pm_account_sources', 'excerpt || url'], ['pm_account_claims', 'claim_json'], ['pm_account_routes', 'value'],
    ] as const) {
      const bytes = raw.prepare(`SELECT COALESCE(SUM(length(CAST(${columns} AS BLOB))),0) AS bytes FROM ${table} WHERE account_id=?`).get(accountId) as { bytes: number };
      if (!Number.isSafeInteger(bytes.bytes) || bytes.bytes > limits.maxBytes) fail('byte limit exceeded');
    }
    const commands = raw.prepare('SELECT account_version,created_at,result_json FROM pm_account_commands WHERE account_id=? ORDER BY account_version LIMIT ?')
      .all(accountId, limits.maxHistory + 1) as { account_version: number; created_at: string; result_json: string }[];
    if (commands.length > limits.maxHistory) fail('history limit exceeded');
    if (commands.length !== account.version) fail('history version gap');
    const historyTimes = new Map<string, number>();
    for (const [index, command] of commands.entries()) {
      const at = accountInstantSchema.parse(command.created_at);
      if (command.account_version !== index + 1 || at < createdAt || at > updatedAt || (index > 0 && at < commands[index - 1].created_at)) fail('history identity conflict');
      const result: unknown = JSON.parse(command.result_json);
      if (index === 0) {
        if (!same(exact(accountSchema, result), { ...account, version: 1 }) || at !== createdAt) fail('creation identity conflict');
      } else {
        const receipt = exact(z.strictObject({ accountId: accountIdSchema, version: integer.positive(), duplicate: z.boolean() }), result);
        if (receipt.accountId !== accountId || receipt.version !== command.account_version || receipt.duplicate) fail('history receipt conflict');
      }
      historyTimes.set(at, command.account_version);
    }
    if (commands.at(-1)?.created_at !== updatedAt) fail('history head conflict');
    const admitted = (value: unknown): string => {
      const at = accountInstantSchema.parse(value);
      if ((historyTimes.get(at) ?? 0) < 2) fail('unproven evidence admission');
      return at;
    };
    const sourceRows = raw.prepare('SELECT * FROM pm_account_sources WHERE account_id=? ORDER BY rowid LIMIT ?').all(accountId, limits.maxSources + 1) as {
      id: string; account_id: string; source_key: string; url: string; fetched_at: string; sha256: string; excerpt: string; permitted: number; admitted_at: string;
    }[];
    if (sourceRows.length > limits.maxSources) fail('source limit exceeded');
    const sourceAdmissions = new Map<string, string>();
    const sources = sourceRows.map(source => {
      const at = admitted(source.admitted_at);
      if (source.account_id !== accountId || source.permitted !== 1 || sourceAdmissions.has(source.id)) fail('source identity conflict');
      const result = exact(accountSourceSchema, { id: source.id, url: source.url, fetchedAt: source.fetched_at, sha256: source.sha256, excerpt: source.excerpt, permitted: true });
      if (result.fetchedAt > at || source.source_key !== accountFingerprint({ url: result.url, sha256: result.sha256, fetchedAt: result.fetchedAt })) fail('source receipt conflict');
      sourceAdmissions.set(result.id, at); return result;
    });
    const requireSources = (ids: string[], at: string) => {
      for (const id of ids) if (!sourceAdmissions.has(id) || sourceAdmissions.get(id)! > at) fail('missing or foreign evidence');
    };
    const claimRows = raw.prepare('SELECT id,claim_json,admitted_at FROM pm_account_claims WHERE account_id=? ORDER BY rowid LIMIT ?')
      .all(accountId, limits.maxClaims + 1) as { id: string; claim_json: string; admitted_at: string }[];
    if (claimRows.length > limits.maxClaims) fail('claim limit exceeded');
    const claimEdges = raw.prepare('SELECT claim_id,source_id FROM pm_account_claim_evidence WHERE account_id=? ORDER BY claim_id,source_id LIMIT ?')
      .all(accountId, limits.maxClaims * 100 + 1) as { claim_id: string; source_id: string }[];
    if (claimEdges.length > limits.maxClaims * 100 || claimEdges.some(edge => !claimRows.some(claim => claim.id === edge.claim_id))) fail('claim evidence conflict');
    const claims = claimRows.map(row => {
      accountIdSchema.parse(row.id); const at = admitted(row.admitted_at);
      const claim = exact(accountClaimSchema, JSON.parse(row.claim_json));
      const edges = claimEdges.filter(edge => edge.claim_id === row.id).map(edge => edge.source_id);
      if (!same([...claim.evidenceIds].sort(), edges)) fail('claim evidence conflict');
      requireSources(claim.evidenceIds, at); return { at, claim };
    });
    const routeRows = raw.prepare('SELECT * FROM pm_account_routes WHERE account_id=? ORDER BY rowid LIMIT ?').all(accountId, limits.maxRoutes + 1) as {
      id: string; account_id: string; version: number; person_id: string | null; channel: string; value: string; purpose: string; verification: string; admitted_at: string;
    }[];
    if (routeRows.length > limits.maxRoutes) fail('route limit exceeded');
    const routeEdges = raw.prepare('SELECT route_id,route_version,source_id FROM pm_account_route_evidence WHERE account_id=? ORDER BY route_id,route_version,source_id LIMIT ?')
      .all(accountId, limits.maxRoutes * 100 + 1) as { route_id: string; route_version: number; source_id: string }[];
    if (routeEdges.length > limits.maxRoutes * 100 || routeEdges.some(edge => !routeRows.some(route => route.id === edge.route_id && route.version === edge.route_version))) fail('route evidence conflict');
    const versions = new Map<string, { version: number; at: string }>();
    const routes = routeRows.map(row => {
      const at = admitted(row.admitted_at); const previous = versions.get(row.id);
      if (previous?.at === at) fail('ambiguous equal-time route history');
      if (row.account_id !== accountId || row.version !== (previous?.version ?? 0) + 1 || (previous && at < previous.at)) fail('route version conflict');
      if (raw.prepare('SELECT 1 FROM pm_account_routes WHERE id=? AND account_id<>? LIMIT 1').get(row.id, accountId)) fail('foreign route identity');
      if (row.person_id !== null && !raw.prepare('SELECT 1 FROM persons WHERE id=?').get(row.person_id)) fail('missing route person');
      const evidenceIds = routeEdges.filter(edge => edge.route_id === row.id && edge.route_version === row.version).map(edge => edge.source_id);
      const route = exact(accountRouteSchema, { id: row.id, accountId: row.account_id, version: row.version, personId: row.person_id, channel: row.channel,
        value: row.value, purpose: row.purpose, verification: row.verification, evidenceIds });
      requireSources(evidenceIds, at); versions.set(row.id, { version: row.version, at }); return { at, route };
    });
    const history = [...historyTimes].map(([at, version]) => {
      const eligible = routes.filter(route => route.at <= at);
      return { at, account: { ...account, version }, claims: claims.filter(claim => claim.at <= at).map(claim => claim.claim),
        routes: eligible.filter(entry => !eligible.some(newer => newer.route.id === entry.route.id && newer.route.version > entry.route.version)).map(entry => entry.route) };
    });
    const cursors = raw.prepare("SELECT workspace_id,aggregate_version FROM delegated_event_cursors WHERE account_id=? AND stream='research' LIMIT 2").all(accountId) as { workspace_id: string; aggregate_version: number }[];
    if (cursors.some(cursor => cursor.workspace_id !== workspaceId)) fail('foreign workspace research cursor');
    if (cursors.length > 1 || (cursors[0] && cursors[0].aggregate_version !== researchRevision)) fail('research cursor mismatch');
    // Only the caller supplies the protocol bootstrap base. Never infer it from account versions.
    const head = history.at(-1)!;
    const result = accountRecordSchema.parse({ account, history, sources, claims: head.claims, routes: head.routes, researchRevision });
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.maxBytes) fail('byte limit exceeded');
    return result;
  };
  return raw.inTransaction ? read() : raw.transaction(read).deferred();
}
