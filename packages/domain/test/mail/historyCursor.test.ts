import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  compareHistoryIds,
  createGmailHttpClient,
  historyIdOf,
  httpFetch,
  laterHistoryId,
  readMailbox,
  runMailRecovery,
  runMailSync,
  takeWholeRecords,
  type GmailClient,
  type GmailHistoryRecord,
} from '../../mail/index.ts';
import { createMailWorld, fixtureMessage, type MailWorld, type MailWorldMailbox } from './support/mailWorld.ts';

/**
 * The history cursor: what one `mail.sync` may claim to have read (lane g76, audit
 * items C06, C07 and C08).
 *
 * Three defects lived here together and each hid the next:
 *
 *   * **C06** — the HTTP adapter read a record's id from `historyId` instead of `id`
 *     and fell back to the start cursor, so a capped run wrote back the cursor it
 *     began from and read the same first fifty messages every minute.
 *   * **C07** — once the id is read, a cap that cuts between two messages of one
 *     history record stands the cursor on that record and skips the rest of it for
 *     ever, because `startHistoryId` returns only the records *after* an id.
 *   * **C08** — ids were compared through `Number`, which ties `9007199254740992` and
 *     `9007199254740993`, so a cursor could fail to move past a record it had read.
 *
 * The first block is the pure rule; the second runs it on a real PostgreSQL against
 * the recorded fake; the third runs a capped sync through the real HTTP adapter over
 * a loopback server answering in Google's documented shape.
 */

const record = (id: string, ...messageIds: string[]): GmailHistoryRecord => ({
  id,
  changes: messageIds.map(messageId => ({
    messageId,
    threadId: `thread-${messageId}`,
    kind: 'message_added' as const,
    labelIds: ['INBOX'],
  })),
});

