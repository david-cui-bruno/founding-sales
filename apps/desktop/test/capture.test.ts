import { describe, expect, it } from 'vitest';
import { IMPORT_COLUMNS, IMPORT_ISSUE_CODES, importPreviewResponseSchema, type ImportPreviewResponse } from '@fss/contracts';
import type { HttpAnswer } from '../src/main/apiClient.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import { EMPTY_ADD_FIRM, MAX_IMPORT_FILE_CHARACTERS, addFirmBody, createCrmBridge } from '../src/main/crmBridge.ts';
import {
  COLUMN_LABELS,
  ISSUE_SENTENCES,
  addFirmSubmittable,
  commitLine,
  committableCount,
  fileRefusalSentence,
  importSummary,
  issueLine,
  matchLine,
} from '../src/renderer/captureView.ts';
import { CHECK_FIELDS, buildFirmWorkspaceView, noticeText } from '../src/renderer/firmWorkspaceView.ts';

/**
 * Add firm and Import on the Mac (lane g84, audit item G02), without a DOM.
 *
 * The bridge is driven through the real authenticated client with the socket scripted,
 * so what is asserted is what would cross the wire: the Add firm body with blank fields
 * left out, and an import commit whose command ids are one per row, minted once per
 * preview, with no request-level id the server would refuse. The views are pure
 * functions of the server's answers; every issue code and every column has its words.
 *
 * No name, address or number here belongs to anybody: `example.test` is reserved by RFC
 * 6761 and the numbers are in the NANP 555-01XX fictional block.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';

function scriptedApi(answers: Readonly<Record<string, HttpAnswer>>) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const api = createAuthedClient({
    baseUrl: 'https://api.example.test/',
    clientVersion: '1.0.5',
    accessToken: async () => await Promise.resolve('token-value'),
    send: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: init.body === undefined ? null : (JSON.parse(init.body) as Record<string, unknown>) });
      return await Promise.resolve(answers[path] ?? { status: 404, body: { error: 'not_found' } });
    },
  });
  return { api, calls };
}

const session = (role: 'admin' | 'salesperson' = 'admin') => ({
  state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role } }),
});

const identity = {
  id: FIRM_ID,
  name: 'Aspen Test Wealth',
  website: 'https://aspen.example.test',
  locality: null,
  regionCode: null,
  status: 'active',
  assignedUserId: null,
  stageKey: null,
  opportunityStatus: null,
  controlMode: null,
  openedAt: null,
  timeZone: 'America/New_York',
  timeZoneUnresolvedReason: null,
};

const firmPage = {
  visibility: 'assigned_or_admin',
  read: {
    visibility: 'assigned_or_admin',
    firm: {
      ...identity,
      addressLine: null,
      postalCode: null,
      countryCode: 'US',
      timeZoneConfidence: 'high',
      timeZoneSource: 'recorded',
      contacts: [],
      phoneRoutes: [],
      emailRoutes: [],
      aliases: [],
    },
  },
  opportunity: null,
  stageHistory: [],
  holds: [],
};

const firmRow = {
  name: 'Aspen Test Wealth',
  website: 'https://aspen.example.test',
  addressLine: null,
  locality: null,
  regionCode: null,
  postalCode: null,
  externalId: null,
  ownerUserId: null,
  timeZone: null,
};

function preview(): ImportPreviewResponse {
  return importPreviewResponseSchema.parse({
    rows: [
      { rowNumber: 2, outcome: 'create', issues: [], firm: firmRow, contact: { fullName: 'Kim Placeholder', title: null }, routes: [{ kind: 'email', value: 'kim@aspen.example.test' }], match: null },
      { rowNumber: 3, outcome: 'attach', issues: [], firm: firmRow, contact: { fullName: 'Lee Placeholder', title: null }, routes: [], match: { kind: 'in_file', rowNumber: 2, matchedOn: 'domain' } },
      { rowNumber: 4, outcome: 'duplicate', issues: [{ column: 'contact_email', code: 'duplicate_in_file' }], firm: firmRow, contact: { fullName: 'Kim Again', title: null }, routes: [{ kind: 'email', value: 'kim@aspen.example.test' }], match: { kind: 'in_file', rowNumber: 2, matchedOn: 'domain' } },
      { rowNumber: 5, outcome: 'invalid', issues: [{ column: 'contact_phone', code: 'phone_invalid' }], firm: { ...firmRow, name: 'Quince Test Co', website: null }, contact: { fullName: 'Pat Placeholder', title: null }, routes: [], match: null },
    ],
    counts: { create: 1, attach: 1, duplicate: 1, invalid: 1 },
  });
}

describe('the Add firm body', () => {
  it('leaves blank fields out, and sends no contact when every contact field is blank', () => {
    expect(addFirmBody({ ...EMPTY_ADD_FIRM, name: 'Aspen Test Wealth', website: '  ' })).toEqual({ firm: { name: 'Aspen Test Wealth' } });
    expect(
      addFirmBody({ ...EMPTY_ADD_FIRM, name: 'Aspen Test Wealth', timeZone: 'America/Chicago', contactEmail: 'kim@aspen.example.test' }),
    ).toEqual({
      firm: { name: 'Aspen Test Wealth', timeZone: 'America/Chicago' },
      // The name is sent blank so the server names the missing field, rather than the Mac
      // dropping an address it could not attach to anybody.
      contact: { fullName: '', email: 'kim@aspen.example.test' },
    });
  });
});

describe('the CRM bridge: Add firm', () => {
  it('sends one command and moves to the new firm’s page', async () => {
    const { api, calls } = scriptedApi({
      '/crm/firms/add': { status: 200, body: { status: 'accepted', replayed: false, result: { firmId: FIRM_ID, contactId: null, routeIds: [] } } },
      '/crm/firm-page': { status: 200, body: firmPage },
    });
    const bridge = createCrmBridge({ api, clientVersion: '1.0.5', session: session() });
    await bridge.openAddFirm();
    const state = await bridge.addFirm({ ...EMPTY_ADD_FIRM, name: 'Aspen Test Wealth', website: 'aspen.example.test' });
    // The page, then its Sequences section's two reads (lane g88).
    expect(calls.map(call => call.path)).toEqual(['/crm/firms/add', '/crm/firm-page', '/sequences', '/enrollments']);
    expect(calls[0]?.body).toMatchObject({ clientVersion: '1.0.5', firm: { name: 'Aspen Test Wealth', website: 'aspen.example.test' } });
    expect(typeof calls[0]?.body?.['commandId']).toBe('string');
    expect(state.screen).toBe('firm');
    expect(state.notice).toBe('firm_added');
    expect(state.addFirm).toBeNull();
    expect(buildFirmWorkspaceView(state).banners).toContainEqual({ tone: 'info', text: 'Firm added.' });
  });

  it('comes back with what was typed, every field the server named, and the firm already here', async () => {
    const { api } = scriptedApi({
      '/crm/firms/add': {
        status: 409,
        body: {
          status: 'refused',
          replayed: false,
          reason: 'duplicate_in_workspace',
          issues: [{ column: 'website', code: 'duplicate_in_workspace' }],
          firmId: FIRM_ID,
        },
      },
    });
    const bridge = createCrmBridge({ api, clientVersion: '1.0.5', session: session() });
    const draft = { ...EMPTY_ADD_FIRM, name: 'Aspen', website: 'aspen.example.test', contactName: 'Kim Placeholder' };
    const state = await bridge.addFirm(draft);
    expect(state.screen).toBe('add_firm');
    expect(state.addFirm).toEqual({ draft, issues: [{ column: 'website', code: 'duplicate_in_workspace' }], duplicateFirmId: FIRM_ID });
    expect(buildFirmWorkspaceView(state).banners.map(banner => banner.text)).toEqual([
      'That firm is already here. Open it, or change the website or the name.',
    ]);
  });

  it('points a field refusal at the fields', () => {
    expect(noticeText('email_invalid')).toBe(CHECK_FIELDS);
    expect(addFirmSubmittable('  ', true)).toBe(false);
    expect(addFirmSubmittable('Aspen', false)).toBe(false);
    expect(addFirmSubmittable('Aspen', true)).toBe(true);
  });
});

describe('the CRM bridge: Import', () => {
  const csv = `${IMPORT_COLUMNS.join(',')}\nAspen Test Wealth,aspen.example.test,,,,,,,Kim Placeholder,,kim@aspen.example.test,,`;

  it('previews, then commits the new firms and added contacts under ids minted once, in the per-row envelope', async () => {
    const { api, calls } = scriptedApi({
      '/import/preview': { status: 200, body: preview() },
      '/import/commit': {
        status: 200,
        body: {
          results: [
            { rowNumber: 2, status: 'accepted', replayed: false, reason: null, firmId: FIRM_ID, column: null, outcome: 'created' },
            { rowNumber: 3, status: 'refused', replayed: false, reason: 'duplicate_in_workspace', firmId: null, column: 'contact_email', outcome: null },
          ],
          counts: { accepted: 1, refused: 1 },
        },
      },
    });
    const bridge = createCrmBridge({ api, clientVersion: '1.0.5', session: session() });
    await bridge.openImport();
    const previewed = await bridge.previewImport({ csv, fileName: 'prospects.csv' });
    expect(previewed.screen).toBe('import');
    expect(previewed.import?.preview?.counts).toEqual({ create: 1, attach: 1, duplicate: 1, invalid: 1 });
    expect(previewed.import?.fileName).toBe('prospects.csv');
    expect(calls[0]?.body).toEqual({ csv });

    const first = await bridge.commitImport();
    const second = await bridge.commitImport();
    const commits = calls.filter(call => call.path === '/import/commit');
    expect(commits).toHaveLength(2);
    const body = commits[0]?.body ?? {};
    expect(Object.keys(body).sort()).toEqual(['clientVersion', 'csv', 'rows']);
    expect(body['clientVersion']).toBe('1.0.5');
    const rows = body['rows'] as { rowNumber: number; commandId: string }[];
    expect(rows.map(row => row.rowNumber)).toEqual([2, 3]);
    // The same preview, pressed twice: the same ids, so the second press replays.
    expect(commits[1]?.body?.['rows']).toEqual(rows);

    expect(first.notice).toBe('imported_with_refusals');
    expect(second.import?.results?.counts).toEqual({ accepted: 1, refused: 1 });
    expect(commitLine(first.import?.results?.results[1] ?? ({} as never))).toBe('Row 3 · Email: Already here.');
  });

  it('shows a whole file’s refusal where it is, and a role refusal as a notice', async () => {
    const refused = scriptedApi({
      '/import/preview': { status: 409, body: { status: 'refused', reason: 'csv_column_unknown', column: 'Notes', rowNumber: null } },
    });
    const bridge = createCrmBridge({ api: refused.api, clientVersion: '1.0.5', session: session() });
    const state = await bridge.previewImport({ csv: 'firm_name,Notes\nA,B', fileName: 'x.csv' });
    expect(state.notice).toBeNull();
    expect(state.import?.fileRefusal).toEqual({ reason: 'csv_column_unknown', column: 'Notes', rowNumber: null });
    expect(fileRefusalSentence({ reason: 'csv_column_unknown', column: 'Notes', rowNumber: null })).toBe(
      'The column “Notes” is not one Callie imports. Remove it or rename it.',
    );
    expect(fileRefusalSentence({ reason: 'csv_row_width', column: null, rowNumber: 7 })).toBe(
      'Line 7 has a different number of cells from the header.',
    );

    const role = scriptedApi({
      '/import/preview': { status: 409, body: { status: 'refused', reason: 'admin_only', column: null, rowNumber: null } },
    });
    const salesperson = createCrmBridge({ api: role.api, clientVersion: '1.0.5', session: session('salesperson') });
    const answered = await salesperson.previewImport({ csv, fileName: 'x.csv' });
    expect(answered.notice).toBe('admin_only');
    expect(answered.import?.fileRefusal).toBeNull();
  });

  it('refuses a file over the server’s bound without sending it, and commits nothing before a preview', async () => {
    const { api, calls } = scriptedApi({});
    const bridge = createCrmBridge({ api, clientVersion: '1.0.5', session: session() });
    const large = await bridge.previewImport({ csv: 'x'.repeat(MAX_IMPORT_FILE_CHARACTERS + 1), fileName: 'big.csv' });
    expect(large.notice).toBe('import_file_too_large');
    const nothing = await bridge.commitImport();
    expect(nothing.notice).toBe('import_nothing_to_commit');
    expect(calls).toEqual([]);
  });

  it('keeps the firms no column holds on the pipeline', async () => {
    const { api } = scriptedApi({
      '/pipeline/board': { status: 200, body: { columns: [], opportunityIdByFirmId: {}, unplacedFirms: [identity] } },
    });
    const bridge = createCrmBridge({ api, clientVersion: '1.0.5', session: session() });
    const state = await bridge.openPipeline();
    expect(state.pipeline?.unplacedFirms?.map(firm => firm.name)).toEqual(['Aspen Test Wealth']);
  });
});

describe('what the capture screens say', () => {
  it('has words for every issue code and a label for every column', () => {
    expect(Object.keys(ISSUE_SENTENCES).sort()).toEqual([...IMPORT_ISSUE_CODES].sort());
    expect(Object.keys(COLUMN_LABELS).sort()).toEqual([...IMPORT_COLUMNS].sort());
  });

  it('summarizes a preview and names each row’s firm and fault', () => {
    const answer = preview();
    expect(importSummary(answer)).toBe('4 rows · 1 new firm · 1 contact added to a firm · 1 already here · 1 to fix');
    expect(committableCount(answer)).toBe(2);
    expect(matchLine(answer.rows[1] ?? ({} as never))).toBe('the firm on row 2');
    expect(issueLine({ column: 'contact_phone', code: 'phone_invalid' })).toBe(
      'Phone: Not a number Callie can dial. Use ten digits, or + and the country code.',
    );
    expect(
      commitLine({ rowNumber: 9, status: 'refused', replayed: true, reason: 'command_payload_mismatch', firmId: null, column: null, outcome: null }),
    ).toBe('Row 9 · This row changed since it was first imported. Preview the file again.');
  });
});
