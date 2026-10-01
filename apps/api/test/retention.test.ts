import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingSuppressionJournal, type RecordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The deletion request pair, through the real dispatcher with real sessions.
 *
 * The rules have their own tests against a real PostgreSQL in `@fss/domain`; what is
 * proved here is the wiring:
 *
 *   * both paths refuse a salesperson, because 5.2 gives "retention operations" to
 *     admins;
 *   * a commit presents the hash the preview returned, and a stale one is refused
 *     rather than deleting whatever is there now;
 *   * the tombstones reach the journal before the command acknowledges (10.2).
 *
 * Wave 2 (S6) deleted these routes; the batch review restored them, because the commit
 * is the only way to write deletion tombstones.
 */
describe('the deletion request routes', () => {
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

    firmId = await seedFirm(fixture, {
      name: 'Northwind Test Holdings',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });

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

  it('refuses both paths without a session and to a salesperson', async () => {
    for (const path of ['/retention/deletions/preview', '/retention/deletions/commit']) {
      expect((await post(path, null, command())).status, path).toBe(401);
      expect((await post(path, salespersonToken, command())).status, path).toBe(403);
    }
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

  it('answers a committed deletion without waiting for a stalled call-audio delete, holding no session', async () => {
    const otherFirm = await seedFirm(fixture, {
      name: 'Stalled Bucket Test Holdings',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    // A recorded transcription job whose call session is gone: its objects are the deletion's.
    const gone = randomUUID();
    await fixture.db.query(
      `INSERT INTO transcription_provider_jobs
         (workspace_id, job_name, call_session_id, attempt, reservation_id, provider_key, input_key, output_key)
       VALUES ($1, $2, $3, 1, $4, 'aws_transcribe', $5, $6)`,
      [fixture.alpha.workspaceId, `fss-test-${gone}-1`, gone, randomUUID(), `calls/${gone}/attempt-1.mp3`, `calls/${gone}/attempt-1.json`],
    );
    const preview = await post('/retention/deletions/preview', adminToken, command({ targetKind: 'firm', firmId: otherFirm }));
    expect(preview.status).toBe(200);
    const shown = resultOf(preview);

    let queries = 0;
    const session = {
      query: async (...args: Parameters<typeof fixture.db.query>) => {
        queries += 1;
        return await fixture.db.query(...args);
      },
    } as typeof fixture.db;
    const asked: string[][] = [];
    const callAudio = {
      // S3 that never answers.
      deleteObjects: async (keys: readonly string[]) => {
        asked.push([...keys]);
        return await new Promise<{ deleted: number; failed: number }>(() => undefined);
      },
    };
    const request: ApiRequest = {
      method: 'POST',
      path: '/retention/deletions/commit',
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${adminToken}` },
      body: command({ requestId: shown['requestId'], previewHash: shown['previewHash'] }),
    };
    const answer = await Promise.race([
      dispatch(request, { ...options(), session, callAudio }),
      new Promise<'held'>(resolve => setTimeout(() => resolve('held'), 3_000)),
    ]);
    expect(answer === 'held' ? 'held' : answer.status).toBe(200);
    expect(asked).toEqual([[`calls/${gone}/attempt-1.mp3`, `calls/${gone}/attempt-1.json`]]);
    const after = queries;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(queries).toBe(after);
  });
});