describe('history ids are uint64 decimal strings (C08)', () => {
  it('orders and maxes ids that Number cannot tell apart', () => {
    expect(Number('9007199254740993')).toBe(Number('9007199254740992'));
    expect(compareHistoryIds('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareHistoryIds('9007199254740992', '9007199254740993')).toBe(-1);
    expect(compareHistoryIds('18446744073709551615', '18446744073709551615')).toBe(0);
    expect(laterHistoryId('9007199254740992', '9007199254740993')).toBe('9007199254740993');
    expect(laterHistoryId('9007199254740993', '9007199254740992')).toBe('9007199254740993');
    // Numerically, not by string length or text order.
    expect(laterHistoryId('999', '1000')).toBe('1000');
  });

  it('reads an id losslessly or not at all', () => {
    expect(historyIdOf('18446744073709551615')).toBe('18446744073709551615');
    expect(historyIdOf(4321)).toBe('4321');
    // A JSON number past 2^53 was rounded before anything could read it: this one
    // arrives as 9007199254740992.
    const rounded = (JSON.parse('{"historyId": 9007199254740993}') as { historyId: unknown }).historyId;
    expect(historyIdOf(rounded)).toBeNull();
    expect(historyIdOf('')).toBeNull();
    expect(historyIdOf('12a')).toBeNull();
    expect(historyIdOf('123456789012345678901')).toBeNull();
    expect(historyIdOf(undefined)).toBeNull();
  });
});

describe('a capped run takes whole history records (C07)', () => {
  it('never stops inside a record: the cap falls in the second record and all of it is taken', () => {
    const take = takeWholeRecords(
      '2000',
      [record('2001', 'm1'), record('2002', 'm2', 'm3', 'm4'), record('2003', 'm5')],
      2,
    );
    expect(take.messageIds).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(take.through).toBe('2002');
    expect(take.recordsTaken).toBe(2);
    expect(take.recordsLeft).toBe(1);
  });

  it('takes a first record larger than the cap whole, or the mailbox would stop there for ever', () => {
    const take = takeWholeRecords('2000', [record('2001', 'm1', 'm2', 'm3'), record('2002', 'm4')], 1);
    expect(take.messageIds).toEqual(['m1', 'm2', 'm3']);
    expect(take.through).toBe('2001');
    expect(take.recordsLeft).toBe(1);
  });

  it('counts a message changed by two records once, and still stands on the later record', () => {
    const take = takeWholeRecords('2000', [record('2001', 'm1'), record('2002', 'm1'), record('2003', 'm2')], 5);
    expect(take.messageIds).toEqual(['m1', 'm2']);
    expect(take.through).toBe('2003');
    expect(take.recordsLeft).toBe(0);
  });

  it('orders records past 2^53 by their value, so the earlier one is never the one left behind', () => {
    // Out of order on purpose. Under `Number` the two ids tie, a stable sort keeps
    // 993 first, the cap takes it, and the cursor stands past 992, which is lost.
    const take = takeWholeRecords(
      '9007199254740991',
      [record('9007199254740993', 'late'), record('9007199254740992', 'early')],
      1,
    );
    expect(take.messageIds).toEqual(['early']);
    expect(take.through).toBe('9007199254740992');
    expect(take.recordsLeft).toBe(1);
  });

  it('moves the cursor from 2^53 to 2^53 + 1, which Number would call the same place', () => {
    const take = takeWholeRecords(
      '9007199254740992',
      [record('9007199254740993', 'a', 'b'), record('9007199254740994', 'c')],
      1,
    );
    expect(take.through).toBe('9007199254740993');
  });
});

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

/** Every provider message id `mail_messages` holds for the mailbox. */
async function recordedMessageIds(w: MailWorld, mailbox: MailWorldMailbox): Promise<string[]> {
  const { rows } = await w.database.session.query<{ provider_message_id: string }>(
    `SELECT provider_message_id FROM mail_messages
      WHERE workspace_id = $1 AND mailbox_id = $2
      ORDER BY provider_message_id`,
    [mailbox.workspace.workspaceId, mailbox.mailboxId],
  );
  return rows.map(row => row.provider_message_id);
}

/** A message Gmail received after the baseline, in the history record `historyId`. */
const arrived = (id: string, historyId: string) =>
  fixtureMessage({
    id,
    historyId,
    from: `sender.${id}@elsewhere.example.test`,
    to: 'sales.alpha@example.test',
    body: 'Nothing FSS would match.',
  });

describe('a capped mail.sync on a real database', () => {
  it('processes every message of a record the cap falls inside, stands on that record, and finishes next pass', async () => {
    world = await createMailWorld({ alphaHistoryId: '2000' });
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const before = await readMailbox(context, w.alpha.mailboxId);
    expect(before?.historyId).toBe('2000');

    // Record 2002 carries three messages: one history change that touched several.
    w.alpha.messages.push(
      arrived('capped-m1', '2001'),
      arrived('capped-m2', '2002'),
      arrived('capped-m3', '2002'),
      arrived('capped-m4', '2002'),
      arrived('capped-m5', '2003'),
    );
    const gmail = w.clientWith(w.alpha, { historyId: '2003' });
    const deps = { ...w.syncDeps(w.alpha), gmail, maxMessages: 2 };

    const first = await runMailSync(context, deps, { mailboxId: w.alpha.mailboxId });
    expect(first.outcome).toBe('synced');
    expect(first.moreToDo).toBe(true);
    // The cap of two fell inside record 2002; the run took all of it.
    expect(gmail.metadataReads).toEqual(['capped-m1', 'capped-m2', 'capped-m3', 'capped-m4']);
    expect(first.cursorTo).toBe('2002');
    // Every message of every record at or before the cursor is recorded. Under the
    // message-sliced cap the cursor was 2002 with m3 and m4 never read.
    expect(await recordedMessageIds(w, w.alpha)).toEqual(['capped-m1', 'capped-m2', 'capped-m3', 'capped-m4']);
    // A capped run claims nothing about the mailbox.
    const capped = await readMailbox(context, w.alpha.mailboxId);
    expect(capped?.coverageWatermarkAt).toBe(before?.coverageWatermarkAt);

    const second = await runMailSync(context, deps, { mailboxId: w.alpha.mailboxId });
    expect(second.moreToDo).toBe(false);
    expect(gmail.metadataReads.slice(4)).toEqual(['capped-m5']);
    expect(second.cursorTo).toBe('2003');
    expect(await recordedMessageIds(w, w.alpha)).toEqual([
      'capped-m1',
      'capped-m2',
      'capped-m3',
      'capped-m4',
      'capped-m5',
    ]);
  });

  it('walks a cursor across ids past 2^53 one record at a time and never stalls on a tie', async () => {
    world = await createMailWorld({ alphaHistoryId: '9007199254740991' });
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    // Listed out of order: the fake orders the replay, as Gmail does.
    w.alpha.messages.push(
      arrived('big-993', '9007199254740993'),
      arrived('big-992', '9007199254740992'),
      arrived('big-994', '9007199254740994'),
    );
    const gmail = w.clientWith(w.alpha, { historyId: '9007199254740994' });
    const deps = { ...w.syncDeps(w.alpha), gmail, maxMessages: 1 };

    const cursors: (string | null)[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const outcome = await runMailSync(context, deps, { mailboxId: w.alpha.mailboxId });
      cursors.push(outcome.cursorTo);
    }
    // Under `Number`, 992 and 993 are one value: the second pass reads 993 and stays
    // at 992, and every later pass does the same.
    expect(cursors).toEqual(['9007199254740992', '9007199254740993', '9007199254740994']);
    expect(gmail.metadataReads).toEqual(['big-992', 'big-993', 'big-994']);
    expect((await readMailbox(context, w.alpha.mailboxId))?.historyId).toBe('9007199254740994');
  });
});

describe('a capped mail.sync through the HTTP adapter, answered in Google’s shape (C06)', () => {
  // https://developers.google.com/gmail/api/reference/rest/v1/users.history/list and
  // https://developers.google.com/gmail/api/reference/rest/v1/users.history#History:
  // each record is `{ id, messages, messagesAdded }`, and no record has `historyId`.
  const googleRecords = [
    { id: '3001', message: 'wire-m1' },
    { id: '3002', message: 'wire-m2' },
    { id: '3003', message: 'wire-m3' },
  ];
  const CURRENT = '3004';
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/gmail/v1/users/me/history') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 404 } }));
        return;
      }
      const start = BigInt(url.searchParams.get('startHistoryId') ?? '0');
      const history = googleRecords
        .filter(entry => BigInt(entry.id) > start)
        .map(entry => ({
          id: entry.id,
          messages: [{ id: entry.message, threadId: `thread-${entry.message}` }],
          messagesAdded: [
            { message: { id: entry.message, threadId: `thread-${entry.message}`, labelIds: ['INBOX', 'UNREAD'] } },
          ],
        }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ history, historyId: CURRENT }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('the stub server has no port');
    origin = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('moves a capped cursor forward record by record instead of re-reading the first page for ever', async () => {
    world = await createMailWorld({ alphaHistoryId: '3000' });
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    // The metadata the fake serves; its own history is not what this run reads.
    w.alpha.messages.push(arrived('wire-m1', '3001'), arrived('wire-m2', '3002'), arrived('wire-m3', '3003'));

    const wire = createGmailHttpClient({ fetch: httpFetch, apiBaseUrl: origin });
    const gmail: GmailClient = { ...w.alpha.gmail, listHistory: wire.listHistory };
    const deps = { ...w.syncDeps(w.alpha), gmail, maxMessages: 1 };

    const cursors: (string | null)[] = [];
    for (let pass = 0; pass < 3; pass += 1) {
      const outcome = await runMailSync(context, deps, { mailboxId: w.alpha.mailboxId });
      cursors.push(outcome.cursorTo);
    }
    // The old adapter answered every record with the start cursor, so this read
    // ['3000', '3000', '3000'] and only wire-m1 was ever processed.
    expect(cursors).toEqual(['3001', '3002', CURRENT]);
    expect(await recordedMessageIds(w, w.alpha)).toEqual(['wire-m1', 'wire-m2', 'wire-m3']);
  });
});
