import {
  repositoryContext,
  withTransaction,
  type QueryResultRowLike,
  type RepositoryContext,
} from '@fss/domain/db';
import { clientCompatibility } from '@fss/contracts';
import type { AuthDeps } from './config.ts';
import type { AuthenticatedPrincipal } from './sessions.ts';
import { scopeForPrincipal } from '../scope.ts';
import { payloadHashOf } from './tokens.ts';

/**
 * The command middleware every mutating route goes through
 * (specification 5.3, Appendix A "Any client command").
 *
 * "Every mutating client command carries a unique command ID. Command receipt,
 * device, payload hash, result, and mutation commit in one transaction. Same ID and
 * payload returns the original result; a different payload or device is rejected.
 * Dial authorization replay never returns an actionable result."
 *
 * All four sentences are here and nowhere else. A route supplies `work`; it never
 * writes a receipt, never hashes a payload, and never decides whether a replay is a
 * replay. Uniqueness is the database's: migration 0003 makes `(workspace_id,
 * command_id)` unique, so two devices racing the same command id cannot both win.
 *
 * What is deliberately *not* recorded as a receipt: the pre-flight refusals below —
 * an outdated client, a revoked device, an inactive membership. Those never reached a
 * command, so they must not consume its id; an upgraded Mac retries the same command
 * id and it is still free. That is the preserved upgrade path of Appendix G 40.
 */

/**
 * What a refusal may carry beside its code: the typed facts a person needs to act on
 * it, such as a merge's conflicts (lane g78, audit item D05). Kept on the receipt with
 * the reason, so a replay of the same command id answers with the same details rather
 * than with a bare code the Mac cannot draw a screen from.
 */
export type RefusalDetails = Readonly<Record<string, unknown>>;

export type CommandWorkResult<T> =
  | { readonly status: 'accepted'; readonly result: T }
  | { readonly status: 'refused'; readonly reason: string; readonly details?: RefusalDetails };

export type CommandOutcome<T> =
  | { readonly status: 'accepted'; readonly result: T; readonly replayed: boolean }
  | { readonly status: 'refused'; readonly reason: string; readonly replayed: boolean; readonly details?: RefusalDetails };

/**
 * The receipt's `result` for a refusal: the reason as a JSON string, as every receipt
 * before lane g78 stored it, or `{ reason, details }` when the refusal carried details.
 * Both are read back by `refusalOfReceipt`, so the old receipts replay unchanged.
 */
function storedRefusal(reason: string, details: RefusalDetails | undefined): string {
  return JSON.stringify(details === undefined ? reason : { reason, details });
}

function refusalOfReceipt(result: unknown): { readonly reason: string; readonly details?: RefusalDetails } {
  if (typeof result === 'string') return { reason: result };
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    const stored = result as { reason?: unknown; details?: unknown };
    if (typeof stored.reason === 'string') {
      const details = stored.details;
      return typeof details === 'object' && details !== null && !Array.isArray(details)
        ? { reason: stored.reason, details: details as RefusalDetails }
        : { reason: stored.reason };
    }
  }
  return { reason: 'refused' };
}

export interface CommandRequest {
  readonly commandId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly clientVersion: string;
}

interface ReceiptRow extends QueryResultRowLike {
  readonly device_id: string;
  readonly command_kind: string;
  readonly payload_hash: string;
  readonly result_status: 'accepted' | 'refused';
  readonly result: unknown;
}

/**
 * A dial authorization is the one command whose replay must not be actionable
 * (5.3). Migration 0001 enforces it — `command_receipts_dial_result_not_actionable`
 * refuses a row of this kind that carries a result — so the receipt keeps the fact
 * that the command happened and none of what it produced.
 */
const NON_ACTIONABLE_REPLAY_KINDS = new Set(['authorize_dial']);

const PostgresUniqueViolation = '23505';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === PostgresUniqueViolation;
}

export async function runCommand<T>(
  deps: AuthDeps,
  principal: AuthenticatedPrincipal,
  request: CommandRequest,
  work: (context: RepositoryContext) => Promise<CommandWorkResult<T>>,
): Promise<CommandOutcome<T>> {
  if (clientCompatibility(deps.config.supportedClientVersions, request.clientVersion).kind !== 'supported') {
    return { status: 'refused', reason: 'client_upgrade_required', replayed: false };
  }
  const scoped = scopeForPrincipal(principal);
  if (!scoped.authorized) return { status: 'refused', reason: scoped.refusal, replayed: false };

  const payloadHash = payloadHashOf(request.payload);
  const context = repositoryContext(scoped.scope, deps.db);

  const replayOf = (row: ReceiptRow): CommandOutcome<T> => {
    if (row.device_id !== principal.deviceId) {
      return { status: 'refused', reason: 'command_device_mismatch', replayed: false };
    }
    if (row.payload_hash !== payloadHash) {
      return { status: 'refused', reason: 'command_payload_mismatch', replayed: false };
    }
    if (row.command_kind !== request.kind) {
      return { status: 'refused', reason: 'command_kind_mismatch', replayed: false };
    }
    if (row.result_status === 'refused') {
      return { status: 'refused', ...refusalOfReceipt(row.result), replayed: true };
    }
    return { status: 'accepted', result: row.result as T, replayed: true };
  };

  const existing = await readReceipt(deps, principal.workspaceId, request.commandId);
  if (existing !== null) return replayOf(existing);

  try {
    return await withTransaction(deps.db, async () => {
      const outcome = await work(context);
      const storedResult =
        outcome.status === 'accepted'
          ? NON_ACTIONABLE_REPLAY_KINDS.has(request.kind)
            ? null
            : JSON.stringify(outcome.result ?? null)
          : storedRefusal(outcome.reason, outcome.details);
      await deps.db.query(
        `INSERT INTO command_receipts (workspace_id, device_id, command_id, command_kind, payload_hash, result_status, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          principal.workspaceId,
          principal.deviceId,
          request.commandId,
          request.kind,
          payloadHash,
          outcome.status,
          storedResult,
        ],
      );
      return outcome.status === 'accepted'
        ? { status: 'accepted', result: outcome.result, replayed: false }
        : {
            status: 'refused',
            reason: outcome.reason,
            replayed: false,
            ...(outcome.details === undefined ? {} : { details: outcome.details }),
          };
    });
  } catch (error) {
    // Two commands with one id raced. The transaction rolled back, so at most one
    // mutation survived; whichever won, the answer is the receipt that committed.
    if (!isUniqueViolation(error)) throw error;
    const winner = await readReceipt(deps, principal.workspaceId, request.commandId);
    if (winner === null) throw error;
    return replayOf(winner);
  }
}

async function readReceipt(deps: AuthDeps, workspaceId: string, commandId: string): Promise<ReceiptRow | null> {
  const { rows } = await deps.db.query<ReceiptRow>(
    `SELECT device_id, command_kind, payload_hash, result_status, result
       FROM command_receipts
      WHERE workspace_id = $1 AND command_id = $2`,
    [workspaceId, commandId],
  );
  return rows[0] ?? null;
}
