import { seedAnotherFirm } from '../mail/support/mailWorld.ts';
import { recordMatches, resolveAmbiguity } from '../../mail/matching.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import { insertOrReviveMailbox, markMailboxDisconnected } from '../../mail/mailboxes.ts';
import { fixtureMessage } from '../mail/support/mailWorld.ts';
import { runMailSync } from '../../mail/sync.ts';
import { randomUUID } from 'node:crypto';
import { reassignFirm } from '../../crm/firms.ts';
import { recordMessage, readMessage } from '../../mail/messages.ts';
import { confirmReplyDisposition } from '../../classification/confirmations.ts';
import { withTransaction } from '../../db/queryable.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { createClassifierWorld, type ClassifierWorld } from '../classification/support/classifierWorld.ts';
import { REPLY_CORPUS } from '../corpus/replies/cases.ts';
import { buildTodaySnapshot } from '../../today/build.ts';
import { businessDateOf } from '../../today/snapshots.ts';
import { readTodayActions, openTodayAction } from '../../today/actions.ts';

let world: ClassifierWorld | null = null;
afterEach(async () => { await world?.stop(); world = null; });

describe('current Today actions', () => {
  it('keeps the source reply identity across rebuilds, opens that reply, and viewing leaves overdue work open', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const messageId = world.messageIdOf('terse-human-reply');
    const now = '2026-09-14T16:00:00.000Z';
    const first = await readTodayActions(world.context(), { now });
    const action = first.actions.find(a => a.kind === 'reply');
    expect(action).toMatchObject({ actionId: `reply-message:${messageId}`, state: 'overdue', dueAt: '2026-09-11T14:00:00.000Z', target: { kind: 'reply', messageId, firmId: world.mail.crm.alpha.firmId } });
    if (action === undefined) throw new Error('reply action absent');
    const opened = await openTodayAction(world.context(), { actionId: action.actionId, target: action.target, now });
    expect(opened).toEqual({ version: 1, target: action.target });
    expect((await openTodayAction(world.context(), { actionId: action.actionId, target: { messageId, firmId: world.mail.crm.alpha.firmId, kind: 'reply' }, now })).target).toEqual(action.target);
    await buildTodaySnapshot(world.systemContext(), { now, businessDate: await businessDateOf(world.context(), now) });
    expect((await readTodayActions(world.context(), { now })).actions.find(a => a.actionId === action.actionId)).toEqual(action);
  });
  it('labels an uncertain reply as review work until a person confirms it is substantive', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const messageId = world.messageIdOf('terse-human-reply');
    const now = '2026-09-14T16:00:00.000Z';
    expect((await readTodayActions(world.context(), { now })).actions).toMatchObject([{ reason: 'reply_review', state: 'overdue' }]);
    expect((await withTransaction(world.mail.database.session, async () => await confirmReplyDisposition(world!.context(), { messageId, disposition: 'interested', journal: world!.mail.journal }))).ok).toBe(true);
    expect((await readTodayActions(world.context(), { now })).actions).toMatchObject([{ reason: 'substantive_reply', state: 'overdue' }]);
  });
  it('classification acknowledgement does not finish an unanswered interested reply', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const messageId = world.messageIdOf('terse-human-reply');
    expect((await withTransaction(world.mail.database.session, async () => await confirmReplyDisposition(world!.context(), { messageId, disposition: 'interested', journal: world!.mail.journal }))).ok).toBe(true);
    expect((await readTodayActions(world.context(), { now: '2026-09-14T16:00:00.000Z' })).actions).toMatchObject([{ actionId: `reply-message:${messageId}`, state: 'overdue' }]);
  });

  it('suppresses an answered reply and refuses its old target', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-14T16:00:00.000Z';
    const action = (await readTodayActions(world.context(), { now })).actions[0]!;
    const original = await readMessage(world.context(), world.messageIdOf('terse-human-reply'));
    if (original === null) throw new Error('fixture message absent');
    world.mail.alpha.messages.push(fixtureMessage({ id: 'human-answer', historyId: '2001', threadId: original.providerThreadId, from: world.mail.alpha.address, to: original.headerFrom!, internalDateEpochMilliseconds: Date.parse('2026-09-11T15:00:00.000Z'), labelIds: ['SENT'], body: 'I will send a calendar invite.' }));
    await runMailSync(world.systemContext(), world.mail.syncDeps(world.mail.alpha), { mailboxId: original.mailboxId });
    expect((await readTodayActions(world.context(), { now })).actions).toEqual([]);
    expect(await openTodayAction(world.context(), { ...action, now })).toEqual({ version: 1, target: null });
  });
  it('a supported manual send to the same contact in another thread does not answer this conversation', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-14T16:00:00.000Z';
    const action = (await readTodayActions(world.context(), { now })).actions[0]!;
    const original = await readMessage(world.context(), world.messageIdOf('terse-human-reply'));
    if (original === null) throw new Error('fixture message absent');
    world.mail.alpha.messages.push(fixtureMessage({ id: 'unrelated-human-send', historyId: '2001', threadId: 'different-topic', from: world.mail.alpha.address, to: original.headerFrom!, internalDateEpochMilliseconds: Date.parse('2026-09-11T15:00:00.000Z'), labelIds: ['SENT'], body: 'Here is the separate invoice you asked about.' }));
    await runMailSync(world.systemContext(), world.mail.syncDeps(world.mail.alpha), { mailboxId: original.mailboxId });
    expect((await readTodayActions(world.context(), { now })).actions).toContainEqual(action);
    expect((await openTodayAction(world.context(), { ...action, now })).target).toEqual(action.target);
  });
  it('a same-thread internal forward without a verified firm recipient does not answer the reply', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-14T16:00:00.000Z';
    const action = (await readTodayActions(world.context(), { now })).actions[0]!;
    const original = await readMessage(world.context(), world.messageIdOf('terse-human-reply'));
    if (original === null) throw new Error('fixture message absent');
    world.mail.alpha.messages.push(fixtureMessage({ id: 'internal-forward', historyId: '2001', threadId: original.providerThreadId, from: world.mail.alpha.address, to: 'colleague@internal.example.test', internalDateEpochMilliseconds: Date.parse('2026-09-11T15:00:00.000Z'), labelIds: ['SENT'], body: 'Can you advise how to respond?' }));
    await runMailSync(world.systemContext(), world.mail.syncDeps(world.mail.alpha), { mailboxId: original.mailboxId });
    expect((await readTodayActions(world.context(), { now })).actions).toContainEqual(action);
  });
  it('revokes the former owner’s reply action immediately after reassignment', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-14T16:00:00.000Z';
    const action = (await readTodayActions(world.context(), { now })).actions[0]!;
    expect((await withTransaction(world.mail.database.session, async () => await reassignFirm(world!.adminContext(), { firmId: world!.mail.crm.alpha.firmId, toUserId: world!.mail.seeded.alpha.admin.userId }))).ok).toBe(true);
    expect(await openTodayAction(world.context(), { ...action, now })).toEqual({ version: 1, target: null });
  });
  it('shows a current booked call with its exact meeting identity', async () => {
    world = await createClassifierWorld({ cases: [] });
    const meetingId = randomUUID();
    await world.mail.database.session.query("INSERT INTO meetings(workspace_id,id,booking_uid,current_booking_uid,firm_id,state,starts_at,ends_at,last_event_at) VALUES ($1,$2,'today-call','today-call',$3,'booked','2026-09-15T15:00:00Z','2026-09-15T15:30:00Z','2026-09-14T12:00:00Z')", [world.mail.seeded.alpha.workspaceId,meetingId,world.mail.crm.alpha.firmId]);
    const now = '2026-09-14T16:00:00.000Z';
    expect((await readTodayActions(world.context(), { now })).actions).toMatchObject([{ actionId: `meeting:${meetingId}`, kind: 'call', target: { kind: 'meeting', meetingId, firmId: world.mail.crm.alpha.firmId, startsAt: '2026-09-15T15:00:00.000Z' } }]);
  });

  it('keeps healthy routine work quiet and links an owned disconnected mailbox to settings', async () => {
    world = await createClassifierWorld({ cases: [] });
    const now = '2026-09-14T16:00:00.000Z';
    expect((await readTodayActions(world.context(), { now })).actions).toEqual([]);
    const mailbox = await insertOrReviveMailbox(world.systemContext(), { ownerUserId: world.mail.seeded.alpha.admin.userId, emailAddress: 'admin@example.test', providerAccountId: 'admin-fixture', baselineFromAt: '2026-08-01T00:00:00.000Z' });
    await markMailboxDisconnected(world.systemContext(), { mailboxId: mailbox.id, status: 'revoked', reason: 'the Gmail grant was revoked' });
    const action = (await readTodayActions(world.adminContext(), { now })).actions[0]!;
    expect(action).toMatchObject({ kind: 'problem', reason: 'mailbox_disconnected', target: { kind: 'settings', tab: 'administration', section: 'sending-admin', mailboxId: mailbox.id } });
    expect((await openTodayAction(world.adminContext(), { ...action, now })).target).toEqual(action.target);
  });

  it('keeps intentional disconnects and mailboxes outside a reachable owned admin setting quiet', async () => {
    world = await createClassifierWorld({ cases: [] });
    const now = '2026-09-14T16:00:00.000Z';
    const mailbox = await insertOrReviveMailbox(world.systemContext(), { ownerUserId: world.mail.seeded.alpha.admin.userId, emailAddress: 'admin@example.test', providerAccountId: 'admin-fixture', baselineFromAt: '2026-08-01T00:00:00.000Z' });
    await markMailboxDisconnected(world.systemContext(), { mailboxId: mailbox.id, status: 'disconnected', reason: 'owner_requested' });
    expect((await readTodayActions(world.adminContext(), { now })).actions).toEqual([]);
    await markMailboxDisconnected(world.systemContext(), { mailboxId: world.mail.alpha.mailboxId, status: 'revoked', reason: 'the Gmail grant was revoked' });
    expect((await readTodayActions(world.context(), { now })).actions).toEqual([]);
    expect((await readTodayActions(world.adminContext(), { now })).actions).toEqual([]);
    expect((await readTodayActions(world.systemContext(), { now })).actions).toEqual([]);
  });

  it('a newer substantive message replaces the old conversation action and invalidates its target', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-14T16:00:00.000Z';
    const old = (await readTodayActions(world.context(), { now })).actions[0]!;
    const original = await readMessage(world.context(), world.messageIdOf('terse-human-reply'));
    if (original === null) throw new Error('fixture message absent');
    world.mail.alpha.messages.push(fixtureMessage({ id: 'newer-question', historyId: '2001', threadId: original.providerThreadId, from: original.headerFrom!, to: world.mail.alpha.address, internalDateEpochMilliseconds: Date.parse('2026-09-11T15:00:00.000Z'), body: 'One more question about the call.' }));
    await runMailSync(world.systemContext(), world.mail.syncDeps(world.mail.alpha), { mailboxId: original.mailboxId });
    expect((await readTodayActions(world.context(), { now })).actions).toHaveLength(1);
    expect(await openTodayAction(world.context(), { ...old, now })).toEqual({ version: 1, target: null });
  });

  it('keeps the resolved conversation action when a newer message has unresolved firm ambiguity', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-14T16:00:00.000Z';
    const old = (await readTodayActions(world.context(), { now })).actions[0]!;
    const original = await readMessage(world.context(), world.messageIdOf('terse-human-reply'));
    if (original === null) throw new Error('fixture message absent');
    world.mail.alpha.messages.push(fixtureMessage({ id: 'ambiguous-follow-on', historyId: '2001', threadId: original.providerThreadId, from: original.headerFrom!, to: world.mail.alpha.address, internalDateEpochMilliseconds: Date.parse('2026-09-11T15:00:00.000Z'), body: 'One more question about the call.' }));
    await runMailSync(world.systemContext(), world.mail.syncDeps(world.mail.alpha), { mailboxId: original.mailboxId });
    const newer = (await readTodayActions(world.context(), { now })).actions[0]!;
    if (newer.target.kind !== 'reply') throw new Error('fixture reply absent');
    const second = await seedAnotherFirm(world.mail, world.mail.seeded.alpha, { name: 'Other Possible Firm', address: 'reception@northwind.example.test' });
    await withTransaction(world.mail.database.session, async () => await recordMatches(world!.systemContext(), { messageId: newer.target.kind === 'reply' ? newer.target.messageId : '', candidates: [{ ...second, contactId: second.contactId, rule: 'participant', viaClosedOpportunity: false }] }));
    expect((await readTodayActions(world.context(), { now })).actions).toEqual([old]);
  });
  it('later unverified or automatic sent metadata does not erase an unanswered reply', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-14T16:00:00.000Z';
    const action = (await readTodayActions(world.context(), { now })).actions[0]!;
    const original = await readMessage(world.context(), world.messageIdOf('terse-human-reply'));
    if (original === null) throw new Error('fixture message absent');
    await recordMessage(world.systemContext(), { mailboxId: original.mailboxId, metadata: { ...original, providerMessageId: 'later-sent-metadata', rfcMessageId: 'later-sent@example.test', direction: 'outgoing', internalDate: '2026-09-11T15:00:00.000Z', labelIds: ['SENT'], attachments: [] } });
    expect((await readTodayActions(world.context(), { now })).actions).toContainEqual(action);
  });
  it('rescheduling invalidates an old call target and cancellation suppresses the current action', async () => {
    world = await createClassifierWorld({ cases: [] });
    const meetingId = randomUUID();
    await world.mail.database.session.query("INSERT INTO meetings(workspace_id,id,booking_uid,current_booking_uid,firm_id,state,starts_at,ends_at,last_event_at) VALUES ($1,$2,'todaycall','todaycall',$3,'booked','2026-09-15T15:00:00Z','2026-09-15T15:30:00Z','2026-09-14T12:00:00Z')", [world.mail.seeded.alpha.workspaceId,meetingId,world.mail.crm.alpha.firmId]);
    const now = '2026-09-14T16:00:00.000Z';
    const old = (await readTodayActions(world.context(), { now })).actions[0]!;
    const body = { triggerEvent: 'BOOKING_RESCHEDULED', createdAt: '2026-09-14T13:00:00Z', payload: { uid: 'newtodaycall', rescheduleUid: 'todaycall', startTime: '2026-09-16T15:00:00Z', endTime: '2026-09-16T15:30:00Z', attendees: [{ email: 'reception@northwind.example.test' }] } };
    await withTransaction(world.mail.database.session, async () => await receiveCalcomEvent(world!.mail.database.session, { workspaceId: world!.mail.seeded.alpha.workspaceId, rawBody: Buffer.from(JSON.stringify(body)), body }));
    expect((await openTodayAction(world.context(), { ...old, now })).target).toBeNull();
    const current = (await readTodayActions(world.context(), { now })).actions[0]!;
    expect(current.target).toMatchObject({ meetingId, startsAt: '2026-09-16T15:00:00.000Z' });
    const cancelled = { ...body, triggerEvent: 'BOOKING_CANCELLED', createdAt: '2026-09-14T14:00:00Z' };
    await withTransaction(world.mail.database.session, async () => await receiveCalcomEvent(world!.mail.database.session, { workspaceId: world!.mail.seeded.alpha.workspaceId, rawBody: Buffer.from(JSON.stringify(cancelled)), body: cancelled }));
    expect((await readTodayActions(world.context(), { now })).actions).toEqual([]);
  });

  it('does not invent a firm context for an ambiguous reply, and uses the explicitly resolved conversation', async () => {
    world = await createClassifierWorld({ cases: REPLY_CORPUS.filter(c => c.id === 'terse-human-reply') });
    const now = '2026-09-14T16:00:00.000Z';
    const messageId = world.messageIdOf('terse-human-reply');
    const second = await seedAnotherFirm(world.mail, world.mail.seeded.alpha, { name: 'Other Possible Firm', address: 'reception@northwind.example.test' });
    await withTransaction(world.mail.database.session, async () => await recordMatches(world!.systemContext(), { messageId, candidates: [{ ...second, contactId: second.contactId, rule: 'participant', viaClosedOpportunity: false }] }));
    expect((await readTodayActions(world.context(), { now })).actions).toEqual([]);
    expect((await withTransaction(world.mail.database.session, async () => await resolveAmbiguity(world!.context(), { messageId, selectedOpportunityId: second.opportunityId, human: true }))).ok).toBe(true);
    expect((await readTodayActions(world.context(), { now })).actions).toMatchObject([{ subject: 'Other Possible Firm', target: { messageId, firmId: second.firmId } }]);
  });

});
