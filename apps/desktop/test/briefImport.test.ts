import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reasonSentence } from '@fss/contracts';
import type { ApiOutcome } from '../src/main/apiClient.ts';
import type { AuthedClient } from '../src/main/authedClient.ts';
import { createBriefImport, parseBriefFile } from '../src/main/briefImport.ts';
import { guardIdentity } from '../src/main/identityReset.ts';
import { briefImportViewSchema } from '../src/shared/briefImport.ts';

/**
 * Lane PB: the prepared-brief import in the main process — the file read and checked here,
 * the match asked of the server, and (design reset I1) ONE import command for the preview on
 * screen, under the command id minted at that preview, through the identity handshake.
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

/** The match answers every row matched to A then B; the import waits for the test when `hold` is set. */
function fakeApi(options: { readonly hold?: boolean; readonly refuse?: string; readonly answerRows?: (asked: number) => number } = {}) {
  const calls: Call[] = [];
  const releases: (() => void)[] = [];
  const api = {
    read: async <T>(path: string, parse: (value: unknown) => T, body?: unknown): Promise<ApiOutcome<T>> => {
      calls.push({ kind: 'read', path, body });
      const rows = (body as { rows: unknown[] }).rows;
      const answers = [
        { status: 'matched', firmId: FIRM_A, firmName: 'Alpha Test Co', matchedOn: 'external_id' },
        { status: 'matched', firmId: FIRM_B, firmName: 'Bravo Test Co', matchedOn: 'external_id' },
        { status: 'unmatched' },
        { status: 'ambiguous', column: 'firm_name' },
      ];
      const answered = Array.from({ length: options.answerRows?.(rows.length) ?? rows.length }, (_r, i) => answers[i] ?? { status: 'unmatched' });
      return await Promise.resolve({ ok: true as const, value: parse({ rows: answered }) });
    },
    command: async <T>(path: string, body: Record<string, unknown>, parse: (value: unknown) => T, opts?: { commandId?: string }): Promise<ApiOutcome<T>> => {
      calls.push({ kind: 'command', path, body, commandId: opts?.commandId });
      if (options.hold === true) await new Promise<void>(resolve => releases.push(resolve));
      if (options.refuse !== undefined) return { ok: false as const, reason: options.refuse, offline: false };
      const sent = (body['rows'] as unknown[]).length;
      const statuses = ['saved', 'unchanged', 'unmatched', 'ambiguous'];
      const rows = Array.from({ length: sent }, (_v, i) => ({
        index: i + 1,
        status: statuses[i] ?? 'unmatched',
        ...(i < 2 ? { firmId: i === 0 ? FIRM_A : FIRM_B } : {}),
        ...(i === 3 ? { column: 'firm_name' } : {}),
      }));
      return { ok: true as const, value: parse({ rows, counts: { saved: 1, unchanged: 1, unmatched: 1, ambiguous: 1 } }) };
    },
  };
  return { api: api as unknown as AuthedClient, calls, releases };
}

