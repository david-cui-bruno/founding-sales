import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { v1CommandReceiptSchema, v1FirmViewSchema } from '../../../../../src/shared/contracts/v1Contract';
import { createAccountFirmSource } from '../../src/v1/firms';
import { canonicalHandle, canonicalRoutes, isSuppressed, suppressionFirmKey, suppressionHandleKey } from '../../src/v1/suppression';
import { firmKey } from '../../src/v1/firmsWrite';
import { listedRouteId, putFirm, putTerritoryPolicy, readDay, riFirm, setPosture, morningOf } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * The suppression set on the real handler and the in-memory Dynamo harness (FSS target design section 2; slice S2).
 * One firm-level record plus one per known route, in one transaction, under canonical keys. Permanent: nothing in
 * the contract, the router or this module can undo one, and a suppressed firm never reaches another morning list.
 */
const FRIDAY = '2026-09-18T14:00:00.000Z';
const RI_PHONE = '+14015550201';

async function harness(now = FRIDAY) {
  const f = v1Fixture(now);
  await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
  const device = await f.pairDevice();
  await setPosture(f, device.bearer, 'RI', 'calling');
  return { f, device };
}
const command = (f: ReturnType<typeof v1Fixture>, device: { bearer: string }, body: Record<string, unknown>) =>
  f.request('POST', '/v1/commands', { authorization: device.bearer, body: { commandId: randomUUID(), ...body } });

