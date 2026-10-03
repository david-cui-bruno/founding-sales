import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetingBriefResponseSchema } from '@fss/contracts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { readMeetingBrief } from '../../meetings/brief.ts';
import { answer, lines } from '../calls/analysisFixtures.ts';
import { createApplyWorld, type ApplyWorld, type TestFirm } from '../calls/support/applyWorld.ts';

/**
 * Lane M2: `readMeetingBrief` on real PostgreSQL — the sources read through the production
 * readers (a placed, transcribed and analysed call; a stored summary; a logged call with no
 * session; a prepared brief; e-mail threads), and who may read it. No real business or
 * person: every domain is `.example.test`.
 */

const UTTERANCES = lines(
  ['Y', 'Hi Dana, this is David from Callie.'],
  ['T', 'Texts are a mess for us. Can you show us a demo?'],
  ['Y', 'Absolutely. I will send you a calendar link today.'],
  ['T', 'It sounds expensive though.'],
);
const ANALYSED = answer({
  summary: 'You reached Dana. She asked for a demo and worried about the price.',
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
  objections: [{ category: 'price', quote: 'It sounds expensive though.', line: 4, answered_line: 0 }],
  commitments: [{ speaker: 'you', quote: 'I will send you a calendar link today', line: 3, due_phrase: 'today' }],
});

