import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { MeetingNoteItem } from '@fss/contracts';
import { withTransaction } from '../../db/queryable.ts';
import { prepareMeetingRecap, readMeetingFollowThrough } from '../../meetings/followThrough.ts';
import { enrollMeetingFollowThrough, resolveMeetingFollowThroughScope, verifyMeetingFollowThrough } from '../../meetings/followThroughEligibility.ts';
import { grantFollowUpPermission, readFollowUpPermission, verifyFollowUpPermission } from '../../sequences/followUpPermissions.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { meetingFollowThroughFixture, RECAP_AT } from './support/meetingFollowThroughFixture.ts';

describe('meeting-backed follow-through authority', () => {
  let f: Awaited<ReturnType<typeof meetingFollowThroughFixture>>;
  beforeEach(async () => { f = await meetingFollowThroughFixture(); });
  afterEach(async () => { await f.db.drop(); });
  const tx = <T>(fn: () => Promise<T>) => withTransaction(f.db.session, fn);
  const scope = async (r: Awaited<ReturnType<typeof f.ready>>, contactId = r.contactId) => resolveMeetingFollowThroughScope(f.context, { meetingId: r.meetingId, contactId, sourceHash: r.expectedSourceHash });
  async function prepared() {
    const r = await f.ready();
    const opportunityId = (await f.db.session.query<{ id: string }>(`INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at)
      SELECT $1,$2,id,now() FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1 RETURNING id`, [f.workspace, f.firmId])).rows[0]!.id;
    const at = (await f.db.session.query<{ at: Date }>(`UPDATE meetings SET opportunity_id=$2,starts_at=clock_timestamp()-interval '60 minutes',ends_at=clock_timestamp()-interval '40 minutes',attendance_confirmed_at=clock_timestamp()-interval '40 minutes' WHERE id=$1 RETURNING clock_timestamp() AS at`, [r.meetingId, opportunityId])).rows[0]!.at.toISOString();
    const current = { ...r, ...await f.publish(r.meetingId, r.items) };
    const result = await tx(() => prepareMeetingRecap(f.context, { ...current, at }));
    if (!result.ok || result.value.planId === null) throw new Error(`fixture plan: ${JSON.stringify(result)}`);
    await f.db.session.query('UPDATE meeting_follow_through SET pause_observed_at=NULL WHERE id=$1', [result.value.planId]);
    return { ...current, opportunityId, at, planId: result.value.planId, version: result.value.version, draftVersion: result.value.currentDraft!.version };
  }
  it('limits a routine attended demo to its one recipient, three messages and 30 days from completion', async () => {
    const r = await f.ready(), result = await scope(r);
    expect(result).toMatchObject({ ok: true, value: { contactId: r.contactId, meetingId: r.meetingId, purposes: ['recap', 'nudge'], maxMessages: 3, expiresAt: '2026-11-04T14:20:00.000Z' } });
    expect(await scope(r, randomUUID())).toMatchObject({ ok: false, reason: 'recipient_changed' });
  });
  it.each(['booked', 'cancelled'])('refuses %s meetings', async state => {
    const r = await f.ready();
    await f.db.session.query('UPDATE meetings SET state=$2,attendance_source=NULL,attendance_confirmed_at=NULL,attendance_confirmed_by=NULL WHERE id=$1', [r.meetingId, state]);
    expect(await scope(r)).toMatchObject({ ok: false });
  });
  it('refuses incomplete or revised sources, even with a booking label', async () => {
    const r = await f.ready();
    await f.save(r.meetingId, 'A changed debrief', 1);
    expect(await scope(r)).toMatchObject({ ok: false, reason: 'source_changed' });
    expect(await tx(() => grantFollowUpPermission(f.context, { firmId: f.firmId, contactId: r.contactId, bookingReference: 'invented-booking', grantedByUserId: f.seeded.alpha.admin.userId }))).toEqual({ ok: false, reason: 'follow_up_not_permitted' });
  });
  it('holds a narrower or negative request instead of assuming the default cadence', async () => {
    const r = await f.ready();
    await f.save(r.meetingId, 'Please only send one email; no follow ups.', 1);
    const a = await f.publish(r.meetingId, []);
    expect(await scope({ ...r, ...a })).toMatchObject({ ok: false, reason: 'scope_needs_review' });
  });
  it('preserves a single explicitly promised reminder with its evidence', async () => {
    const r = await f.ready();
    const quote = 'I will send one reminder on October 12.';
    await f.save(r.meetingId, quote, 1);
    const item: MeetingNoteItem = { id: 'reminder', kind: 'next_step', text: quote, owner: 'you', provenance: 'stated', deadline: { precision: 'date', localDate: '2026-10-12', zone: 'America/New_York' }, deadlineText: 'October 12', reviewReasons: [], evidence: [{ kind: 'debrief', revision: 2, quote, startOffset: 0, endOffset: quote.length }] };
    const a = await f.publish(r.meetingId, [item]);
    expect(await scope({ ...r, ...a })).toMatchObject({ ok: true, value: { maxMessages: 1, purposes: ['reminder'], agreedReminder: item.deadline } });
  });
  it('enrolls once with a real booking permission; aliases still resolve the same meeting', async () => {
    const r = await prepared();
    const enrolled = await tx(() => enrollMeetingFollowThrough(f.context, { ...r, expectedVersion: r.version }));
    expect(enrolled.ok).toBe(true); if (!enrolled.ok) return;
    expect(await tx(() => enrollMeetingFollowThrough(f.context, { ...r, expectedVersion: r.version }))).toEqual(enrolled);
    const plan = (await f.db.session.query<{ permission_id: string }>('SELECT permission_id FROM meeting_follow_through WHERE id=$1', [r.planId])).rows[0]!;
    const permission = (await readFollowUpPermission(f.context, plan.permission_id))!;
    expect(permission.kind).toBe('booking'); expect(permission.scope).toBe('booking_communications'); expect(permission.callLogId).toBeNull();
    const alias = 'previous-booking';
    await f.db.session.query('INSERT INTO meeting_booking_uids(workspace_id,booking_uid,meeting_id) VALUES($1,$2,$3)', [f.workspace, alias, r.meetingId]);
    await f.db.session.query('UPDATE follow_up_permissions SET booking_reference=$2 WHERE id=$1', [permission.id, alias]);
    const subject = { firmId: f.firmId, contactId: r.contactId, now: r.at, sequenceVersionId: r.sequenceVersionId, enrollmentId: enrolled.value.enrollmentId, stepCount: 3, stepOrdinal: 1 };
    expect(await verifyFollowUpPermission(f.context, permission.id, subject)).toMatchObject({ ok: true });
    expect(await verifyFollowUpPermission(f.context, permission.id, { ...subject, stepOrdinal: 4 })).toMatchObject({ ok: false });
    expect(await verifyFollowUpPermission(f.context, permission.id, { ...subject, sequenceVersionId: randomUUID() })).toMatchObject({ ok: false });
    expect(await verifyFollowUpPermission(f.context, permission.id, { ...subject, now: '2030-01-01T00:00:00Z' })).toMatchObject({ ok: false });
  });
  it('holds instead of manufacturing a deal or overriding a human takeover', async () => {
    const r = await prepared();
    await f.db.session.query('UPDATE meetings SET opportunity_id=NULL WHERE id=$1', [r.meetingId]);
    expect(await tx(() => enrollMeetingFollowThrough(f.context, { ...r, expectedVersion: r.version }))).toMatchObject({ ok: false, reason: 'opportunity_required' });
    await f.db.session.query('UPDATE meetings SET opportunity_id=$2 WHERE id=$1', [r.meetingId, r.opportunityId]);
    await f.db.session.query("UPDATE opportunities SET control_mode='manual',control_mode_origin='salesperson_command',control_mode_reason='I will handle it',control_mode_changed_at=now() WHERE id=$1", [r.opportunityId]);
    expect(await tx(() => enrollMeetingFollowThrough(f.context, { ...r, expectedVersion: r.version }))).toMatchObject({ ok: false, reason: 'opportunity_manual' });
  });
  it('refuses another active contact at the firm', async () => {
    const r = await prepared();
    const other = (await f.db.session.query<{ id: string }>("INSERT INTO contacts(workspace_id,firm_id,full_name) VALUES($1,$2,'Other attendee') RETURNING id", [f.workspace, f.firmId])).rows[0]!.id;
    const existing = await tx(() => enrollContact(f.context, { firmId: f.firmId, opportunityId: r.opportunityId, contactId: other, sequenceVersionId: r.sequenceVersionId, originKind: 'prospecting' }));
    expect(existing.ok).toBe(true);
    expect(await tx(() => enrollMeetingFollowThrough(f.context, { ...r, expectedVersion: r.version }))).toMatchObject({ ok: false, reason: 'firm_already_enrolled' });
  });
  it('keeps the one-contact rule when prospecting tries to start after a meeting plan', async () => {
    const r = await prepared();
    expect((await tx(() => enrollMeetingFollowThrough(f.context, { ...r, expectedVersion: r.version }))).ok).toBe(true);
    const other = (await f.db.session.query<{ id: string }>("INSERT INTO contacts(workspace_id,firm_id,full_name) VALUES($1,$2,'Another manager') RETURNING id", [f.workspace, f.firmId])).rows[0]!.id;
    expect(await tx(() => enrollContact(f.context, { firmId: f.firmId, opportunityId: r.opportunityId, contactId: other, sequenceVersionId: r.sequenceVersionId, originKind: 'prospecting' }))).toMatchObject({ ok: false, reason: 'firm_already_enrolled' });
  });
  it('will not expand a reminder past the existing thirty-day scope', async () => {
    const r = await f.ready();
    const quote = 'I will send one reminder on December 12.';
    await f.save(r.meetingId, quote, 1);
    const item: MeetingNoteItem = { id: 'later', kind: 'next_step', text: quote, owner: 'you', provenance: 'stated', deadline: null, deadlineText: 'December 12', reviewReasons: [], evidence: [{ kind: 'debrief', revision: 2, quote, startOffset: 0, endOffset: quote.length }] };
    const a = await f.publish(r.meetingId, [item]);
    expect(await scope({ ...r, ...a })).toMatchObject({ ok: false, reason: 'reminder_outside_scope' });
  });
  it('rechecks draft, source and recipient at the execution boundary', async () => {
    const r = await prepared();
    const enrolled = await tx(() => enrollMeetingFollowThrough(f.context, { ...r, expectedVersion: r.version }));
    if (!enrolled.ok) throw new Error(enrolled.reason);
    const executionId = (await f.db.session.query<{ id: string }>('SELECT id FROM step_executions WHERE enrollment_id=$1', [enrolled.value.enrollmentId])).rows[0]!.id;
    const input = { planId: r.planId, executionId, draftVersion: r.draftVersion, at: new Date(Date.parse(r.at) + 31 * 60_000).toISOString() };
    expect(await verifyMeetingFollowThrough(f.context, input)).toMatchObject({ ok: true });
    expect(await verifyMeetingFollowThrough(f.context, { ...input, draftVersion: 99 })).toMatchObject({ ok: false, reason: 'draft_changed' });
    await f.save(r.meetingId, 'We discussed something else', 1);
    expect(await verifyMeetingFollowThrough(f.context, input)).toMatchObject({ ok: false, reason: 'source_changed' });
    expect((await readMeetingFollowThrough(f.context, { meetingId: r.meetingId }))!.status).toBe('needs_review');
  });
  it('refuses revoked permission and a changed assignee at the final boundary', async () => {
    const r = await prepared();
    const enrolled = await tx(() => enrollMeetingFollowThrough(f.context, { ...r, expectedVersion: r.version }));
    if (!enrolled.ok) throw new Error(enrolled.reason);
    const executionId = (await f.db.session.query<{ id: string }>('SELECT id FROM step_executions WHERE enrollment_id=$1', [enrolled.value.enrollmentId])).rows[0]!.id;
    const input = { planId: r.planId, executionId, draftVersion: r.draftVersion, at: new Date(Date.parse(r.at) + 31 * 60_000).toISOString() };
    await f.db.session.query('UPDATE follow_up_permissions SET revoked_at=now() WHERE enrollment_id=$1', [enrolled.value.enrollmentId]);
    expect(await verifyMeetingFollowThrough(f.context, input)).toMatchObject({ ok: false, reason: 'revoked' });
    await f.db.session.query('UPDATE follow_up_permissions SET revoked_at=NULL WHERE enrollment_id=$1', [enrolled.value.enrollmentId]);
    await f.db.session.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [f.firmId, f.seeded.alpha.admin.userId]);
    expect(await verifyMeetingFollowThrough(f.context, input)).toMatchObject({ ok: false, reason: 'not_assigned' });
  });
  it('does not produce a live permission for unresolved or unready content', async () => {
    const r = await f.ready({ approved: false });
    const plan = await tx(() => prepareMeetingRecap(f.context, { ...r, at: RECAP_AT }));
    if (!plan.ok) throw new Error(plan.reason);
    expect(await tx(() => enrollMeetingFollowThrough(f.context, { planId: plan.value.planId!, expectedVersion: plan.value.version, at: RECAP_AT }))).toMatchObject({ ok: false });
    expect((await f.db.session.query('SELECT id FROM follow_up_permissions')).rows).toHaveLength(0);
  });
});
