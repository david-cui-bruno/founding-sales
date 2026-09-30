import { afterEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/queryable.ts';
import { readMailbox, readMailboxForUpdate, resetAccountState } from '../../mail/mailboxes.ts';
import { runMailRecovery } from '../../mail/recover.ts';
import { createMailWorld, fixtureMessage, type MailWorld, type MailWorldMailbox } from './support/mailWorld.ts';

/**
 * Mail core correctness (slice C2B-A1): generation fencing, the continuous handoff,
 * resume by recorded ids, conditional completion, RFC Message-ID conflicts, watch
 * fencing and generation-keyed jobs. `docs/greenfield/mail.md` states the rules.
 */

let world: MailWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

async function completeBaseline(w: MailWorld, mailbox: MailWorldMailbox): Promise<void> {
  const context = w.systemContext(mailbox.workspace.workspaceId);
  const outcome = await runMailRecovery(context, w.syncDeps(mailbox), { mailboxId: mailbox.mailboxId, generation: 1 });
  if (outcome.outcome !== 'completed') throw new Error(`the baseline did not complete: ${outcome.outcome}`);
}

describe('resetAccountState', () => {
  it('clears the cursor, its instant, the watermark and the last sync in one statement the CHECKs accept', async () => {
    world = await createMailWorld({
      alphaMessages: [
        fixtureMessage({ id: 'reset1', historyId: '1001', from: 'someone@elsewhere.example.test', to: 'sales.alpha@example.test' }),
      ],
    });
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    await completeBaseline(w, w.alpha);
    await w.database.session.query(
      "UPDATE mailboxes SET last_sync_error = 'an earlier failure', last_synced_at = now() WHERE id = $1",
      [w.alpha.mailboxId],
    );
    const before = await readMailbox(context, w.alpha.mailboxId);
    expect(before?.historyId).not.toBeNull();
    expect(before?.coverageWatermarkAt).not.toBeNull();

    // Either CHECK refuses a reset that clears one column without the others.
    await expect(
      w.database.session.query('UPDATE mailboxes SET history_id = NULL WHERE id = $1', [w.alpha.mailboxId]),
    ).rejects.toMatchObject({ code: '23514' });

    await withTransaction(w.database.session, async () => {
      await readMailboxForUpdate(context, w.alpha.mailboxId);
      await resetAccountState(context, { mailboxId: w.alpha.mailboxId });
    });

    const { rows } = await w.database.session.query<{
      history_id: string | null;
      history_id_updated_at: Date | null;
      coverage_watermark_at: Date | null;
      last_sync_error: string | null;
      last_synced_at: Date | null;
    }>(
      `SELECT history_id, history_id_updated_at, coverage_watermark_at, last_sync_error, last_synced_at
         FROM mailboxes WHERE id = $1`,
      [w.alpha.mailboxId],
    );
    expect(rows[0]).toEqual({
      history_id: null,
      history_id_updated_at: null,
      coverage_watermark_at: null,
      last_sync_error: null,
      last_synced_at: null,
    });
    // The other mailbox is not touched.
    const beta = await readMailbox(w.systemContext(w.beta.workspace.workspaceId), w.beta.mailboxId);
    expect(beta?.historyId).not.toBeNull();
  });

  it('refuses a mailbox that is not there', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    await expect(resetAccountState(context, { mailboxId: w.beta.mailboxId })).rejects.toThrow(/found no mailbox/);
  });
});
