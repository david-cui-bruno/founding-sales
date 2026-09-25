import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SuppressionJournalError, type SuppressionJournalRecord } from '@fss/domain/suppression';
import { loadJournalPutObject, type S3JournalSdk } from '../src/bootstrap/deployment.ts';
import { resolveSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * A conditional-write conflict is a failed journal write, never an acknowledgement
 * (audit S12, lane g81).
 *
 * The API writes each suppression to the object-locked S3 journal with
 * `IfNoneMatch: '*'` before its row (10.2). `412 PreconditionFailed` means an object is
 * already at the deterministic key, which is a replay of this very event, and is
 * durable. `409 ConditionalRequestConflict` means another write to the key was in
 * flight; it may still fail, so nothing is proved. Until lane g81 the put read both as
 * `already_present`, and a conflict acknowledged a suppression that no journal object
 * recorded — one Appendix E's replay would lose after a restore.
 *
 * ## The vacuous-pass trap, named
 *
 * A fake that refused every put would make "the conflict fails the command" true of a
 * put that refuses everything. So the same fake, in the same test, also answers `412`
 * and a plain success, and those must resolve; and the route test retries the same
 * command id against a fake that now accepts, and that retry must record the
 * suppression. The SDK is a fake: no test here reaches AWS.
 */

interface SentCommand {
  readonly input: Record<string, unknown>;
}

/** An SDK whose client answers each `send` with the next scripted outcome. */
function scriptedSdk(outcomes: ('ok' | 'PreconditionFailed' | 'ConditionalRequestConflict' | 'AccessDenied')[]): {
  readonly sdk: S3JournalSdk;
  readonly sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  class PutObjectCommand implements SentCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class S3Client {
    async send(command: unknown): Promise<unknown> {
      sent.push(command as SentCommand);
      await Promise.resolve();
      const next = outcomes.shift() ?? 'ok';
      if (next === 'ok') return { ETag: '"etag"' };
      const error = new Error(`scripted ${next}`);
      error.name = next;
      throw error;
    }
  }
  return { sdk: { S3Client, PutObjectCommand }, sent };
}

const request = {
  bucket: 'fss-test-suppression-journal',
  key: 'suppressions/workspace/sup_example.json',
  body: '{}',
  contentType: 'application/json' as const,
  ifNoneMatch: '*' as const,
};

const record: SuppressionJournalRecord = {
  eventId: 'sup_conflict_example',
  workspaceId: '00000000-0000-4000-8000-000000000001',
  scope: 'handle',
  canonicalKey: '+14015550199',
  canonicalizerVersion: 'e164-lower.1',
  source: 'prospect_opt_out',
  actorUserId: null,
  commandId: null,
  supersedesEventId: null,
  supersessionReason: null,
  recordedAt: '2026-09-25T12:00:00.000Z',
};

describe('the S3 journal put (audit S12)', () => {
  it('writes conditionally, and reads a 412 as the object already durable', async () => {
    const { sdk, sent } = scriptedSdk(['ok', 'PreconditionFailed']);
    const put = await loadJournalPutObject('us-east-1', sdk);
    await expect(put(request)).resolves.toBe('written');
    await expect(put(request)).resolves.toBe('already_present');
    expect(sent.map(command => command.input['IfNoneMatch'])).toEqual(['*', '*']);
    expect(sent[0]?.input['Key']).toBe(request.key);
  });

  it('refuses a 409 ConditionalRequestConflict rather than calling it present', async () => {
    const { sdk } = scriptedSdk(['ConditionalRequestConflict']);
    const put = await loadJournalPutObject('us-east-1', sdk);
    await expect(put(request)).rejects.toMatchObject({ name: 'ConditionalRequestConflict' });
  });

  it('turns the conflict into JOURNAL_UNAVAILABLE for the command, and a 412 into success', async () => {
    const { sdk } = scriptedSdk(['ConditionalRequestConflict', 'PreconditionFailed', 'AccessDenied']);
    const resolved = resolveSuppressionJournal({
      bucket: request.bucket,
      putObject: await loadJournalPutObject('us-east-1', sdk),
    });
    expect(resolved.durable).toBe(true);

    const conflict = await resolved.journal.append(record).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).toBeInstanceOf(SuppressionJournalError);
    expect((conflict as SuppressionJournalError).code).toBe('JOURNAL_UNAVAILABLE');
    expect((conflict as Error).message).toContain('ConditionalRequestConflict');

    await expect(resolved.journal.append(record)).resolves.toBeUndefined();
    await expect(resolved.journal.append(record)).rejects.toBeInstanceOf(SuppressionJournalError);
  });
});

describe('a suppression whose journal write meets a conflict', () => {
  let fixture: AuthFixture;
  let token: string;
  const scripted: ('ok' | 'PreconditionFailed' | 'ConditionalRequestConflict')[] = [];
  let journal: ReturnType<typeof resolveSuppressionJournal>['journal'];

  const post = async (body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const call: ApiRequest = {
      method: 'POST',
      path: '/suppressions/record',
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(call, {
      session: fixture.db,
      supportedClientVersions: fixture.deps.config.supportedClientVersions,
      sendingEnabled: false,
      expectedSystemGeneration: null,
      auth: fixture.deps,
      upgradeUrl: 'https://callie.example/downloads/mac',
      suppressionJournal: journal,
    });
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    const { sdk } = scriptedSdk(scripted);
    journal = resolveSuppressionJournal({
      bucket: request.bucket,
      putObject: await loadJournalPutObject('us-east-1', sdk),
    }).journal;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('fails the command, records nothing, and the retry records it', async () => {
    const commandId = randomUUID();
    const body = {
      commandId,
      clientVersion: CURRENT_CLIENT_VERSION,
      scope: 'handle' as const,
      value: '+1 401 555 0198',
      source: 'salesperson_manual' as const,
    };

    scripted.push('ConditionalRequestConflict');
    const failed = await post(body);
    expect(failed.status).toBe(503);
    expect(failed.body['error']).toBe('journal_unavailable');

    const events = await fixture.db.query<{ count: string }>(
      "SELECT count(*) AS count FROM suppression_events WHERE workspace_id = $1 AND canonical_key = '+14015550198'",
      [fixture.alpha.workspaceId],
    );
    expect(Number(events.rows[0]?.count)).toBe(0);
    const receipts = await fixture.db.query<{ count: string }>(
      'SELECT count(*) AS count FROM command_receipts WHERE workspace_id = $1 AND command_id = $2',
      [fixture.alpha.workspaceId, commandId],
    );
    expect(Number(receipts.rows[0]?.count)).toBe(0);

    // The other writer landed: the retry meets its object, which is this event.
    scripted.push('PreconditionFailed');
    const retried = await post(body);
    expect(retried.status).toBe(200);
    const recorded = await fixture.db.query<{ count: string }>(
      "SELECT count(*) AS count FROM suppression_events WHERE workspace_id = $1 AND canonical_key = '+14015550198'",
      [fixture.alpha.workspaceId],
    );
    expect(Number(recorded.rows[0]?.count)).toBe(1);
  });
});