describe('the suppression set', () => {
  it('keys a handle canonically, whatever spelling it arrived in, and refuses one neither normalizer accepts', () => {
    for (const spelling of ['+14015550201', '4015550201', '(401) 555-0201', '401-555-0201', ' 1 401 555 0201 ']) {
      expect(canonicalHandle(spelling)).toEqual({ channel: 'phone', handle: RI_PHONE });
    }
    for (const spelling of ['Office@AccountRi1.Example', ' office@accountri1.example ']) {
      expect(canonicalHandle(spelling)).toEqual({ channel: 'email', handle: 'office@accountri1.example' });
    }
    for (const refused of ['', '   ', 'not a number', '+0123', 'office@', '@accountri1.example', 'office@@x.example', '12345']) {
      expect({ refused, canonical: canonicalHandle(refused) }).toEqual({ refused, canonical: null });
    }
    // The stored key is the canonical handle, percent-encoded exactly like every other sort key.
    expect(suppressionHandleKey(RI_PHONE)).toBe('SUPPRESS#%2B14015550201');
    expect(suppressionHandleKey('office@accountri1.example')).toBe('SUPPRESS#office%40accountri1.example');
    expect(suppressionFirmKey('account-ri-1')).toBe('SUPPRESS#FIRM#account-ri-1');
    // A firm key can never be read as a handle key: `FIRM#` is upper case and an address is always lower-cased.
    expect(suppressionFirmKey('account-ri-1').startsWith('SUPPRESS#FIRM#')).toBe(true);
    expect(canonicalRoutes([{ channel: 'phone', value: '(401) 555-0201' }, { channel: 'email', value: 'Office@AccountRi1.Example' },
      { channel: 'phone', value: '+14015550201' }, { channel: 'linkedin', value: 'in/nobody' }, { channel: 'phone', value: 'nonsense' }]))
      .toEqual([{ channel: 'phone', handle: RI_PHONE }, { channel: 'email', handle: 'office@accountri1.example' }]);
  });

  it('writes the firm and every route in one transaction, keeps the first reason on a repeat, and answers isSuppressed on either side', async () => {
    const { f, device } = await harness();
    await putFirm(f.store, riFirm(1, { businessEmail: 'office@accountri1.example' }));
    const before = f.db.transactions.length;
    const first = v1CommandReceiptSchema.parse(f.json(await command(f, device, { kind: 'suppress', firmId: 'account-ri-1', reason: 'Do-not-call list.', evidenceRef: 'dnc-2026-09' })));
    expect(first).toMatchObject({ outcome: 'applied', reason: null, slice: { kind: 'card', firmId: 'account-ri-1', card: null } });
    // Two transactions: the command's own, which carries the whole set, and the `command` attempt the router records after it.
    expect(f.db.transactions.length).toBe(before + 2);
    const applied = f.db.transactions[before]!;
    expect(applied.TransactItems!.map(item => item.Put?.Item?.sk?.S ?? item.ConditionCheck?.Key?.sk?.S).filter(key => key?.startsWith('MAIL_SUPPRESSION#'))).toHaveLength(1);
    expect(applied.TransactItems!.map(item => item.Put?.Item?.sk?.S ?? item.ConditionCheck?.Key?.sk?.S).filter(key => key?.startsWith('SUPPRESS#')).sort())
      .toEqual(['SUPPRESS#FIRM#account-ri-1', 'SUPPRESS#office%40accountri1.example', 'SUPPRESS#%2B14015550201'].sort());
    expect(f.db.inspect(suppressionFirmKey('account-ri-1'))).toMatchObject({ reason: 'Do-not-call list.', source: 'manual',
      evidenceRef: 'dnc-2026-09', recordedBy: 'David MacBook', at: FRIDAY, handles: [RI_PHONE, 'office@accountri1.example'] });
    expect(await isSuppressed(f.store, 'account-ri-1')).toBe(true);
    expect(await isSuppressed(f.store, null, [{ channel: 'phone', value: '(401) 555-0201' }])).toBe(true);
    expect(await isSuppressed(f.store, 'account-ri-2', [{ channel: 'phone', value: '+14015550299' }])).toBe(false);
    // A second suppression of the same firm is idempotent and never rewrites the first reason or its instant.
    f.advance('2026-09-19T14:00:00.000Z');
    expect(v1CommandReceiptSchema.parse(f.json(await command(f, device, { kind: 'suppress', firmId: 'account-ri-1', reason: 'Said so again.' })))).toMatchObject({ outcome: 'applied' });
    expect(f.db.inspect(suppressionFirmKey('account-ri-1'))).toMatchObject({ reason: 'Do-not-call list.', at: FRIDAY });
  });

  it('suppresses one handle on its own, and refuses a command that names neither a firm nor a handle and one whose handle is not canonical', async () => {
    const { f, device } = await harness();
    expect(v1CommandReceiptSchema.parse(f.json(await command(f, device, { kind: 'suppress', handle: '(401) 555-0250', reason: 'Wrote in to stop.' }))))
      .toMatchObject({ outcome: 'applied', slice: null });
    expect(f.db.inspect(suppressionHandleKey('+14015550250'))).toMatchObject({ handle: '+14015550250', channel: 'phone', firmId: null, source: 'manual' });
    expect(v1CommandReceiptSchema.parse(f.json(await command(f, device, { kind: 'suppress', reason: 'Nothing named.' })))).toMatchObject({ outcome: 'refused', reason: 'no_subject' });
    expect(v1CommandReceiptSchema.parse(f.json(await command(f, device, { kind: 'suppress', handle: 'not a handle', reason: 'Bad handle.' })))).toMatchObject({ outcome: 'refused', reason: 'handle_invalid' });
  });

  it('refuses a route admitted on a suppressed firm, whichever handle it is, so a suppression can never be worked around', async () => {
    const { f, device } = await harness();
    await putFirm(f.store, riFirm(1));
    await command(f, device, { kind: 'suppress', firmId: 'account-ri-1', reason: 'Do-not-call list.' });
    for (const handle of [{ phone: '+14015550250' }, { email: 'office@accountri1.example' }]) {
      expect(v1CommandReceiptSchema.parse(f.json(await command(f, device, { kind: 'admit_route', firmId: 'account-ri-1', ...handle }))))
        .toMatchObject({ outcome: 'refused', reason: 'suppressed' });
    }
    // No `FIRM#` record was created by the refused admissions, so the firm carries no new route anywhere.
    expect(f.db.inspect(firmKey('account-ri-1'))).toBeUndefined();
    const card = (await createAccountFirmSource(f.store).listFirms()).find(firm => firm.firmId === 'account-ri-1')!;
    expect(card.suppressed).toBe('suppression_set');
    expect(card.routes.map(route => route.value)).toEqual([RI_PHONE]);
  });

  it('excludes a suppressed firm from the morning list the tick builds, and the Firm view says suppressed with the reason', async () => {
    const { f, device } = await harness('2026-09-18T09:05:00.000Z');
    await putFirm(f.store, riFirm(1));
    await putFirm(f.store, riFirm(2));
    await command(f, device, { kind: 'suppress', firmId: 'account-ri-1', reason: 'Do-not-call list.' });
    await morningOf(f)();
    const day = readDay(f, '2026-09-18')!;
    expect(day.lanes.new.map(entry => entry.firmId)).toEqual(['account-ri-2']);
    expect(JSON.stringify(day.lanes)).not.toContain('account-ri-1');
    expect(day.excluded).toMatchObject({ suppressed: 1 });
    expect(day.poolSize).toBe(1);
    const view = v1FirmViewSchema.parse(f.json(await f.request('GET', '/v1/firms', { authorization: device.bearer, query: 'firmId=account-ri-1' })));
    expect(view).toMatchObject({ firmId: 'account-ri-1', status: 'suppressed', dialAllowed: false, holdReason: 'suppressed', holdCode: 'suppressed',
      suppression: { reason: 'Do-not-call list.', source: 'manual', evidenceRef: null, recordedBy: 'David MacBook', handles: [RI_PHONE] },
      holds: [{ reason: 'suppressed', code: 'suppressed', count: 1 }] });
    expect(view.routes).toEqual([{ routeId: listedRouteId('account-ri-1', RI_PHONE), channel: 'phone', value: RI_PHONE, verification: 'listed', retired: false, suppressed: true }]);
    // No command, route or view offers an unsuppress: the only way back is a firm the set never named.
    expect((await f.request('GET', '/v1/firms', { authorization: device.bearer, query: 'firmId=account-nobody' })).statusCode).toBe(404);
  });
});
