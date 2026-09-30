import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * `mailbox_accounts` (migration 0027): which Google account one mailbox row was, and
 * when (call-to-booking slice A2).
 *
 * A switch keeps the mailbox's id, so every message, match, permission, fence and send
 * day that references it carries over; this table is what still knows which address the
 * row had at a given instant. **No rows means the mailbox has only ever had its current
 * address** — every mailbox that existed before 0027, and every mailbox never switched.
 *
 * Two readers ask it: the direct-send boundary (`currentAccountSince`, read by
 * `mail/effects.ts`) and the open-in-Gmail link (`retention/attachments.ts`, one SQL
 * join of its own).
 */

export interface MailboxAccountRow {
  readonly id: string;
  readonly emailAddress: string;
  readonly activeFrom: string;
  readonly activeUntil: string | null;
  readonly generationFrom: number;
}

interface AccountDbRow {
  readonly id: string;
  readonly email_address: string;
  readonly active_from: Date;
  readonly active_until: Date | null;
  readonly generation_from: number;
  readonly [column: string]: unknown;
}

const toAccount = (row: AccountDbRow): MailboxAccountRow => ({
  id: row.id,
  emailAddress: row.email_address,
  activeFrom: row.active_from.toISOString(),
  activeUntil: row.active_until?.toISOString() ?? null,
  generationFrom: row.generation_from,
});

/** Every interval of one mailbox, oldest first. Empty for a mailbox never switched. */
export async function listMailboxAccounts(
  context: RepositoryContext,
  mailboxId: string,
): Promise<readonly MailboxAccountRow[]> {
  const { rows } = await context.db.query<AccountDbRow>(
    `SELECT id, email_address, active_from, active_until, generation_from
       FROM mailbox_accounts
      WHERE workspace_id = $1 AND mailbox_id = $2
      ORDER BY active_from, created_at, id`,
    [context.scope.workspaceId, mailboxId],
  );
  return rows.map(toAccount);
}

/**
 * The instant the mailbox's current account began, or null when the mailbox has never
 * been switched — "no bound" for the direct-send rule.
 */
export async function currentAccountSince(context: RepositoryContext, mailboxId: string): Promise<string | null> {
  const { rows } = await context.db.query<{ active_from: Date }>(
    `SELECT active_from FROM mailbox_accounts
      WHERE workspace_id = $1 AND mailbox_id = $2 AND active_until IS NULL`,
    [context.scope.workspaceId, mailboxId],
  );
  return rows[0]?.active_from.toISOString() ?? null;
}

/**
 * Record a switch: close the old account's interval and open the new one's, at the
 * transaction's own `now()` so both rows and the revived mailbox row agree to the
 * microsecond.
 *
 * The old account's interval is the open row when there is one (a mailbox switched
 * before), and otherwise a closed row from the mailbox's **creation**: with no rows the
 * mailbox has only ever had that address, since generation 1. (`connected_at` is not the
 * start: every re-consent of the same address rewrites it, so it would cut off the
 * messages recorded before the latest re-consent.)
 *
 * The caller holds the mailbox row lock and calls this before the row changes address.
 */
export async function recordAccountSwitch(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly fromAddress: string;
    readonly toAddress: string;
    /** The generation the new account begins at: the revived row's. */
    readonly toGeneration: number;
  },
): Promise<void> {
  const closed = await context.db.query(
    `UPDATE mailbox_accounts SET active_until = now()
      WHERE workspace_id = $1 AND mailbox_id = $2 AND active_until IS NULL`,
    [context.scope.workspaceId, input.mailboxId],
  );
  if ((closed.rowCount ?? 0) === 0) {
    await context.db.query(
      `INSERT INTO mailbox_accounts (workspace_id, mailbox_id, email_address, active_from, active_until, generation_from)
       SELECT workspace_id, id, $3, least(created_at, now()), now(), 1
         FROM mailboxes WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, input.mailboxId, input.fromAddress.trim().toLowerCase()],
    );
  }
  await context.db.query(
    `INSERT INTO mailbox_accounts (workspace_id, mailbox_id, email_address, active_from, generation_from)
     VALUES ($1, $2, $3, now(), $4)`,
    [context.scope.workspaceId, input.mailboxId, input.toAddress.trim().toLowerCase(), input.toGeneration],
  );
}
