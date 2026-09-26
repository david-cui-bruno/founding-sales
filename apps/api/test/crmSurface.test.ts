import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IMPORT_COLUMNS,
  firmPageResponseSchema,
  importCommitResponseSchema,
  importPreviewResponseSchema,
} from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, OUTDATED_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

/**
 * Admin CSV import and the Firm page, through the real dispatcher with real sessions
 * (specification 7.2, 5.2, Appendix F, Appendix G 7, 8 and 38). Search and export had
 * no caller and went in wave 2, S6.
 *
 * The domain tests in `@fss/domain` prove the rules against a real PostgreSQL. What
 * is proved here is the surface: that the endpoints are mounted, that they
 * refuse the caller the specification says they refuse, that every response matches
 * the schema in `@fss/contracts`, and — the one that is genuinely about the API
 * rather than the domain — that a CSV import is one command per row, so a retry of
 * the same file replays the rows that landed instead of importing them twice.
 */
describe('the CRM surface', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let salespersonToken: string;
  let salespersonUserId: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
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

  // The twelve columns before lane g84's `time_zone`: an old file still reads.
  const csv = (...rows: readonly string[]): string =>
    [IMPORT_COLUMNS.filter(column => column !== 'time_zone').join(','), ...rows].join('\n');

  beforeAll(async () => {
    fixture = await createAuthFixture();
    const admin = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin);
    const salesperson = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson);
    adminToken = admin.accessToken;
    salespersonToken = salesperson.accessToken;
    salespersonUserId = fixture.alpha.salesperson.userId;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  // ------------------------------------------------------------------- mounting
  it('refuses every CRM-surface path without a session', async () => {
    for (const path of ['/import/preview', '/import/commit', '/crm/firm-page']) {
      const answer = await post(path, null, {});
      expect(answer.status, path).toBe(401);
    }
  });

  it('refuses a method other than POST, and an unmounted neighbour', async () => {
    const read = await dispatch(
      {
        method: 'GET',
        path: '/import/preview',
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${adminToken}` },
        body: undefined,
      },
      options(),
    );
    expect(read.status).toBe(405);

    for (const path of ['/search/contacts', '/search/firms', '/export/firms']) {
      expect((await post(path, adminToken, {})).status, path).toBe(404);
    }
  });

  it('refuses a salesperson at both import paths', async () => {
    const preview = await post('/import/preview', salespersonToken, { csv: csv('A Test Co,,,,,,,,,,,') });
    expect(preview.status).toBe(409);
    expect(preview.body['reason']).toBe('admin_only');

    const commit = await post('/import/commit', salespersonToken, {
      clientVersion: CURRENT_CLIENT_VERSION,
      csv: csv('A Test Co,,,,,,,,,,,'),
      rows: [{ rowNumber: 2, commandId: randomUUID() }],
    });
    expect(commit.status).toBe(409);
    expect(commit.body['reason']).toBe('admin_only');
  });

  it('previews duplicates, invalid routes and good rows, and answers the contract schema', async () => {
    const source = csv(
      'Hazel Test Group,https://hazel.example.test,,Providence,RI,02903,HZ-1,,Kim Placeholder,Lead,kim@hazel.example.test,+14015550111',
      'Hazel Test Group,,,,,,,,,,,',
      'Nettle Test Co,,,,,,,,Pat Placeholder,,pat@@nettle,nonsense',
      ',,,,,,,,,,,x',
    );
    const preview = await post('/import/preview', adminToken, { csv: source });
    expect(preview.status).toBe(200);
    const parsed = importPreviewResponseSchema.safeParse(preview.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.counts).toEqual({ create: 1, attach: 0, duplicate: 1, invalid: 2 });
  });

  it('commits one receipt per row, keeps the good rows when a bad one is refused, and replays a retry', async () => {
    const source = csv(
      'Sorrel Test Works,https://sorrel.example.test,,Providence,RI,02903,SO-1,,Lee Placeholder,Owner,lee@sorrel.example.test,+14015550112',
      'Tansy Test Partners,,,,,,,,,,,',
      ',,,,,,,,,,,',
    );
    const preview = await post('/import/preview', adminToken, { csv: source });
    expect(preview.status).toBe(200);

    const commandIds = { 2: randomUUID(), 3: randomUUID(), 4: randomUUID() } as const;
    const body = {
      clientVersion: CURRENT_CLIENT_VERSION,
      csv: source,
      rows: [
        { rowNumber: 2, commandId: commandIds[2] },
        { rowNumber: 3, commandId: commandIds[3] },
        { rowNumber: 4, commandId: commandIds[4] },
      ],
    };
    const first = await post('/import/commit', adminToken, body);
    expect(first.status).toBe(200);
    const parsed = importCommitResponseSchema.safeParse(first.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    if (!parsed.success) return;

    // Row 4 is blank, so the parser drops it: the commit says so rather than
    // inventing a row number the file never had.
    expect(parsed.data.results.map(result => [result.rowNumber, result.status])).toEqual([
      [2, 'accepted'],
      [3, 'accepted'],
      [4, 'refused'],
    ]);
    expect(parsed.data.results[2]?.reason).toBe('row_unknown');
    expect(parsed.data.results.every(result => !result.replayed)).toBe(true);

    // One receipt per row, of the import kind, and no more.
    const receipts = await fixture.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM command_receipts
        WHERE workspace_id = $1 AND command_kind = 'crm.import_row'`,
      [fixture.alpha.workspaceId],
    );
    expect(Number(receipts.rows[0]?.count)).toBe(2);

    // The same file again, with the same ids: replays, and imports nothing twice.
    const again = await post('/import/commit', adminToken, body);
    const replayed = importCommitResponseSchema.parse(again.body);
    expect(replayed.results.slice(0, 2).every(result => result.replayed)).toBe(true);
    expect(replayed.results[0]?.firmId).toBe(parsed.data.results[0]?.firmId);
    const firms = await fixture.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM firms WHERE workspace_id = $1 AND name = 'Sorrel Test Works'",
      [fixture.alpha.workspaceId],
    );
    expect(Number(firms.rows[0]?.count)).toBe(1);
  });

  it('refuses a row whose content changed under an id that was already spent', async () => {
    const commandId = randomUUID();
    const original = csv('Vetch Test Co,,,,,,,,,,,');
    const committed = await post('/import/commit', adminToken, {
      clientVersion: CURRENT_CLIENT_VERSION,
      csv: original,
      rows: [{ rowNumber: 2, commandId }],
    });
    expect(importCommitResponseSchema.parse(committed.body).results[0]?.status).toBe('accepted');

    const edited = csv('Vetch Test Co,https://vetch.example.test,,,,,,,,,,');
    const second = await post('/import/commit', adminToken, {
      clientVersion: CURRENT_CLIENT_VERSION,
      csv: edited,
      rows: [{ rowNumber: 2, commandId }],
    });
    const result = importCommitResponseSchema.parse(second.body).results[0];
    expect(result?.status).toBe('refused');
    expect(result?.reason).toBe('command_payload_mismatch');
  });

  it('refuses an outdated client at the commit and leaves the command ids unspent', async () => {
    const commandId = randomUUID();
    const source = csv('Yarrow Test Co,,,,,,,,,,,');
    const outdated = await post('/import/commit', adminToken, {
      clientVersion: OUTDATED_CLIENT_VERSION,
      csv: source,
      rows: [{ rowNumber: 2, commandId }],
    });
    const refused = importCommitResponseSchema.parse(outdated.body).results[0];
    expect(refused?.status).toBe('refused');
    expect(refused?.reason).toBe('client_upgrade_required');

    const upgraded = await post('/import/commit', adminToken, {
      clientVersion: CURRENT_CLIENT_VERSION,
      csv: source,
      rows: [{ rowNumber: 2, commandId }],
    });
    const accepted = importCommitResponseSchema.parse(upgraded.body).results[0];
    expect(accepted?.status).toBe('accepted');
    expect(accepted?.replayed).toBe(false);
  });

  // ------------------------------------------------------------------ firm page
  it('serves the Firm page at the caller’s width and refuses an unknown firm as not found', async () => {
    const firmId = await seedFirm(fixture, {
      name: 'Bramble Test Advisors',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: salespersonUserId,
    });

    const mine = await post('/crm/firm-page', salespersonToken, { firmId });
    expect(mine.status).toBe(200);
    const parsed = firmPageResponseSchema.safeParse(mine.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.visibility).toBe('assigned_or_admin');

    // A firm that does not exist and a firm in another workspace are one answer,
    // and it is the answer an unmounted path gets.
    const missing = await post('/crm/firm-page', salespersonToken, {
      firmId: '00000000-0000-4000-8000-000000000000',
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found', message: 'No such endpoint.' });
  });
});
