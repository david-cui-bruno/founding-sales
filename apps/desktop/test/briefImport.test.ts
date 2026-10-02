import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiOutcome } from '../src/main/apiClient.ts';
import type { AuthedClient } from '../src/main/authedClient.ts';
import { createBriefImport, parseBriefFile } from '../src/main/briefImport.ts';
import { briefImportViewSchema } from '../src/shared/briefImport.ts';

/**
 * Lane PB: the prepared-brief import in the main process — the file read and checked here,
 * the match asked of the server, one set command per matched row under the id minted at
 * the preview, and a refused row that leaves the others alone.
 */

const FIRM_A = '11111111-1111-4111-8111-111111111111';
const FIRM_B = '22222222-2222-4222-8222-222222222222';

const row = (fields: Record<string, unknown>): Record<string, unknown> => ({
  brief: 'Who to ask for: unknown\nBrief: call the office.',
  sources: [{ url: 'https://firm.example.test/contact', label: 'Phone source' }],
  observed_on: '2026-10-02',
  prepared_by: 'Callie research agent (web), verified phones',
  ...fields,
});

const FILE = [
  row({ external_id: 'dfw-20261002-e01', firm_name: 'Alpha Test Co' }),
  row({ external_id: 'dfw-20261002-w01', firm_name: 'Bravo Test Co' }),
  row({ external_id: 'dfw-20261002-x99', firm_name: 'Nobody Test Co' }),
  row({ firm_name: 'Twin Test Co' }),
  row({ external_id: 'dfw-20261002-e02', sources: [{ url: 'http://firm.example.test/', label: 'Plain' }] }),
];

interface Call {
  readonly kind: 'read' | 'command';
  readonly path: string;
  readonly body: unknown;
  readonly commandId?: string | undefined;
}

function fakeApi(refuseFirm: string | null = null): { api: AuthedClient; calls: Call[] } {
  const calls: Call[] = [];
  const api = {
    read: async <T>(path: string, parse: (value: unknown) => T, body?: unknown): Promise<ApiOutcome<T>> => {
      calls.push({ kind: 'read', path, body });
      return await Promise.resolve({
        ok: true as const,
        value: parse({
          rows: [
            { status: 'matched', firmId: FIRM_A, firmName: 'Alpha Test Co', matchedOn: 'external_id' },
            { status: 'matched', firmId: FIRM_B, firmName: 'Bravo Test Co', matchedOn: 'external_id' },
            { status: 'unmatched' },
            { status: 'ambiguous', column: 'firm_name' },
          ],
        }),
      });
    },
    command: async <T>(path: string, body: Record<string, unknown>, parse: (value: unknown) => T, options?: { commandId?: string }): Promise<ApiOutcome<T>> => {
      calls.push({ kind: 'command', path, body, commandId: options?.commandId });
      if (body['firmId'] === refuseFirm) return { ok: false as const, reason: 'not_assigned', offline: false };
      return {
        ok: true as const,
        value: parse({ firmId: body['firmId'], created: true, briefLength: 10, sourceCount: 1, updatedAt: '2026-10-02T15:00:00.000Z' }),
      };
    },
  };
  return { api: api as unknown as AuthedClient, calls };
}

const importer = (api: AuthedClient, text: string) =>
  createBriefImport({
    api,
    openDialog: async () => await Promise.resolve({ canceled: false, filePaths: ['/Users/test/dfw-batch-1-briefs.json'] }),
    read: async () => await Promise.resolve(text),
  });

describe('parseBriefFile', () => {
  it('refuses a file that is not a JSON array of rows, and checks each row on its own', () => {
    expect(parseBriefFile('not json')).toEqual({ ok: false, error: 'not_json' });
    expect(parseBriefFile('{"a":1}')).toEqual({ ok: false, error: 'not_array' });
    expect(parseBriefFile('[]')).toEqual({ ok: false, error: 'empty' });
    const parsed = parseBriefFile(JSON.stringify([row({ external_id: 'x' }), row({}), row({ firm_name: 'Late Test Co', brief: 'x'.repeat(4001) })]));
    expect(parsed.ok && parsed.rows.map(entry => (entry.ok ? 'ok' : entry.issue))).toEqual(['ok', 'firm', 'brief']);
  });
});

