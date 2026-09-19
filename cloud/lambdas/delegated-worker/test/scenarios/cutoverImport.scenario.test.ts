import { describe, expect, it } from 'vitest';
import { REPLY_TEMPLATE_SEEDS } from '../../../../../src/main/outreach/templates/replyTemplateSeeds';
import { CUTOVER_EXPORT_KIND, CUTOVER_EXPORT_VERSION, type CutoverExport } from '../../../../../src/shared/contracts/cutoverExportContract';
import { listAttempts } from '../../src/v1/attempts';
import { callbackKey, callbackRecordSchema } from '../../src/v1/calls';
import { runCutoverCopy } from '../../src/v1/cutover';
import { CUTOVER_IMPORT_ROWS, planCutoverImport, runCutoverImport } from '../../src/v1/cutoverImport';
import { PHONE_SETUP_KEY, phoneSetupRecordSchema } from '../../src/v1/phoneSetup';
import { suppressionFirmKey, suppressionFirmRecordSchema, suppressionHandleKey } from '../../src/v1/suppression';
import { templateKey, templateRecordSchema } from '../../src/v1/templates';
import { listedRouteId, putFirm, putTerritoryPolicy, riFirm } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * The import of the Mac export (slice S6). The file is validated whole before anything is read out of it; the
 * callbacks and the never-call marks land under the new keys; an edited template body lands unapproved so David
 * re-approves it with the footer check in front of him.
 */

const START = '2026-09-19T12:00:00.000Z';
const seedOf = (id: string) => REPLY_TEMPLATE_SEEDS.find(entry => entry.id === id)!;

function exportFile(overrides: Partial<CutoverExport> = {}): CutoverExport {
  const callbacks = overrides.callbacks ?? [{ firmId: 'account-ri-1', dueOn: '2026-09-22', note: 'ring the office manager',
    state: 'open' as const, sourceCommandId: 'command-0001', promisedAt: '2026-09-18T15:00:00.000Z' }];
  const neverCall = overrides.neverCall ?? [{ firmId: 'account-ri-2', observedAt: '2026-09-17T11:00:00.000Z',
    source: 'human_never_call', evidenceRef: 'call-0002' }];
  const templates = overrides.templates ?? [{ templateId: 'T1' as const, subject: seedOf('T1').subject,
    body: `${seedOf('T1').body}\n\nPS: we are local to Providence.`, revision: 3, editedAt: '2026-09-16T09:00:00.000Z' }];
  return {
    kind: CUTOVER_EXPORT_KIND, version: CUTOVER_EXPORT_VERSION, exportedAt: '2026-09-19T11:00:00.000Z', schemaVersion: 30,
    callbacks, neverCall, templates,
    phone: overrides.phone ?? { status: 'confirmed', confirmedAt: '2026-09-10T08:00:00.000Z', proofDigest: 'a'.repeat(64) },
    counts: { callbacks: callbacks.length, neverCall: neverCall.length, templates: templates.length },
  };
}

async function workspace(f: ReturnType<typeof v1Fixture>) {
  await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
  for (const n of [1, 2]) await putFirm(f.store, riFirm(n));
  return { ri2Phone: riFirm(2).phone!, ri2Route: listedRouteId(`account-ri-2`, riFirm(2).phone!) };
}

