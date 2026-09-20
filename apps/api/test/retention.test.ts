import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingSuppressionJournal, type RecordingSuppressionJournal } from '@fss/domain/suppression';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The retention, deletion, departure and attachment endpoints, through the real
 * dispatcher with real sessions.
 *
 * The rules have their own tests against a real PostgreSQL in `@fss/domain`; what is
 * proved here is the wiring, and four pieces of it are this lane's alone:
 *
 *   * every one of these paths refuses a salesperson, because 5.2 gives "retention
 *     operations" to admins and the attachment link to the people Appendix F names;
 *   * a deletion commit presents the hash the preview returned, and a stale one is
 *     refused rather than deleting whatever is there now;
 *   * the tombstones reach the journal before the command acknowledges (10.2);
 *   * `/retention/run` enqueues the job the scheduler would have made, so asking
 *     twice produces one sweep.
 */
describe('retention, deletion and departure routes', () => {
  let fixture: AuthFixture;
  let journal: RecordingSuppressionJournal;
  let adminToken: string;
  let salespersonToken: string;
  let firmId: string;
  let contactId: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: journal,
  });

  const post = async (
    path: string,
    token: string | null,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const get = async (path: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const result = await dispatch(
      { method: 'GET', path, query: new URLSearchParams(), headers: { authorization: `Bearer ${token}` }, body: undefined },
      options(),
    );
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  beforeAll(async () => {
    fixture = await createAuthFixture();
    journal = recordingSuppressionJournal();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;

    const created = await post(
      '/firms/create',
      adminToken,
      command({
        name: 'Northwind Test Holdings',
        regionCode: 'RI',
        postalCode: '02903',
        assignedUserId: fixture.alpha.salesperson.userId,
      }),
    );
    expect(created.status).toBe(200);
    firmId = String(resultOf(created)['id']);

    const contact = await post('/contacts/create', salespersonToken, command({ firmId, fullName: 'Dana Example' }));
    expect(contact.status).toBe(200);
    contactId = String(resultOf(contact)['id']);

    const route = await post(
      '/contacts/routes/add',
      salespersonToken,
      command({
        firmId,
        contactId,
        routeKind: 'email',
        value: 'dana@northwind.example.test',
        source: 'salesperson',
        technicalValidation: 'passed',
        associationConfidence: 0.95,
      }),
    );
    expect(route.status).toBe(200);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every path in this lane without a session', async () => {
    for (const path of [
      '/retention/deletions/preview',
      '/retention/deletions/commit',
      '/retention/run',
      '/admin/departure/preview',
      '/admin/departure/commit',
      '/attachments/open',
    ]) {
      expect((await post(path, null, command())).status, path).toBe(401);
    }
    expect((await get('/retention/policies', 'not-a-token')).status).toBe(401);
  });

  it('refuses a salesperson on every retention and departure path', async () => {
    for (const path of [
      '/retention/deletions/preview',
      '/retention/deletions/commit',
      '/retention/run',
      '/admin/departure/preview',
      '/admin/departure/commit',
    ]) {
      expect((await post(path, salespersonToken, command())).status, path).toBe(403);
    }
    expect((await get('/retention/policies', salespersonToken)).status).toBe(403);
    expect((await get('/retention/runs', salespersonToken)).status).toBe(403);
  });

  it('answers an admin with the ten horizons of the 10.3 table', async () => {
    const answer = await get('/retention/policies', adminToken);
    expect(answer.status).toBe(200);
    const policies = answer.body['policies'] as readonly { dataKind: string; retentionDays: number | null }[];
    expect(policies).toHaveLength(10);
    expect(policies.find(policy => policy.dataKind === 'unmatched_gmail_metadata')?.retentionDays).toBe(30);
    expect(policies.find(policy => policy.dataKind === 'suppression_history')?.retentionDays).toBeNull();
  });

  it('enqueues the job the scheduler would have made, and asking twice produces one', async () => {
    const first = await post('/retention/run', adminToken, command({ dataKind: 'raw_mime', period: '2026-09-20' }));
    expect(first.status).toBe(200);
    expect(resultOf(first)['enqueued']).toBe(true);

    const second = await post('/retention/run', adminToken, command({ dataKind: 'raw_mime', period: '2026-09-20' }));
    expect(second.status).toBe(200);
    // A second command id, the same idempotency key: the queue refuses the duplicate
    // rather than the receipt doing it, which is the property that matters when the
    // scheduler and an admin ask on the same day.
    expect(resultOf(second)['enqueued']).toBe(false);

    const { rows } = await fixture.db.query<{ count: string }>(
      "SELECT count(*) AS count FROM jobs WHERE kind = 'retention.batch' AND idempotency_key = 'retention:raw_mime:2026-09-20'",
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it('refuses a firm deletion that names a contact and a contact deletion that does not', async () => {
    expect(
      (await post('/retention/deletions/preview', adminToken, command({ targetKind: 'firm', firmId, contactId })))
        .status,
    ).toBe(400);
    expect(
      (await post('/retention/deletions/preview', adminToken, command({ targetKind: 'contact', firmId }))).status,
    ).toBe(400);
  });

  it('previews a deletion, refuses a stale hash, and commits the preview it was shown', async () => {
    const preview = await post(
      '/retention/deletions/preview',
      adminToken,
      command({ targetKind: 'firm', firmId }),
    );
    expect(preview.status).toBe(200);
    const shown = resultOf(preview);
    expect(String(shown['previewHash'])).toMatch(/^[0-9a-f]{64}$/u);
    expect((shown['tombstoneHandles'] as readonly string[]).length).toBeGreaterThan(0);

    const stale = await post(
      '/retention/deletions/commit',
      adminToken,
      command({ requestId: shown['requestId'], previewHash: '0'.repeat(64) }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body['reason']).toBe('preview_stale');

    const journalledBefore = journal.appended.length;
    const committed = await post(
      '/retention/deletions/commit',
      adminToken,
      command({ requestId: shown['requestId'], previewHash: shown['previewHash'] }),
    );
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    const tombstones = resultOf(committed)['tombstoneEventIds'] as readonly string[];
    expect(tombstones.length).toBeGreaterThan(0);
    // Journalled before the row, and therefore before the acknowledgement (10.2).
    expect(journal.appended.length - journalledBefore).toBe(tombstones.length);

    const { rows } = await fixture.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM email_addresses WHERE firm_id = $1',
      [firmId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('shows a departure preview and commits it once', async () => {
    const preview = await post(
      '/admin/departure/preview',
      adminToken,
      { userId: fixture.alpha.salesperson.userId },
    );
    expect(preview.status).toBe(200);
    const shown = preview.body['preview'] as Record<string, unknown>;
    expect(shown['activeSessions']).toBeGreaterThan(0);
    expect(shown['alreadyDeparted']).toBe(false);

    const committed = await post(
      '/admin/departure/commit',
      adminToken,
      command({ userId: fixture.alpha.salesperson.userId }),
    );
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(resultOf(committed)['replayed']).toBe(false);

    // The session the departed salesperson was holding no longer authenticates.
    expect((await get('/retention/policies', salespersonToken)).status).toBe(401);

    const again = await post(
      '/admin/departure/commit',
      adminToken,
      command({ userId: fixture.alpha.salesperson.userId }),
    );
    expect(again.status).toBe(200);
    expect(resultOf(again)['replayed']).toBe(true);
  });

  it('refuses an admin departing themselves', async () => {
    const outcome = await post('/admin/departure/commit', adminToken, command({ userId: fixture.alpha.admin.userId }));
    expect(outcome.status).toBe(409);
    expect(outcome.body['reason']).toBe('self_departure');
  });

  it('answers not_found for an attachment nobody may see, and never says which reason it was', async () => {
    const outcome = await post('/attachments/open', adminToken, {
      mailMessageId: '00000000-0000-4000-8000-000000000000',
    });
    expect(outcome.status).toBe(404);
    expect(outcome.body).toEqual({ error: 'not_found', message: 'No such endpoint.' });
  });
});