describe('the prepared-brief import', () => {
  it('previews matched, unmatched, ambiguous and invalid rows, sending the server identifiers only', async () => {
    const { api, calls } = fakeApi();
    const view = await importer(api, JSON.stringify(FILE)).choose();
    expect(briefImportViewSchema.parse(view)).toEqual(view);
    expect(view.fileName).toBe('dfw-batch-1-briefs.json');
    expect(view.rows.map(entry => [entry.index, entry.status, entry.issue])).toEqual([
      [1, 'matched', null],
      [2, 'matched', null],
      [3, 'unmatched', null],
      [4, 'ambiguous', 'firm_name'],
      [5, 'invalid', 'sources'],
    ]);
    // The match read carries the four valid rows' identifiers, and no brief text.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/firms/brief/match');
    expect(JSON.stringify(calls[0]?.body)).not.toContain('call the office');
    expect((calls[0]?.body as { rows: unknown[] }).rows).toEqual([
      { externalId: 'dfw-20261002-e01', firmName: 'Alpha Test Co' },
      { externalId: 'dfw-20261002-w01', firmName: 'Bravo Test Co' },
      { externalId: 'dfw-20261002-x99', firmName: 'Nobody Test Co' },
      { firmName: 'Twin Test Co' },
    ]);
    // The view never holds the brief.
    expect(JSON.stringify(view)).not.toContain('call the office');
  });

  it('commits one set command per matched row with its own id; a refused row stays refused and the rest land', async () => {
    const { api, calls } = fakeApi(FIRM_B);
    const host = importer(api, JSON.stringify(FILE));
    await host.choose();
    const preview = await host.choose();
    const committed = await host.commit({ previewId: preview.previewId });
    const sets = calls.filter(call => call.kind === 'command');
    expect(sets.map(call => [call.path, (call.body as { firmId: string }).firmId])).toEqual([
      ['/firms/brief/set', FIRM_A],
      ['/firms/brief/set', FIRM_B],
    ]);
    expect(sets[0]?.body).toEqual({
      firmId: FIRM_A,
      brief: 'Who to ask for: unknown\nBrief: call the office.',
      sources: [{ url: 'https://firm.example.test/contact', label: 'Phone source' }],
      observedOn: '2026-10-02',
      preparedBy: 'Callie research agent (web), verified phones',
    });
    expect(new Set(sets.map(call => call.commandId)).size).toBe(2);
    expect(committed.rows.map(entry => entry.result)).toEqual(['saved', 'not_assigned', null, null, null]);

    // A second press sends only the refused row, under the id it was first sent with.
    calls.length = 0;
    await host.commit({ previewId: preview.previewId });
    expect(calls.map(call => [(call.body as { firmId: string }).firmId, call.commandId])).toEqual([[FIRM_B, sets[1]?.commandId]]);
  });

  it('forgets the file and its preview, and a cancelled panel changes nothing', async () => {
    const { api } = fakeApi();
    const host = importer(api, JSON.stringify(FILE));
    await host.choose();
    expect((await host.forget()).rows).toEqual([]);
    const cancelled = createBriefImport({ api, openDialog: async () => await Promise.resolve({ canceled: true, filePaths: [] }) });
    expect(await cancelled.choose()).toEqual({ previewId: 0, fileName: null, fileError: null, reason: null, rows: [] });
  });

  it('says why a file could not be read as a whole', async () => {
    const { api, calls } = fakeApi();
    expect((await importer(api, '{"not":"an array"}').choose()).fileError).toBe('not_array');
    expect(calls).toEqual([]);
  });
});

