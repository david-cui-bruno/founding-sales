import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { weekViewSchema, type V1CallOutcome } from '../../../../../src/shared/contracts/v1Contract';
import { recordAttempt } from '../../src/v1/attempts';
import { callKey, callbackKey, callRecordSchema, callbackRecordSchema } from '../../src/v1/calls';
import { firmKey, firmRecordSchema } from '../../src/v1/firmsWrite';
import { replyKey, replyRecordSchema } from '../../src/v1/mail';
import { sendKey, sendRecordSchema } from '../../src/v1/send';
import { easternWeek, readWeekView } from '../../src/v1/week';
import { researchCounterKey, researchCounterSchema } from '../../src/v1/pool';
import { v1Fixture } from './v1Fixture';

/**
 * `GET /v1/week` on the real handler (FSS target design section 3; slice S5). Every number comes from a permanent
 * record seeded here exactly as the worker writes it, and every day is an America/New_York calendar day: the two
 * boundary cases below are the point of the test, because a call at 21:00 Eastern belongs to the day David was
 * living in and not to the UTC day it happens to fall in. Nothing in this file sends, dials or reaches a provider.
 */

const START = '2026-09-18T12:00:00.000Z';
/** Eastern is UTC-4 on these dates, so 04:00 UTC is midnight in New York. */
const LAST_EASTERN_MOMENT_OF_SEP_11 = '2026-09-12T03:59:59.000Z';
const FIRST_EASTERN_MOMENT_OF_SEP_12 = '2026-09-12T04:00:00.000Z';
const LATE_ON_SEP_18 = '2026-09-19T01:00:00.000Z';

const dial = { dialAllowed: true, holdReason: null, holdCode: null, localTime: '13:00', openNow: true };

function callRecord(firmId: string, outcome: V1CallOutcome, observedAt: string) {
  return callRecordSchema.parse({ version: 1, firmId, outcome, note: null, callbackOn: null, neverCallReason: null, routeId: 'route-listed',
    observedAt, recordedAt: observedAt, dial, deviceId: randomUUID(), commandId: randomUUID() });
}
function sendRecord(firmId: string, stepId: string, state: 'accepted' | 'dispatching', sentAt: string | null) {
  return sendRecordSchema.parse({ version: 1, firmId, stepId, state, contextRevision: 1, jobId: `send:${firmId}:${stepId}`,
    messageId: `<send-${firmId}-${stepId}@callie.invalid>`, providerMessageId: state === 'accepted' ? `sent-${stepId}` : null, providerThreadId: null,
    frozen: { from: 'founder@usecallie.invalid', to: `contact@${firmId}.invalid`, subject: 'Fictional subject', body: 'Fictional body' },
    templateId: 'T4', claimedAt: sentAt ?? START, sentAt, reconciledAt: null, noRetry: false, reason: null });
}
function replyRecord(messageId: string, firmId: string, receivedAt: string) {
  return replyRecordSchema.parse({ version: 1, gmailMessageId: messageId, threadId: `thread-${messageId}`, firmId, matchedBy: 'message_id',
    classification: { kind: 'substantive', evidence: [{ messageId, quote: 'Fictional quote' }], requiresApproval: true },
    sender: `contact@${firmId}.invalid`, subject: 'Re: Fictional subject', receivedAt, at: receivedAt, draftId: null, decision: null,
    resolvedAt: null, stepId: null });
}
function callbackRecord(firmId: string, dueOn: string, promisedAt: string, resolved: { state: 'made'; resolvedAt: string } | null) {
  return callbackRecordSchema.parse({ version: 1, firmId, dueOn, promisedAt, promisedBy: `CALL#${firmId}#${promisedAt}`,
    state: resolved?.state ?? 'pending', resolvedAt: resolved?.resolvedAt ?? null });
}
/**
 * A `FIRM#` row as the firm source reads it. `researchRevision` above zero is what says research worked on this
 * firm at all, and `researchedAt` is when it last did: the Week view counts on exactly those two and on nothing
 * else, so a hand-entered firm (revision zero) is never counted however recently it was added.
 */
function firmRecord(firmId: string, enteredBy: 'research' | 'hand', at: string) {
  return firmRecordSchema.parse({ version: 1, firmId, name: `Firm ${firmId}`, domain: `${firmId}.example`, city: 'Providence', state: 'RI',
    timeZone: 'America/New_York', derivedZoneFrom: 'territory_state_map', status: 'listed', enteredBy,
    evidenceSummary: enteredBy === 'research' ? '3 sources' : '', routes: [], enteredAt: at, updatedAt: at,
    ...(enteredBy === 'research' ? { researchRevision: 1, researchedAt: at } : {}) });
}

