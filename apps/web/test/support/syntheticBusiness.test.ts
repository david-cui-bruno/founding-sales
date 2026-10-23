import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test, expect, vi } from 'vitest';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { readMessage, readMessageBody } from '@fss/domain/mail/messages.ts';
import { readReplyDraftContext } from '@fss/domain/replies/composer.ts';
import { previewHumanReply } from '@fss/domain/replies/dispatch.ts';
import { readMeetingPreparation } from '@fss/domain/meetings/brief.ts';
import { nextMeetingFollowThroughAction } from '@fss/domain/meetings/followThroughSchedule.ts';
import { classifyReply } from '@fss/domain/src/rules/replyClassification.ts';
import { recordSuppression } from '@fss/domain/suppression/events.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { startSyntheticBusiness, syntheticCorpusSchema } from './syntheticBusinessFixture.ts';

const enabled = Boolean(process.env['FSS_SYNTHETIC_BUSINESS_INPUT'] && process.env['FSS_SYNTHETIC_BUSINESS_OUTPUT']);
const processes = () => execFileSync('/bin/ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n').filter(line => /postgres|headless|playwright/iu.test(line));
const drafts: Record<string, string> = {
  A: 'Human-reviewed synthetic draft: Our fictional screen walkthrough is agreed for October 26, 14:00-14:20 America/New_York. We will focus on ownership of unanswered vendor requests. The recap promise remains due October 27 at noon. No invitation or email is being sent.',
  B: 'Human-reviewed synthetic draft: No time is agreed or booked. We will await your specific selection after supervisor review. Neither proposed slot is reserved.',
  C: 'Human-reviewed synthetic draft: I have corrected the discussion scope to 96 doors and the internal decision deadline to October 29 at 16:00 America/New_York. The former 120-door count and October 27 deadline are superseded. No meeting is agreed.',
};