describe('the meeting brief, read', () => {
  let world: ApplyWorld;
  let firm: TestFirm;
  let meetingId = '';

  const workspaceId = (): string => world.seeded.alpha.workspaceId;

  async function insertMeeting(firmId: string | null, uid: string): Promise<string> {
    const { rows } = await world.session.query<{ id: string }>(
      `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, starts_at, ends_at, last_event_at,
                             attendee_email, event_title, attendee_name, booking_notes, booking_answers, location_type, details_observed_at)
       VALUES ($1, $2, $2, $3, 'booked', now() + interval '2 days', now() + interval '2 days 30 minutes', now(),
               'dana@brief.example.test', 'Callie demo', 'Dana Example', 'Texts are a mess.', '{"How many doors?": "240"}'::jsonb, 'zoom_video', now())
       RETURNING id`,
      [workspaceId(), uid, firmId],
    );
    return rows[0]?.id ?? '';
  }

  beforeAll(async () => {
    world = await createApplyWorld();
    firm = await world.newFirm({ opportunity: 'open' });
    meetingId = await insertMeeting(firm.firmId, 'briefm2a');

    // A placed, transcribed and analysed call, with a stored summary carrying a next step.
    const placed = await world.placeCall(firm, UTTERANCES);
    await world.analyse(placed, ANALYSED);
    await world.session.query(
      `INSERT INTO call_summaries (workspace_id, call_session_id, model, prompt_version, summary, next_steps, commitments)
       VALUES ($1, $2, 'claude-haiku-4-5-20251001', 'c3b.summary.1', 'A stored summary.', $3::jsonb, '[]'::jsonb)`,
      [workspaceId(), placed.sessionId, JSON.stringify([{ action: 'Send the calendar link', owner: 'you', due: 'today' }])],
    );
    // A call logged from the Mac with no session.
    await world.session.query(
      `INSERT INTO call_logs (workspace_id, firm_id, contact_id, outcome, step_effect, occurred_at, actor_user_id)
       VALUES ($1, $2, $3, 'voicemail_left', 'none', TIMESTAMPTZ '2026-07-01 15:00:00+00', $4)`,
      [workspaceId(), firm.firmId, firm.contactId, world.seeded.alpha.salesperson.userId],
    );
    // A prepared brief.
    await world.session.query(
      `INSERT INTO firm_prepared_briefs (workspace_id, firm_id, brief, sources, observed_on, prepared_by)
       VALUES ($1, $2, $3, '[]'::jsonb, DATE '2026-09-20', 'Research partner')`,
      [workspaceId(), firm.firmId, 'Ask for Dana, the operations lead.\nUses AppFolio.\n240 doors.\nA fourth line.'],
    );
    // Three e-mail threads, one of them with two messages.
    const { rows: opportunities } = await world.session.query<{ id: string }>(
      "SELECT id FROM opportunities WHERE workspace_id = $1 AND firm_id = $2 AND status = 'open'",
      [workspaceId(), firm.firmId],
    );
    const { rows: mailboxes } = await world.session.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, status)
       VALUES ($1, $2, 'david@brief.example.test', 'brief-m2', 'connected')
       ON CONFLICT (workspace_id, owner_user_id) DO UPDATE SET status = 'connected' RETURNING id`,
      [workspaceId(), world.seeded.alpha.salesperson.userId],
    );
    const messages: [string, string, string][] = [
      ['t1', 'First thread', '2026-09-01T09:00:00Z'],
      ['t2', 'Re: Callie demo', '2026-09-28T09:00:00Z'],
      ['t2', 'Callie demo', '2026-09-27T09:00:00Z'],
      ['t3', 'Pricing question', '2026-09-25T09:00:00Z'],
    ];
    for (const [index, [thread, subject, at]] of messages.entries()) {
      const { rows } = await world.session.query<{ id: string }>(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction, internal_date, header_from, subject)
         VALUES ($1, $2, $3, $4, 'incoming', $5::timestamptz, 'dana@brief.example.test', $6) RETURNING id`,
        [workspaceId(), mailboxes[0]?.id, `brief-m2-${String(index)}`, `brief-${thread}`, at, subject],
      );
      await world.session.query(
        `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule)
         VALUES ($1, $2, $3, $4, 'participant')`,
        [workspaceId(), rows[0]?.id, firm.firmId, opportunities[0]?.id],
      );
    }
  });

  afterAll(async () => {
    await world.drop();
  });

  it('gathers every section from the stored sources, for the firm s assignee', async () => {
    const brief = await readMeetingBrief(world.salesperson(), meetingId);
    expect(brief).not.toBeNull();
    expect(meetingBriefResponseSchema.safeParse(brief).success).toBe(true);
    const texts = (key: keyof NonNullable<typeof brief>['sections']) => brief?.sections[key].items.map(entry => entry.text);
    expect(brief?.meeting).toMatchObject({ title: 'Callie demo', attendeeName: 'Dana Example', locationType: 'zoom_video' });
    expect(texts('whyThisDemo')).toEqual(['Texts are a mess.', '240', 'Can you show us a demo?', 'Send the calendar link (today)']);
    expect(texts('firm')).toEqual(['Ask for Dana, the operations lead.', 'Uses AppFolio.', '240 doors.']);
    expect(brief?.sections.conversations.items.map(entry => [entry.source, entry.label, entry.text])).toEqual([
      ['call', null, 'You reached Dana.'],
      ['call', 'voicemail_left', 'No summary'],
      ['email_thread', 'E-mail', 'Re: Callie demo'],
      ['email_thread', 'E-mail', 'Pricing question'],
    ]);
    expect(brief?.sections.objections.items.map(entry => [entry.label, entry.text])).toEqual([['price', 'It sounds expensive though.']]);
    expect(brief?.sections.commitments.items.map(entry => [entry.label, entry.text])).toEqual([['You', 'I will send you a calendar link today']]);
  });

  it('is the same null for a colleague, another workspace, an unknown meeting and an unmatched one; an administrator reads it', async () => {
    const colleague = await world.newFirm({ opportunity: 'open' });
    await world.session.query('UPDATE firms SET assigned_user_id = $3 WHERE workspace_id = $1 AND id = $2', [
      workspaceId(),
      colleague.firmId,
      world.seeded.alpha.admin.userId,
    ]);
    const theirs = await insertMeeting(colleague.firmId, 'briefm2b');
    expect(await readMeetingBrief(world.salesperson(), theirs)).toBeNull();
    expect(await readMeetingBrief(world.admin(), theirs)).not.toBeNull();
    const beta = repositoryContext(
      workspaceScope(world.seeded.beta.workspaceId, { kind: 'user', userId: world.seeded.beta.admin.userId, role: 'admin' }),
      world.session,
    );
    expect(await readMeetingBrief(beta, meetingId)).toBeNull();
    expect(await readMeetingBrief(world.salesperson(), '00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await readMeetingBrief(world.salesperson(), 'not-a-uuid')).toBeNull();
    const unmatched = await insertMeeting(null, 'briefm2c');
    expect(await readMeetingBrief(world.admin(), unmatched)).toBeNull();
  });

  it('skips a session of another firm linked to this firm s call log, and its summaries (review M2R, finding 6)', async () => {
    const other = await world.newFirm({ opportunity: 'open' });
    const foreign = await world.placeCall(other, UTTERANCES);
    await world.analyse(
      foreign,
      answer({
        summary: 'Foreign summary of another firm.',
        interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
        objections: [],
        commitments: [],
      }),
    );
    await world.session.query(
      `INSERT INTO call_summaries (workspace_id, call_session_id, model, prompt_version, summary, next_steps, commitments)
       VALUES ($1, $2, 'claude-haiku-4-5-20251001', 'c3b.summary.1', 'Foreign stored summary.', $3::jsonb, '[]'::jsonb)`,
      [workspaceId(), foreign.sessionId, JSON.stringify([{ action: 'Foreign next step', owner: 'you', due: 'today' }])],
    );
    // The foreign key permits it: the other firm's session now points at this firm's logged voicemail.
    const linked = await world.session.query(
      `UPDATE call_sessions SET call_log_id = (
         SELECT id FROM call_logs WHERE workspace_id = $1 AND firm_id = $2 AND outcome = 'voicemail_left')
        WHERE workspace_id = $1 AND id = $3`,
      [workspaceId(), firm.firmId, foreign.sessionId],
    );
    expect(linked.rowCount).toBe(1);
    const brief = await readMeetingBrief(world.salesperson(), meetingId);
    expect(JSON.stringify(brief)).not.toContain('Foreign');
    expect(brief?.sections.conversations.items.map(entry => [entry.label, entry.text])).toContainEqual(['voicemail_left', 'No summary']);
  });
});