const importer = (api: AuthedClient, text: () => string) =>
  createBriefImport({
    api,
    openDialog: async () => await Promise.resolve({ canceled: false, filePaths: ['/Users/test/dfw-batch-1-briefs.json'] }),
    read: async () => await Promise.resolve(text()),
  });

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

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
    const view = await importer(api, () => JSON.stringify(FILE)).choose();
    expect(briefImportViewSchema.parse(view)).toEqual(view);
    expect(view.fileName).toBe('dfw-batch-1-briefs.json');
    expect(view.rows.map(entry => [entry.index, entry.status, entry.issue])).toEqual([
      [1, 'matched', null],
      [2, 'matched', null],
      [3, 'unmatched', null],
      [4, 'ambiguous', 'firm_name'],
      [5, 'invalid', 'sources'],
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/firms/brief/match');
    expect(JSON.stringify(calls[0]?.body)).not.toContain('call the office');
    expect(JSON.stringify(view)).not.toContain('call the office');
  });

  it('lane PBM: a match answer with a different number of rows is an error for the file, never every row unmatched', async () => {
    for (const answerRows of [() => 0, (asked: number) => asked - 1, (asked: number) => asked + 1]) {
      const { api, calls } = fakeApi({ answerRows });
      const host = importer(api, () => JSON.stringify(FILE));
      const view = await host.choose();
      expect(briefImportViewSchema.parse(view)).toEqual(view);
      expect(view.reason).toBe('match_answer_mismatch');
      // The screen says it in words of its own, not the generic sentence that names the code.
      expect(reasonSentence(view.reason ?? '')).not.toContain('(match_answer_mismatch)');
      expect(view.rows).toEqual([]);
      // Nothing to import from a preview that could not be matched.
      await host.commit({ previewId: view.previewId });
      expect(calls.filter(call => call.kind === 'command')).toEqual([]);
    }
  });

  it('commits ONE import command with the valid rows of the preview on screen, and shows the server’s outcome per row', async () => {
    const { api, calls } = fakeApi();
    const host = importer(api, () => JSON.stringify(FILE));
    const preview = await host.choose();
    const committed = await host.commit({ previewId: preview.previewId });
    const commands = calls.filter(call => call.kind === 'command');
    expect(commands.map(call => call.path)).toEqual(['/firms/brief/import']);
    expect((commands[0]?.body as { rows: { external_id?: string }[] }).rows.map(entry => entry.external_id)).toEqual([
      'dfw-20261002-e01',
      'dfw-20261002-w01',
      'dfw-20261002-x99',
      undefined,
    ]);
    expect(committed.rows.map(entry => entry.result)).toEqual(['saved', 'unchanged', 'unmatched', 'ambiguous', null]);
    expect(committed.committed).toBe(true);
    // Nothing more is sent once it answered.
    await host.commit({ previewId: preview.previewId });
    expect(calls.filter(call => call.kind === 'command')).toHaveLength(1);
  });

  it('replays the same command id when a refused or lost import is pressed again', async () => {
    const { api, calls } = fakeApi({ refuse: 'offline' });
    const host = importer(api, () => JSON.stringify(FILE));
    const preview = await host.choose();
    expect((await host.commit({ previewId: preview.previewId })).reason).toBe('offline');
    await host.commit({ previewId: preview.previewId });
    const ids = calls.filter(call => call.kind === 'command').map(call => call.commandId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('refuses a file of more than 100 briefs, and a commit naming another preview sends nothing', async () => {
    const { api, calls } = fakeApi();
    const many = Array.from({ length: 101 }, (_v, i) => row({ external_id: `row-${String(i)}` }));
    const host = importer(api, () => JSON.stringify(many));
    const view = await host.choose();
    expect(view.fileError).toBe('too_many_rows');
    await host.commit({ previewId: view.previewId });
    await host.commit({ previewId: 999 });
    expect(calls).toEqual([]);
  });

  it('forgets the file and its preview, and a cancelled panel changes nothing', async () => {
    const { api } = fakeApi();
    const host = importer(api, () => JSON.stringify(FILE));
    await host.choose();
    expect((await host.forget()).rows).toEqual([]);
    const cancelled = createBriefImport({ api, openDialog: async () => await Promise.resolve({ canceled: true, filePaths: [] }) });
    expect(await cancelled.choose()).toEqual({ previewId: 0, fileName: null, fileError: null, reason: null, committing: false, committed: false, rows: [] });
  });

  it('says why a file could not be read as a whole', async () => {
    const { api, calls } = fakeApi();
    expect((await importer(api, () => '{"not":"an array"}').choose()).fileError).toBe('not_array');
    expect(calls).toEqual([]);
  });
});

describe('the prepared-brief import, design reset I1', () => {
  const fileOf = (...ids: string[]) => JSON.stringify(ids.map(id => row({ external_id: id })));

  it('an old session’s answer arriving during the new session’s import leaves the new import alone', async () => {
    let session = 1;
    const { api, calls, releases } = fakeApi({ hold: true });
    let file = fileOf('a-1');
    const host = guardIdentity(importer(api, () => file), () => session);
    const old = await host.choose();
    const oldCommit = host.commit({ previewId: old.previewId });
    await settle();
    // Sign-out and sign-in: every bridge is forgotten, as `resetBridges` does.
    session = 2;
    await host.forget();
    file = fileOf('b-1', 'c-1');
    const fresh = await host.choose();
    const freshCommit = host.commit({ previewId: fresh.previewId });
    await settle();
    expect(calls.filter(call => call.kind === 'command')).toHaveLength(2);
    // The old answer lands while the new one is on the wire.
    releases[0]?.();
    await oldCommit;
    const during = await host.state();
    expect(during.previewId).toBe(fresh.previewId);
    expect(during.committing).toBe(true);
    expect(during.rows.map(entry => entry.label)).toEqual(['b-1', 'c-1']);
    releases[1]?.();
    const done = await freshCommit;
    expect(done.committed).toBe(true);
    expect(done.rows.map(entry => [entry.label, entry.result])).toEqual([
      ['b-1', 'saved'],
      ['c-1', 'unchanged'],
    ]);
  });

  it('PBR finding 4: an old session’s file read finishing after sign-in never replaces the new preview', async () => {
    let session = 1;
    const { api } = fakeApi();
    let releaseOld: (text: string) => void = () => undefined;
    let reads = 0;
    const host = guardIdentity(
      createBriefImport({
        api,
        openDialog: async () => await Promise.resolve({ canceled: false, filePaths: ['/x/f.json'] }),
        read: async () => {
          reads += 1;
          if (reads === 1) return await new Promise<string>(resolve => (releaseOld = resolve));
          return await Promise.resolve(fileOf('new-1'));
        },
      }),
      () => session,
    );
    const oldChoose = host.choose();
    await settle();
    session = 2;
    await host.forget();
    const fresh = await host.choose();
    expect(fresh.rows.map(entry => entry.label)).toEqual(['new-1']);
    releaseOld(fileOf('old-1', 'old-2'));
    await oldChoose;
    const after = await host.state();
    expect(after.previewId).toBe(fresh.previewId);
    expect(after.rows.map(entry => entry.label)).toEqual(['new-1']);
  });

  it('refuses to preview again or reset while the import is on the wire', async () => {
    const { api, calls, releases } = fakeApi({ hold: true });
    let opened = 0;
    const host = createBriefImport({
      api,
      openDialog: async () => {
        opened += 1;
        return await Promise.resolve({ canceled: false, filePaths: ['/x/f.json'] });
      },
      read: async () => await Promise.resolve(fileOf('a-1', 'a-2', 'a-3')),
    });
    const preview = await host.choose();
    const running = host.commit({ previewId: preview.previewId });
    await settle();
    const again = await host.choose();
    expect(opened).toBe(1);
    expect(again.previewId).toBe(preview.previewId);
    expect(again.committing).toBe(true);
    expect((await host.reset()).committing).toBe(true);
    releases[0]?.();
    const done = await running;
    expect(done.rows.map(entry => entry.result)).toEqual(['saved', 'unchanged', 'unmatched']);
    expect(calls.filter(call => call.kind === 'command')).toHaveLength(1);
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
