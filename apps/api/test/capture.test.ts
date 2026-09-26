import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IMPORT_COLUMNS,
  addFirmAcceptedSchema,
  addFirmRefusalSchema,
  importCommitResponseSchema,
  importFileRefusalResponseSchema,
  importPreviewResponseSchema,
  wireDrift,
} from '@fss/contracts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, OUTDATED_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * Capturing firms from the desktop, through the real dispatcher (lane g84, audit item
 * G02): the import file with a row per contact, and `POST /crm/firms/add`.
 *
 * `@fss/domain`'s `capture.test.ts` proves the matching rules against a real PostgreSQL.
 * What is proved here is the surface the Mac reads: every answer is exactly the contract
 * in `@fss/contracts` (`wireDrift` is empty), a refusal names its row and its column —
 * on the first answer and on a replay — and the rows of one file commit in row order, so
 * a contact is added to the firm the row above it created whatever order they were asked
 * in.
 *
 * **The vacuous-pass trap.** A commit asked in row order passes a route that ignores the
 * order. The file below is asked for backwards.
 */
describe('capturing firms through the API', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  let salespersonToken = '';

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
  });

  const post = async (path: string, token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    // Through JSON, as a socket would carry it.
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body)) as Record<string, unknown> };
  };

  const row = (values: Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>): string =>
    IMPORT_COLUMNS.map(column => values[column] ?? '').join(',');
  const csv = (...rows: readonly string[]): string => [IMPORT_COLUMNS.join(','), ...rows].join('\n');

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  // ------------------------------------------------------------------- the import file
  it('previews a row per contact, exactly as the contract says', async () => {
    const source = csv(
      row({ firm_name: 'Juniper Test Wealth', website: 'juniper.example.test', region_code: 'RI', contact_name: 'Kim Placeholder', contact_email: 'kim@juniper.example.test' }),
      row({ firm_name: 'Juniper Test Wealth', website: 'juniper.example.test', contact_name: 'Lee Placeholder', contact_phone: '401 555 0131' }),
      row({ firm_name: 'Juniper Test Wealth', website: 'juniper.example.test', contact_name: 'Kim Again', contact_email: 'kim@juniper.example.test' }),
      row({ firm_name: 'Quince Test Co', contact_name: 'Pat Placeholder', contact_email: 'pat@@quince' }),
    );
    const preview = await post('/import/preview', adminToken, { csv: source });
    expect(preview.status).toBe(200);
    expect(wireDrift(importPreviewResponseSchema, preview.body)).toEqual([]);
    const parsed = importPreviewResponseSchema.parse(preview.body);
    expect(parsed.counts).toEqual({ create: 1, attach: 1, duplicate: 1, invalid: 1 });
    expect(parsed.rows.map(entry => [entry.rowNumber, entry.outcome, entry.issues.map(issue => `${issue.column}:${issue.code}`)])).toEqual([
      [2, 'create', []],
      [3, 'attach', []],
      [4, 'duplicate', ['contact_email:duplicate_in_file']],
      [5, 'invalid', ['contact_email:email_invalid']],
    ]);
    expect(parsed.rows[1]?.match).toEqual({ kind: 'in_file', rowNumber: 2, matchedOn: 'domain' });
  });

  it('commits in row order when asked backwards, then replays, and names a refused row’s column', async () => {
    const source = csv(
      row({ firm_name: 'Hawthorn Test Partners', website: 'hawthorn.example.test', contact_name: 'Ari Placeholder', contact_email: 'ari@hawthorn.example.test' }),
      row({ firm_name: 'Hawthorn Test Partners', website: 'hawthorn.example.test', contact_name: 'Bo Placeholder', contact_email: 'bo@hawthorn.example.test' }),
      row({ firm_name: 'Hawthorn Test Partners', website: 'hawthorn.example.test', contact_name: 'Ari Twice', contact_email: 'ari@hawthorn.example.test' }),
    );
    const ids = [randomUUID(), randomUUID(), randomUUID()] as const;
    const body = {
      clientVersion: CURRENT_CLIENT_VERSION,
      csv: source,
      rows: [
        { rowNumber: 4, commandId: ids[2] },
        { rowNumber: 3, commandId: ids[1] },
        { rowNumber: 2, commandId: ids[0] },
      ],
    };
    const first = await post('/import/commit', adminToken, body);
    expect(first.status).toBe(200);
    expect(wireDrift(importCommitResponseSchema, first.body)).toEqual([]);
    const results = importCommitResponseSchema.parse(first.body).results;
    expect(results.map(result => [result.rowNumber, result.status, result.outcome, result.reason, result.column])).toEqual([
      [2, 'accepted', 'created', null, null],
      [3, 'accepted', 'attached', null, null],
      [4, 'refused', null, 'duplicate_in_file', 'contact_email'],
    ]);
    expect(results[0]?.firmId).toBe(results[1]?.firmId);

    // The same file and ids again: the rows that landed replay with their outcome, and
    // the refused row replays its refusal with its column — from the receipt.
    const again = await post('/import/commit', adminToken, body);
    expect(wireDrift(importCommitResponseSchema, again.body)).toEqual([]);
    const replayed = importCommitResponseSchema.parse(again.body).results;
    expect(replayed.map(result => [result.replayed, result.outcome ?? null, result.column ?? null])).toEqual([
      [true, 'created', null],
      [true, 'attached', null],
      [true, null, 'contact_email'],
    ]);
    const firms = await fixture.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM firms WHERE workspace_id = $1 AND name = 'Hawthorn Test Partners'",
      [fixture.alpha.workspaceId],
    );
    expect(firms.rows[0]?.count).toBe('1');
  });

  it('answers a row asked for twice once', async () => {
    const source = csv(row({ firm_name: 'Sumac Test Group' }));
    const answer = await post('/import/commit', adminToken, {
      clientVersion: CURRENT_CLIENT_VERSION,
      csv: source,
      rows: [
        { rowNumber: 2, commandId: randomUUID() },
        { rowNumber: 2, commandId: randomUUID() },
      ],
    });
    const results = importCommitResponseSchema.parse(answer.body).results;
    expect(results.map(result => [result.status, result.reason])).toEqual([
      ['accepted', null],
      ['refused', 'row_repeated'],
    ]);
  });

  it('refuses a whole file naming the header or the line, exactly as the contract says', async () => {
    const unknown = await post('/import/preview', adminToken, { csv: 'firm_name,Notes\nAlder Test Co,hello' });
    expect(unknown.status).toBe(409);
    expect(wireDrift(importFileRefusalResponseSchema, unknown.body)).toEqual([]);
    expect(unknown.body).toEqual({ status: 'refused', reason: 'csv_column_unknown', column: 'Notes', rowNumber: null });

    const ragged = await post('/import/commit', adminToken, {
      clientVersion: CURRENT_CLIENT_VERSION,
      csv: 'firm_name,website\nAlder Test Co,\nElm Test Co',
      rows: [{ rowNumber: 2, commandId: randomUUID() }],
    });
    expect(ragged.status).toBe(409);
    expect(wireDrift(importFileRefusalResponseSchema, ragged.body)).toEqual([]);
    expect(ragged.body).toMatchObject({ reason: 'csv_row_width', rowNumber: 3 });
  });

  // ------------------------------------------------------------------------- Add firm
  it('adds a firm with its first contact, for a salesperson, exactly as the contract says', async () => {
    const answer = await post('/crm/firms/add', salespersonToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firm: { name: 'Larch Test Advisors', website: 'larch.example.test', timeZone: 'America/New_York' },
      contact: { fullName: 'Rae Placeholder', title: 'Principal', email: 'rae@larch.example.test', phone: '+1 401 555 0132' },
    });
    expect(answer.status).toBe(200);
    expect(wireDrift(addFirmAcceptedSchema, answer.body)).toEqual([]);
    const accepted = addFirmAcceptedSchema.parse(answer.body);
    expect(accepted.result.routeIds).toHaveLength(2);
    const firm = await fixture.db.query<{ assigned_user_id: string }>(
      'SELECT assigned_user_id FROM firms WHERE workspace_id = $1 AND id = $2',
      [fixture.alpha.workspaceId, accepted.result.firmId],
    );
    expect(firm.rows[0]?.assigned_user_id).toBe(fixture.alpha.salesperson.userId);
    const receipts = await fixture.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE workspace_id = $1 AND command_kind = 'crm.add_firm'",
      [fixture.alpha.workspaceId],
    );
    expect(receipts.rows[0]?.count).toBe('1');
  });

  it('refuses naming every field at fault, and a replay says the same', async () => {
    const body = {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firm: { name: 'Olive Test Co', website: 'not a website' },
      contact: { fullName: '', email: 'someone@olive.example.test' },
    };
    for (const attempt of ['first', 'replay'] as const) {
      const answer = await post('/crm/firms/add', adminToken, body);
      expect(answer.status, attempt).toBe(409);
      expect(wireDrift(addFirmRefusalSchema, answer.body), attempt).toEqual([]);
      const refused = addFirmRefusalSchema.parse(answer.body);
      expect(refused.replayed, attempt).toBe(attempt === 'replay');
      expect(refused.reason, attempt).toBe('website_invalid');
      expect(refused.issues?.map(issue => `${issue.column}:${issue.code}`).sort(), attempt).toEqual([
        'contact_name:contact_name_missing',
        'website:website_invalid',
      ]);
    }
  });

  it('refuses a firm that is already here with its id', async () => {
    const first = await post('/crm/firms/add', adminToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firm: { name: 'Poplar Test Holdings', website: 'poplar.example.test' },
    });
    const firmId = addFirmAcceptedSchema.parse(first.body).result.firmId;
    const second = await post('/crm/firms/add', adminToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firm: { name: 'Poplar Holdings (new)', website: 'https://www.poplar.example.test/' },
    });
    expect(second.status).toBe(409);
    expect(wireDrift(addFirmRefusalSchema, second.body)).toEqual([]);
    expect(addFirmRefusalSchema.parse(second.body)).toMatchObject({ reason: 'duplicate_in_workspace', firmId });
  });

  it('refuses an outdated client with 426 and a malformed body with 400', async () => {
    const outdated = await post('/crm/firms/add', adminToken, {
      commandId: randomUUID(),
      clientVersion: OUTDATED_CLIENT_VERSION,
      firm: { name: 'Spruce Test Co' },
    });
    expect(outdated.status).toBe(426);
    expect(wireDrift(addFirmRefusalSchema, outdated.body)).toEqual([]);
    const malformed = await post('/crm/firms/add', adminToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firm: { name: 'Spruce Test Co', notes: 'not a field' },
    });
    expect(malformed.status).toBe(400);
  });
});
