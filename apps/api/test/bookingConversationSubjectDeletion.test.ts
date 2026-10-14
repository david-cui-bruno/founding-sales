import { expect, it } from 'vitest';
import { claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { calcomBookingCreateClient } from '../src/integrations/calcomBookingCreateClient.ts';
import { setupConversation } from './support/bookingConversationFixture.ts';

type Fixture = Awaited<ReturnType<typeof setupConversation>>;
function barrier() {
  let resolve = () => {};
  const wait = new Promise<void>(done => { resolve = done; });
  return { wait, resolve };
}
async function deleteSubject(f: Fixture, targetKind: 'firm' | 'contact') {
  const preview = await f.request('POST', '/retention/deletions/preview', f.command({ targetKind, firmId: f.firmId, ...(targetKind === 'contact' ? { contactId: f.contactId } : {}) }));
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const shown = (preview.body as { result: { requestId: string; previewHash: string } }).result;
  const committed = await f.request('POST', '/retention/deletions/commit', f.command({ requestId: shown.requestId, previewHash: shown.previewHash }));
  expect(committed.status, JSON.stringify(committed.body)).toBe(200);
}

// Source capture, controlled interpretation, standing admission and create job
// are all normal registered/public paths. Only the calendar HTTP is controlled.
it.each(['firm', 'contact', 'source_only'] as const)('standing create conserves accepted evidence across public %s deletion during the controlled provider POST', async targetKind => {
  const f = await setupConversation();
  const worker = await f.fixture.database.appRuntimeSession();
  const entered = barrier(), release = barrier();
  const requests: { url: string; method: string | undefined }[] = [];
  let running: Promise<unknown> | undefined;
  let submissionId: string | undefined;
  let postMetadata: { callieSubmissionId: string } | undefined;
  const endsAt = new Date(Date.parse(f.startsAt) + 20 * 60_000).toISOString();
  Object.assign(f.runtime, { provider: calcomBookingCreateClient({ apiKey: 'controlled-not-a-live-credential', http: async (url, init) => {
    requests.push({ url, method: init.method });
    const path = new URL(url).pathname;
    if (path === '/v2/slots') return Response.json({ status: 'success', data: { [f.startsAt.slice(0, 10)]: [{ start: f.startsAt, end: endsAt }] } });
    if (path === '/v2/calendars/busy-times') return Response.json({ status: 'success', data: [] });
    if (init.method !== 'POST') throw new Error('accepted_standing_receipt_must_not_inspect_or_replay');
    postMetadata = (JSON.parse(String(init.body)) as { metadata: { callieSubmissionId: string } }).metadata;
    expect(postMetadata.callieSubmissionId).toBe(submissionId);
    const marker = (await f.fixture.db.query('SELECT state,dispatch_started_at FROM booking_create_submissions WHERE id=$1', [submissionId])).rows[0];
    expect(marker).toMatchObject({ state: 'unknown', dispatch_started_at: expect.any(Date) });
    entered.resolve();
    await release.wait;
    return Response.json({ status: 'success', data: { id: 31, uid: 'standing-deletion-booking', status: 'accepted', eventTypeId: 7, start: f.startsAt, end: endsAt, updatedAt: new Date().toISOString(), hosts: [{ id: 9, email: 'owner@booking.example' }], attendees: [{ email: 'prospect@booking.example' }], metadata: postMetadata, description: 'PRIVATE NEVER RETAIN' } }, { status: 201 });
  } }) });
  const freshRegistry = () => registerHandlers(new HandlerRegistry(), { classifier: undefined, mail: undefined, send: undefined, research: undefined, bookingCreate: f.runtime, bookingConversation: f.conversation });
  try {
    expect((await worker.query('SELECT current_user AS role')).rows[0]).toEqual({ role: 'app_runtime' });
    await runOnce(f.db, { registry: f.registry, owner: `standing-${targetKind}-admission`, limit: 20 });
    const before = await f.request('GET', `/meetings/booking-conversation?conversationId=${f.conversationId}`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ state: 'booking_pending', origin: 'standing_policy', booking: { state: 'pending', dispatchStartedAt: null } });
    submissionId = (before.body as { booking: { submissionId: string } }).booking.submissionId;
    const pending = (await f.fixture.db.query<{ payload: { standingOrigin?: unknown; confirmation?: unknown } }>('SELECT payload FROM booking_create_submissions WHERE id=$1', [submissionId])).rows[0]!;
    expect(pending.payload.standingOrigin).toMatchObject({ conversationId: f.conversationId });
    expect(pending.payload.confirmation).toBeUndefined();
    const job = (await claimJobs(f.fixture.db, { owner: `standing-${targetKind}-provider`, kinds: ['meeting.booking_create'], limit: 1, leaseSeconds: 120 }))[0]!;
    expect(job).toBeDefined();
    const input = { session: worker, scope: workspaceScope(f.fixture.alpha.workspaceId, { kind: 'system' as const, component: 'worker' as const }), job };
    running = freshRegistry().get('meeting.booking_create')!.handle(input);
    await Promise.race([entered.wait, running.then(() => { throw new Error('standing_create_never_reached_controlled_POST'); })]);
    if (targetKind === 'source_only') {
      expect((await f.request('POST', '/crm/business/mail/delete', f.command({ sourceId: f.source.sourceId, expectedRevision: 1 }))).status).toBe(200);
    } else {
      await deleteSubject(f, targetKind);
      expect((await f.fixture.db.query("SELECT canonical_key FROM suppression_events WHERE workspace_id=$1 AND source='deletion_tombstone' AND scope='handle'", [f.fixture.alpha.workspaceId])).rows).toContainEqual({ canonical_key: 'prospect@booking.example' });
    }
    // Deletion completes before the accepted HTTP response is released.
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    release.resolve();
    await running;
    const stored = (await f.fixture.db.query('SELECT state,provider_booking_uid,dispatch_started_at,meeting_id,payload,source_fingerprint,provenance_state,reason FROM booking_create_submissions WHERE id=$1', [submissionId])).rows[0];
    expect(stored).toMatchObject({ state: 'accepted', provider_booking_uid: 'standing-deletion-booking', dispatch_started_at: expect.any(Date), payload: {}, source_fingerprint: '0'.repeat(64), provenance_state: 'redacted', ...(targetKind === 'source_only' ? { meeting_id: expect.any(String) } : { meeting_id: null, reason: 'subject_deleted' }) });
    expect(stored?.['payload']).toEqual({});
    const receipt = await f.request('GET', `/meetings/booking-create?submissionId=${submissionId}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({ state: 'accepted', sourceState: 'redacted', providerBookingUid: 'standing-deletion-booking', dispatchStartedAt: expect.any(String), meetingId: targetKind === 'source_only' ? expect.any(String) : null, ...(targetKind === 'source_only' ? {} : { reason: 'subject_deleted' }) });
    const read = await f.request('GET', `/meetings/booking-conversation?conversationId=${f.conversationId}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ state: 'stale', origin: 'standing_policy', outcome: null, handoff: null, booking: receipt.body });
    const serialized = JSON.stringify(read.body);
    for (const privateValue of ['prospect@booking.example', 'Agreed prospect', 'What does Callie cost?', 'PRIVATE NEVER RETAIN']) expect(serialized).not.toContain(privateValue);
    const retained = (await f.fixture.db.query('SELECT source_refs,source_fingerprint,source_conversation_id FROM booking_conversations WHERE workspace_id=$1 AND id=$2', [f.fixture.alpha.workspaceId, f.conversationId])).rows[0];
    expect(retained).toEqual({ source_refs: [], source_fingerprint: '0'.repeat(64), source_conversation_id: null });
    const meetings = (await f.fixture.db.query('SELECT attendee_email FROM meetings WHERE workspace_id=$1', [f.fixture.alpha.workspaceId])).rows;
    expect(meetings).toEqual(targetKind === 'source_only' ? [{ attendee_email: 'prospect@booking.example' }] : []);
    expect((await f.fixture.db.query('SELECT id FROM stage_review_items WHERE workspace_id=$1 AND evidence_kind LIKE $2', [f.fixture.alpha.workspaceId, 'meeting.%'])).rows).toHaveLength(0);
    if (targetKind === 'source_only') expect((await f.fixture.db.query("SELECT 1 FROM suppression_events WHERE workspace_id=$1 AND source='deletion_tombstone'", [f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
    // Recompose the registry and execute the same durable job plus the normal
    // restarted runner. Neither can emit another POST or resurrect private data.
    await freshRegistry().get('meeting.booking_create')!.handle(input);
    await runOnce(worker, { registry: freshRegistry(), owner: `standing-${targetKind}-restart`, limit: 20 });
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect((await f.request('GET', `/meetings/booking-create?submissionId=${submissionId}`)).body).toEqual(receipt.body);
    expect((await f.request('GET', `/meetings/booking-conversation?conversationId=${f.conversationId}`)).body).toEqual(read.body);
  } finally {
    release.resolve();
    await running?.catch(() => {});
    await f.fixture.stop();
  }
});
