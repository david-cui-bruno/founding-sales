import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IMPORT_COLUMNS,
  exportResponseSchema,
  importCommitResponseSchema,
  importPreviewResponseSchema,
  searchResponseSchema,
} from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, OUTDATED_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * Search, admin CSV import and export, through the real dispatcher with real
 * sessions (specification 7.2, 5.2, Appendix F, Appendix G 7, 8 and 38).
 *
 * The domain tests in `@fss/domain` prove the rules against a real PostgreSQL. What
 * is proved here is the surface: that the three endpoints are mounted, that they
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

  const csv = (...rows: readonly string[]): string => [IMPORT_COLUMNS.join(','), ...rows].join('\n');

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
    for (const path of ['/search/firms', '/import/preview', '/import/commit', '/export/firms']) {
      const answer = await post(path, null, {});
      expect(answer.status, path).toBe(401);
    }
  });

  it('refuses a method other than POST, and an unmounted neighbour', async () => {
    const read = await dispatch(
      {
        method: 'GET',
        path: '/search/firms',
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${adminToken}` },
        body: undefined,
      },
      options(),
    );
    expect(read.status).toBe(405);

    const neighbour = await post('/search/contacts', adminToken, {});
    expect(neighbour.status).toBe(404);
  });

  // --------------------------------------------------------------------- search
  it('searches, and answers the contract schema', async () => {
    const created = await post('/firms/create', adminToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      name: 'Bramble Test Advisors',
      regionCode: 'RI',
      postalCode: '02903',
      assignedUserId: salespersonUserId,
    });
    expect(created.status).toBe(200);

    const found = await post('/search/firms', salespersonToken, { term: 'Bramble' });
    expect(found.status).toBe(200);
    const parsed = searchResponseSchema.safeParse(found.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.hits.map(hit => hit.firm.name)).toEqual(['Bramble Test Advisors']);
    expect(parsed.data.hits[0]?.matchedOn).toEqual(['name']);
  });

  it('refuses a filter the workspace cannot honour, with a reason rather than a 500', async () => {
    const found = await post('/search/firms', adminToken, { filters: { stageKey: 'not-a-stage' } });
    expect(found.status).toBe(409);
    expect(found.body['reason']).toBe('stage_unknown');
  });

  it('refuses a body that is not a search request', async () => {
    const found = await post('/search/firms', adminToken, { term: 'x', mystery: true });
    expect(found.status).toBe(400);
  });

  // ---------------------------------------------- Appendix G 38: the import surface
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
    expect(parsed.data.counts).toEqual({ create: 1, duplicate: 1, invalid: 2 });
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

  // --------------------------------------------------------------------- export
  it('exports typed redacted rows and audits the export once', async () => {
    const before = await exportAudits();
    const exported = await post('/export/firms', salespersonToken, { term: 'Bramble' });
    expect(exported.status).toBe(200);
    const parsed = exportResponseSchema.safeParse(exported.body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.rows).toHaveLength(1);
    expect(parsed.data.rows[0]?.visibility).toBe('assigned_or_admin');
    expect(await exportAudits()).toBe(before + 1);
  });

  it('gives a salesperson a colleague’s firm at identity width and nothing more', async () => {
    const exported = await post('/export/firms', salespersonToken, { term: 'Sorrel' });
    const parsed = exportResponseSchema.parse(exported.body);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.visibility).toBe('any_active_member');
    expect(JSON.stringify(parsed.rows)).not.toContain('lee@sorrel.example.test');
    expect(JSON.stringify(parsed.rows)).not.toContain('Lee Placeholder');
  });

  async function exportAudits(): Promise<number> {
    const { rows } = await fixture.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_events WHERE workspace_id = $1 AND action = 'export.firms'",
      [fixture.alpha.workspaceId],
    );
    return Number(rows[0]?.count ?? '0');
  }
});
