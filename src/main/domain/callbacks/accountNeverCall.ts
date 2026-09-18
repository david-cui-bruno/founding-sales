import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import { neverCallAccountSchema, neverCallReceiptSchema, type NeverCallAccount, type NeverCallReceipt } from '../../../shared/contracts/accountCallbackContract';

/**
 * "Never call this firm" (design D13). It writes the same account suppression tombstone the
 * `opt_out` outcome writes, and nothing else: no handoff is prepared, no number is dialed, no
 * owner command is queued and no outcome is recorded. It is not a call outcome. Tombstones are
 * append-only, so a second request with the same command id is a no-op that reports the first one.
 */
export class AccountNeverCallRepository {
  constructor(private readonly deps: { database: AppDatabase; clock: Clock }) {}
  private get raw() { return this.deps.database.raw; }
  static tombstoneId(commandId: string): string { return `never-call-${commandId}`; }
  read(accountId: string): NeverCallReceipt | null {
    const row = this.raw.prepare('SELECT id,account_id AS accountId,observed_at AS observedAt,source,evidence_ref AS evidenceRef FROM pm_account_suppression_tombstones WHERE account_id=? ORDER BY observed_at,id LIMIT 1')
      .get(accountId) as { id: string; accountId: string; observedAt: string; source: string; evidenceRef: string } | undefined;
    return row ? neverCallReceiptSchema.parse({ ...row, suppressed: true }) : null;
  }
  /** Idempotent on the caller's command id. Never dials, prepares a handoff or queues an owner command. */
  suppress(input: NeverCallAccount): NeverCallReceipt {
    const request = neverCallAccountSchema.parse(input);
    if (!this.raw.prepare('SELECT 1 FROM pm_accounts WHERE id=?').get(request.accountId)) throw new Error('never_call_unknown_account');
    const id = AccountNeverCallRepository.tombstoneId(request.commandId);
    const at = this.deps.clock.now();
    this.raw.prepare('INSERT OR IGNORE INTO pm_account_suppression_tombstones VALUES(?,?,?,?,?,?)')
      .run(id, request.accountId, at, 'manual_never_call', request.commandId, at);
    const written = this.raw.prepare('SELECT id,account_id AS accountId,observed_at AS observedAt,source,evidence_ref AS evidenceRef FROM pm_account_suppression_tombstones WHERE id=?')
      .get(id) as { id: string; accountId: string; observedAt: string; source: string; evidenceRef: string } | undefined;
    if (!written || written.accountId !== request.accountId) throw new Error('never_call_identity_mismatch');
    return neverCallReceiptSchema.parse({ ...written, suppressed: true });
  }
}