describe('the cutover import', () => {
  it('refuses a file with an unknown key, and reads nothing out of it', async () => {
    const f = v1Fixture(START);
    await workspace(f);
    const unknown = { ...exportFile(), surprise: 'extra' };
    const plan = await planCutoverImport(f.store, JSON.stringify(unknown));
    expect(plan).toEqual({ outcome: 'refused', reason: 'file_not_an_export' });
    const executed = await runCutoverImport(f.store, JSON.stringify(unknown), { execute: true });
    expect(executed).toEqual({ outcome: 'refused', reason: 'file_not_an_export' });
    expect(f.db.inspect(PHONE_SETUP_KEY)).toBeUndefined();

    // A count that does not match the list it describes is the same refusal: a truncated file is not a complete one.
    const miscounted = { ...exportFile(), counts: { callbacks: 9, neverCall: 1, templates: 1 } };
    expect(await planCutoverImport(f.store, JSON.stringify(miscounted))).toEqual({ outcome: 'refused', reason: 'file_not_an_export' });
    expect(await planCutoverImport(f.store, 'not json at all')).toEqual({ outcome: 'refused', reason: 'file_not_json' });
  });

  it('writes nothing on a dry run and counts every row', async () => {
    const f = v1Fixture(START);
    await workspace(f);
    const before = f.db.transactions.length;
    const report = await runCutoverImport(f.store, JSON.stringify(exportFile()), { execute: false });
    expect(report.outcome).toBe('ok');
    if (report.outcome !== 'ok') return;
    expect(report.executed).toBe(false);
    expect(f.db.transactions.length).toBe(before);
    expect(report.rows.map(row => row.target)).toEqual([...CUTOVER_IMPORT_ROWS]);
    expect(report.rows.every(row => row.refused === 0)).toBe(true);
    expect(report.rows.map(row => row.wouldWrite)).toEqual([1, 1, 1, 1]);
    expect(report.exportedAt).toBe('2026-09-19T11:00:00.000Z');
  });

  it('lands the callbacks, the never-call marks, the edited body and the phone status', async () => {
    const f = v1Fixture(START);
    const { ri2Phone } = await workspace(f);
    const report = await runCutoverImport(f.store, JSON.stringify(exportFile()), { execute: true });
    expect(report.outcome).toBe('ok');

    const callback = callbackRecordSchema.parse(f.db.inspect(callbackKey('2026-09-22', 'account-ri-1')));
    expect(callback).toMatchObject({ firmId: 'account-ri-1', dueOn: '2026-09-22', state: 'pending', resolvedAt: null });
    expect(callback.promisedBy).toBe('cutover-export:command-0001');

    // The never-call mark is the suppression set, with the source and the evidence reference the design names.
    const suppression = suppressionFirmRecordSchema.parse(f.db.inspect(suppressionFirmKey('account-ri-2')));
    expect(suppression).toMatchObject({ source: 'manual', evidenceRef: 'cutover-export', recordedBy: 'cutover' });
    expect(f.db.inspect(suppressionHandleKey(ri2Phone))).toBeDefined();

    // The edited body is stored, and it is not approved: importing is never approving.
    const template = templateRecordSchema.parse(f.db.inspect(templateKey('T1')));
    expect(template.body.endsWith('PS: we are local to Providence.')).toBe(true);
    expect(template.approval).toEqual({ state: 'draft', approvedRevision: null, approvedAt: null, contentHash: null, footerPostalAddress: null });

    const phone = phoneSetupRecordSchema.parse(f.db.inspect(PHONE_SETUP_KEY));
    expect(phone).toMatchObject({ status: 'confirmed', confirmedAt: '2026-09-10T08:00:00.000Z', proofDigest: 'a'.repeat(64), confirmedBy: 'cutover' });

    // One `operator` attempt per row, and a second run writes nothing at all.
    expect((await listAttempts(f.store, { kind: 'operator', limit: 20 })).length).toBe(CUTOVER_IMPORT_ROWS.length);
    const second = await runCutoverImport(f.store, JSON.stringify(exportFile()), { execute: true });
    expect(second.outcome).toBe('ok');
    if (second.outcome !== 'ok') return;
    expect(second.rows.every(row => row.wouldWrite === 0 && row.refused === 0)).toBe(true);
    expect(second.rows.every(row => row.alreadyPresent > 0)).toBe(true);
    expect(templateRecordSchema.parse(f.db.inspect(templateKey('T1'))).revision).toBe(template.revision);
  });

  it('takes an edited body back to unapproved even after the copy wrote the approved seed', async () => {
    const f = v1Fixture(START);
    await workspace(f);
    await runCutoverCopy(f.store, { execute: true });
    const seeded = templateRecordSchema.parse(f.db.inspect(templateKey('T1')));
    expect(seeded.body).toBe(seedOf('T1').body);

    const report = await runCutoverImport(f.store, JSON.stringify(exportFile()), { execute: true });
    expect(report.outcome).toBe('ok');
    const template = templateRecordSchema.parse(f.db.inspect(templateKey('T1')));
    expect(template.revision).toBe(seeded.revision + 1);
    expect(template.approval.state).toBe('draft');
    expect(template.body).not.toBe(seedOf('T1').body);
  });
});