// Opt-in private corpus only, never silently replayed by normal suites.
test.skipIf(!enabled)('four frozen synthetic business cases through actual local domain paths, no transport', async () => {
  const input = resolve(process.env['FSS_SYNTHETIC_BUSINESS_INPUT']!);
  const output = resolve(process.env['FSS_SYNTHETIC_BUSINESS_OUTPUT']!);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const save = async (name: string, value: unknown) => { await writeFile(join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 }); };
  const corpus = syntheticCorpusSchema.parse(JSON.parse(await readFile(input, 'utf8')));
  expect(corpus.cases.map(value => value.id)).toEqual(['A', 'B', 'C', 'D']);
  const baseline = processes();
  await save('resources-before.json', baseline);
  const network = vi.fn(async () => { throw new Error('Synthetic demonstration forbids fetch'); });
  vi.stubGlobal('fetch', network);
  let fixture: Awaited<ReturnType<typeof startSyntheticBusiness>> | undefined;
  const observations: unknown[] = [];
  try {
    fixture = await startSyntheticBusiness();
    await save('resources-owned.json', fixture.resources);
    for (const business of corpus.cases) {
      const seeded = await fixture.seed(business);
      const captured = [];
      for (const source of business.messages) {
        const messageId = seeded.sourceIds[source.id]!;
        const metadata = await readMessage(fixture.ctx, messageId);
        const body = await readMessageBody(fixture.ctx, messageId);
        captured.push({ sourceId: source.id, metadata, body });
        await save(`${business.id}-capture.json`, captured);
        expect(body?.text).toBe(source.body);
        expect(metadata?.providerMessageId).toBe(source.id);
      }
      const classifications = business.messages.filter(value => value.direction === 'inbound').map(source => classifyReply({ id: source.id, headers: { from: source.from, subject: source.subject }, bodyParts: [{ text: source.body }] }));
      let humanDecision: unknown = null;
      let suppression: unknown = null;
      if (business.id === 'D') {
        humanDecision = { basis: 'explicit HUMAN review of SYN-D-02/03/04', wrongRecipient: true, stop: true, reply: false, enrollment: false, followup: false };
        const journal = recordingSuppressionJournal();
        suppression = await withTransaction(fixture.db, () => recordSuppression(fixture!.ctx, { scope: 'handle', firmId: seeded.firmId, value: seeded.recipient, source: 'prospect_opt_out', channel: 'email', commandId: randomUUID(), journal }));
      }
      if (business.id === 'C') {
        humanDecision = { basis: 'explicit HUMAN correction, not extraction or durable CRM claim correction', selectedSourceIds: ['SYN-C-03', 'SYN-C-04'], current: { doors: 96, decisionDeadline: '2026-10-29T16:00:00-04:00' }, superseded: { sourceIds: ['SYN-C-01', 'SYN-C-02'], doors: 120, decisionDeadline: '2026-10-27T17:00:00-04:00' }, booking: false };
      }
      let meetingId: string | null = null;
      let brief: unknown = null;
      if (business.id === 'A') {
        meetingId = randomUUID();
        const notes = business.messages.slice(2).map(source => `${source.id}: ${source.body}`).join('\n');
        humanDecision = { basis: 'explicit HUMAN review of fictional agreement SYN-A-03 and recap promise SYN-A-04', calendarOperation: false, promiseFulfilled: false, durableCommitmentProjection: 'unsupported by selected seam' };
        await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at,attendee_name,event_title,booking_notes,details_observed_at) VALUES($1,$2,$3,$4,$4,'booked','2026-10-26T14:00:00-04:00','2026-10-26T14:20:00-04:00','2026-10-23T10:40:00-04:00',$5,'SYNTHETIC DEMO human-reviewed fictional agreement',$6,'2026-10-23T10:40:00-04:00')", [fixture.workspaceId, meetingId, seeded.firmId, `synthetic-${meetingId}`, business.participants[0]!.name, notes]);
        brief = await readMeetingPreparation(fixture.ctx, meetingId, { includeMeetingTasks: true });
      }
      const context = await readReplyDraftContext(fixture.ctx, { messageId: seeded.messageId });
      const preview = await previewHumanReply(fixture.ctx, { messageId: seeded.messageId, text: drafts[business.id] ?? 'SYNTHETIC BLOCKED PREVIEW PROBE', factRefs: [], envelope: { to: [seeded.recipient], cc: [] } });
      const meetings = (await fixture.db.query('SELECT id,state,starts_at,ends_at FROM meetings WHERE workspace_id=$1 AND firm_id=$2', [fixture.workspaceId, seeded.firmId])).rows;
      const action = nextMeetingFollowThroughAction({ plan: { scope: null, maxMessages: 0 }, deliveryHistory: [], at: '2026-10-23T15:00:00Z', calendar: { version: 'synthetic-only.1', dates: [] }, zone: 'America/New_York' });
      const observed = { caseId: business.id, provenance: corpus.provenance, sourceIds: seeded.sourceIds, classifications, humanDecision, suppression, context, manualDraft: drafts[business.id] ?? null, preview, meetings, brief, action, limits: ['No AI generation or model usefulness measurement', 'No browser/API host exercised', 'No durable CRM extraction/conflict/commitment or Today projection', 'Human fixture decisions are inputs, not inferred product facts', 'Null followthrough scope deliberately preserves permission_missing', 'Historical outgoing rows are invented capture, not outbound transport'] };
      observations.push(observed);
      await save(`${business.id}-observed.json`, observed);
      await save('observations.json', observations);
      await writeFile(join(output, `${business.id}-readable.md`), `# ${business.title}\n\nSynthetic only. Human-authored fixture decisions, not AI output.\n\n## Human decision\n${JSON.stringify(humanDecision, null, 2)}\n\n## Actual exact no-send preview\n${JSON.stringify(preview, null, 2)}\n\n## Actual sourced preparation\n${JSON.stringify(brief, null, 2)}\n\n## Actual followthrough guard\n${JSON.stringify(action)}\n\nFull source IDs, captured messages, classifications and limits: ${business.id}-observed.json and ${business.id}-capture.json.\n`, { mode: 0o600 });
      if (business.id === 'D') {
        expect(suppression).toMatchObject({ ok: true });
        expect(context).toEqual({ ok: false, reason: 'conversation_stopped' });
        expect(preview).toEqual({ ok: false, reason: 'conversation_stopped' });
      } else {
        expect(context.ok, JSON.stringify(context)).toBe(true);
        expect(preview.ok, JSON.stringify(preview)).toBe(true);
        if (preview.ok) expect(preview.value.body).toBe(`${drafts[business.id]}\n\n`);
        if (context.ok) expect(context.value.priorContext).toHaveLength(3);
      }
      expect(meetings).toHaveLength(business.id === 'A' ? 1 : 0);
      if (business.id === 'A') {
        expect(brief).not.toBeNull();
        expect(JSON.stringify(brief)).toContain('SYN-A-03');
        expect(JSON.stringify(brief)).toContain('SYN-A-04');
      }
      expect(action).toEqual({ kind: 'review', reason: 'permission_missing' });
    }
    const counts: Record<string, number> = {};
    for (const table of ['outbound_messages', 'human_reply_send_intents', 'outbound_message_events', 'provider_reservations', 'crm_internal_tasks']) {
      counts[table] = Number((await fixture.db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`)).rows[0]!.count);
    }
    const sendJobs = (await fixture.db.query("SELECT id,kind FROM jobs WHERE kind='reply.human_send'")).rows;
    const capturedCount = Number((await fixture.db.query<{ count: string }>('SELECT count(*)::text AS count FROM mail_messages')).rows[0]!.count);
    await save('safety.json', { sendingEnabled: false, counts, sendJobs, capturedCount, fetchCalls: network.mock.calls.length });
    expect(Object.values(counts)).toEqual([0, 0, 0, 0, 0]);
    expect(sendJobs).toHaveLength(0);
    expect(capturedCount).toBe(16);
    expect(network).not.toHaveBeenCalled();
  } catch (error) {
    await save('failure.json', { name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    try { await fixture?.stop(); }
    finally {
      vi.unstubAllGlobals();
      const after = processes();
      await save('resources-after.json', after);
      await save('cleanup.json', { ownedCleanupCompleted: fixture !== undefined, browser: 'never started', baselineProcessesStillPresent: baseline.every(line => after.includes(line)) });
    }
  }
}, 120_000);