describe('the prepared-brief import, under review PB', () => {
  /** An API whose set commands wait until the test releases them, one by one. */
  function heldApi(matchAnswers: (() => Promise<unknown>)[] = []) {
    const sent: string[] = [];
    const releases: (() => void)[] = [];
    let match = 0;
    const api = {
      read: async <T>(_path: string, parse: (value: unknown) => T, body?: unknown): Promise<ApiOutcome<T>> => {
        const scripted = matchAnswers[match];
        match += 1;
        if (scripted !== undefined) return { ok: true as const, value: parse(await scripted()) };
        const rows = (body as { rows: unknown[] }).rows;
        return {
          ok: true as const,
          value: parse({ rows: rows.map((_row, i) => ({ status: 'matched', firmId: i === 0 ? FIRM_A : FIRM_B, firmName: 'Test Co', matchedOn: 'external_id' })) }),
        };
      },
      command: async <T>(_path: string, body: Record<string, unknown>, parse: (value: unknown) => T): Promise<ApiOutcome<T>> => {
        sent.push(String(body['firmId']));
        await new Promise<void>(resolve => releases.push(resolve));
        return { ok: true as const, value: parse({ firmId: body['firmId'], created: true, briefLength: 1, sourceCount: 1, updatedAt: '2026-10-02T15:00:00.000Z' }) };
      },
    };
    return { api: api as unknown as AuthedClient, sent, releases };
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const twoRows = JSON.stringify([row({ external_id: 'dfw-20261002-e01' }), row({ external_id: 'dfw-20261002-w01' })]);

  it('finding 2: a session change while row 1 is in flight sends nothing more', async () => {
    let session = 1;
    const { api, sent, releases } = heldApi();
    const host = createBriefImport({ api, sessionGeneration: () => session, openDialog: async () => await Promise.resolve({ canceled: false, filePaths: ['/x/a.json'] }), read: async () => await Promise.resolve(twoRows) });
    const preview = await host.choose();
    const running = host.commit({ previewId: preview.previewId });
    await settle();
    expect(sent).toEqual([FIRM_A]);
    session = 2;
    releases[0]?.();
    await running;
    expect(sent).toEqual([FIRM_A]);
  });

  it('finding 2: forget() aborts a running commit', async () => {
    const { api, sent, releases } = heldApi();
    const host = createBriefImport({ api, openDialog: async () => await Promise.resolve({ canceled: false, filePaths: ['/x/a.json'] }), read: async () => await Promise.resolve(twoRows) });
    const preview = await host.choose();
    const running = host.commit({ previewId: preview.previewId });
    await settle();
    expect((await host.forget()).rows).toEqual([]);
    releases[0]?.();
    expect((await running).rows).toEqual([]);
    expect(sent).toEqual([FIRM_A]);
  });

  it('finding 3: an older preview answering late writes nothing, and commit sends only the shown preview’s rows', async () => {
    let releaseA: (value: unknown) => void = () => undefined;
    const aAnswer = new Promise<unknown>(resolve => {
      releaseA = resolve;
    });
    const { api, sent, releases } = heldApi([
      async () => await aAnswer,
      async () => await Promise.resolve({ rows: [{ status: 'matched', firmId: FIRM_B, firmName: 'Bravo Test Co', matchedOn: 'external_id' }] }),
    ]);
    let file = twoRows;
    const host = createBriefImport({ api, openDialog: async () => await Promise.resolve({ canceled: false, filePaths: ['/x/f.json'] }), read: async () => await Promise.resolve(file) });
    const pendingA = host.choose();
    await settle();
    file = JSON.stringify([row({ external_id: 'dfw-20261002-w01' })]);
    const b = await host.choose();
    releaseA({
      rows: [
        { status: 'matched', firmId: FIRM_A, firmName: 'Alpha Test Co', matchedOn: 'external_id' },
        { status: 'matched', firmId: FIRM_B, firmName: 'Bravo Test Co', matchedOn: 'external_id' },
      ],
    });
    await pendingA;
    expect((await host.state()).rows).toHaveLength(1);
    expect((await host.state()).previewId).toBe(b.previewId);
    // A commit naming the abandoned preview sends nothing.
    await host.commit({ previewId: b.previewId - 1 });
    expect(sent).toEqual([]);
    const running = host.commit({ previewId: b.previewId });
    await settle();
    releases[0]?.();
    await running;
    expect(sent).toEqual([FIRM_B]);
  });
});

/**
 * The DFW batch file (`~/conductor/scratch/dfw/dfw-batch-1-briefs.json`) holds real prospect
 * data and stays out of this public repository, so it is checked only where it exists:
 * `FSS_PREPARED_BRIEFS_FILE=<path> npx vitest run test/briefImport.test.ts`.
 */
const realFile = process.env['FSS_PREPARED_BRIEFS_FILE'];
describe.skipIf(realFile === undefined || realFile === '')('a prepared-brief file on this Mac', () => {
  it('parses whole, every row valid and named by its external id', () => {
    const parsed = parseBriefFile(readFileSync(realFile ?? '', 'utf8'));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const invalid = parsed.rows.flatMap((entry, index) => (entry.ok ? [] : [`${String(index + 1)}: ${entry.issue}`]));
    expect(invalid).toEqual([]);
    for (const entry of parsed.rows) if (entry.ok) expect(entry.row.external_id).toMatch(/^dfw-20261002-[ew]\d{2}$/u);
    const expected = process.env['FSS_PREPARED_BRIEFS_ROWS'];
    if (expected !== undefined) expect(parsed.rows).toHaveLength(Number(expected));
  });
});