describe('GET /v1/week: the last seven Eastern days from the permanent records', () => {
  it('counts calls by outcome, emails, replies, callbacks promised and kept, firms researched, spend and holds', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    expect((await f.request('GET', '/v1/week')).statusCode).toBe(401);

    const put = (key: string, value: unknown) => f.store.transact([f.store.put(key, value, null)]);
    // Three calls inside the week, two of them the same outcome; one call a week and a day old.
    await put(callKey('account-a', '2026-09-15T14:00:00.000Z'), callRecord('account-a', 'voicemail', '2026-09-15T14:00:00.000Z'));
    await put(callKey('account-b', '2026-09-16T14:00:00.000Z'), callRecord('account-b', 'voicemail', '2026-09-16T14:00:00.000Z'));
    await put(callKey('account-c', '2026-09-17T14:00:00.000Z'), callRecord('account-c', 'answered_interested', '2026-09-17T14:00:00.000Z'));
    await put(callKey('account-d', '2026-09-10T14:00:00.000Z'), callRecord('account-d', 'no_answer', '2026-09-10T14:00:00.000Z'));
    // Two accepted sends and one still dispatching: only what left the building is an email sent.
    await put(sendKey('account-a', 'step-1'), sendRecord('account-a', 'step-1', 'accepted', '2026-09-16T15:00:00.000Z'));
    await put(sendKey('account-b', 'step-1'), sendRecord('account-b', 'step-1', 'accepted', '2026-09-17T15:00:00.000Z'));
    await put(sendKey('account-c', 'step-1'), sendRecord('account-c', 'step-1', 'dispatching', null));
    await put(replyKey('gmail-1'), replyRecord('gmail-1', 'account-a', '2026-09-17T16:00:00.000Z'));
    // One callback promised and kept, one promised and still pending, one kept from a promise made before the week.
    await put(callbackKey('2026-09-18', 'account-a'), callbackRecord('account-a', '2026-09-18', '2026-09-15T14:00:00.000Z', { state: 'made', resolvedAt: '2026-09-18T14:00:00.000Z' }));
    await put(callbackKey('2026-09-25', 'account-b'), callbackRecord('account-b', '2026-09-25', '2026-09-17T14:00:00.000Z', null));
    await put(callbackKey('2026-09-14', 'account-e'), callbackRecord('account-e', '2026-09-14', '2026-09-01T14:00:00.000Z', { state: 'made', resolvedAt: '2026-09-14T14:00:00.000Z' }));
    // Research: two firms researched inside the week, one entered by hand the same day, one researched before it.
    await put(firmKey('account-a'), firmRecord('account-a', 'research', '2026-09-16T12:00:00.000Z'));
    await put(firmKey('account-b'), firmRecord('account-b', 'research', '2026-09-17T12:00:00.000Z'));
    await put(firmKey('account-f'), firmRecord('account-f', 'hand', '2026-09-17T12:00:00.000Z'));
    await put(firmKey('account-g'), firmRecord('account-g', 'research', '2026-09-01T12:00:00.000Z'));
    // Spend: S4's counters keep three days, so only the newest days of the week still have one.
    await put(researchCounterKey('2026-09-16'), researchCounterSchema.parse({ version: 1, date: '2026-09-16', spent: 25, budget: 60, updatedAt: '2026-09-16T23:00:00.000Z' }));
    await put(researchCounterKey('2026-09-17'), researchCounterSchema.parse({ version: 1, date: '2026-09-17', spent: 15, budget: 60, updatedAt: '2026-09-17T23:00:00.000Z' }));
    // Holds, from the attempt log: two of one code, one of another, and one attempt that is not a hold at all.
    for (const at of ['2026-09-16T05:00:00.000Z', '2026-09-17T05:00:00.000Z']) { f.advance(at); await recordAttempt(f.store, { kind: 'hold', outcome: 'held', reason: 'cap_reached', detail: null, durationMs: null, ref: null }); }
    f.advance('2026-09-17T05:00:01.000Z'); await recordAttempt(f.store, { kind: 'hold', outcome: 'held', reason: 'template_not_approved', detail: null, durationMs: null, ref: null });
    f.advance('2026-09-17T05:00:02.000Z'); await recordAttempt(f.store, { kind: 'send', outcome: 'ok', reason: null, detail: null, durationMs: 10, ref: null });
    f.advance(START);

    const view = weekViewSchema.parse(f.json(await f.request('GET', '/v1/week', { authorization: device.bearer })));
    expect(view.from).toBe('2026-09-12');
    expect(view.to).toBe('2026-09-18');
    expect(view.days.map(day => day.date)).toEqual(['2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18']);
    expect(view.calls).toEqual({ total: 3, byOutcome: [{ outcome: 'answered_interested', count: 1 }, { outcome: 'voicemail', count: 2 }] });
    expect(view.emailsSent).toBe(2);
    expect(view.replies).toBe(1);
    expect(view.callbacks).toEqual({ promised: 2, kept: 2 });
    expect(view.firmsResearched).toBe(2);
    expect(view.spend).toEqual({ spent: 40, daysCounted: 2, daysMissing: 5, counterKeepsDays: 3 });
    expect(view.holds).toEqual([{ reason: 'cap_reached', code: 'cap_reached', count: 2 }, { reason: 'template_not_approved', code: 'template_not_approved', count: 1 }]);

    // The per-day rows add up to the totals and put each record on the day it happened.
    const day = (date: string) => view.days.find(entry => entry.date === date)!;
    expect(day('2026-09-16')).toEqual({ date: '2026-09-16', calls: 1, emailsSent: 1, replies: 0, callbacksPromised: 0, callbacksKept: 0, firmsResearched: 1 });
    expect(day('2026-09-17')).toEqual({ date: '2026-09-17', calls: 1, emailsSent: 1, replies: 1, callbacksPromised: 1, callbacksKept: 0, firmsResearched: 1 });
    expect(day('2026-09-18')).toEqual({ date: '2026-09-18', calls: 0, emailsSent: 0, replies: 0, callbacksPromised: 0, callbacksKept: 1, firmsResearched: 0 });
    expect(view.days.reduce((total, entry) => total + entry.calls, 0)).toBe(view.calls.total);
    expect(view.days.reduce((total, entry) => total + entry.emailsSent, 0)).toBe(view.emailsSent);
  });

  it('puts each record on its Eastern day, not its UTC day, at both edges of the window', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    const put = (key: string, value: unknown) => f.store.transact([f.store.put(key, value, null)]);
    // 03:59:59 UTC on the 12th is 23:59:59 Eastern on the 11th: a day before the window opens.
    await put(callKey('account-before', LAST_EASTERN_MOMENT_OF_SEP_11), callRecord('account-before', 'busy', LAST_EASTERN_MOMENT_OF_SEP_11));
    // 04:00:00 UTC on the 12th is 00:00:00 Eastern on the 12th: the first moment of the oldest day in the window.
    await put(callKey('account-first', FIRST_EASTERN_MOMENT_OF_SEP_12), callRecord('account-first', 'busy', FIRST_EASTERN_MOMENT_OF_SEP_12));
    // 01:00 UTC on the 19th is 21:00 Eastern on the 18th: today, the day David was living in.
    await put(callKey('account-late', LATE_ON_SEP_18), callRecord('account-late', 'busy', LATE_ON_SEP_18));

    const view = weekViewSchema.parse(f.json(await f.request('GET', '/v1/week', { authorization: device.bearer })));
    expect(view.calls.total).toBe(2);
    expect(view.days.find(day => day.date === '2026-09-12')?.calls).toBe(1);
    expect(view.days.find(day => day.date === '2026-09-18')?.calls).toBe(1);
  });

  it('says a week with nothing in it is empty, and never reads a missing spend counter as zero', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    const view = weekViewSchema.parse(f.json(await f.request('GET', '/v1/week', { authorization: device.bearer })));
    expect(view.calls).toEqual({ total: 0, byOutcome: [] });
    expect(view).toMatchObject({ emailsSent: 0, replies: 0, callbacks: { promised: 0, kept: 0 }, firmsResearched: 0, holds: [] });
    expect(view.spend).toEqual({ spent: null, daysCounted: 0, daysMissing: 7, counterKeepsDays: 3 });
    expect(view.days.every(day => day.calls === 0 && day.emailsSent === 0)).toBe(true);
    // The same view read through the module is the same seven Eastern days the route served.
    expect((await readWeekView(f.store)).days.map(day => day.date)).toEqual(easternWeek(START));
  });
});
