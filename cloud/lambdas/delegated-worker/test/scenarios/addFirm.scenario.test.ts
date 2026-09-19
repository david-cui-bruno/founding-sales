import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { v1CommandReceiptSchema, v1FirmViewSchema, todayViewSchema } from '../../../../../src/shared/contracts/v1Contract';
import { createAccountFirmSource } from '../../src/v1/firms';
import { firmKey, firmRecordSchema, handEnteredFirmId, handEnteredRouteId, siteDomain, zoneOfState } from '../../src/v1/firmsWrite';
import { putFirm, putTerritoryPolicy, readDay, riFirm, setPosture, tickOf } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * `add_firm` and `admit_route` on the real handler and the in-memory Dynamo harness (FSS target design section 3;
 * slice S2). A firm David types in enters the pool like a researched one: the state he named, the zone derived from
 * it, status `new`, no evidence, and nothing enqueued — research is S4. Every number here is fictional and outside
 * the reserved 555-0100 to 555-0199 block the production launcher refuses.
 */
const FRIDAY = '2026-09-18T14:00:00.000Z';

async function harness(now = FRIDAY) {
  const f = v1Fixture(now);
  await putTerritoryPolicy(f.store, '2026-09-01T12:00:00.000Z');
  const device = await f.pairDevice();
  await setPosture(f, device.bearer, 'RI', 'calling');
  return { f, device };
}
const command = (f: ReturnType<typeof v1Fixture>, device: { bearer: string }, body: Record<string, unknown>) =>
  f.request('POST', '/v1/commands', { authorization: device.bearer, body: { commandId: randomUUID(), ...body } });
const receiptOf = async (f: ReturnType<typeof v1Fixture>, device: { bearer: string }, body: Record<string, unknown>) =>
  v1CommandReceiptSchema.parse(f.json(await command(f, device, body)));

const HAND_FIRM = { kind: 'add_firm', name: 'Hope Street Management', city: 'Providence', state: 'RI', phone: '(401) 555-0230', site: 'https://www.hopestreet.example/about' } as const;
const HAND_ID = handEnteredFirmId({ name: 'Hope Street Management', city: 'Providence', state: 'RI' });

describe('add_firm and admit_route', () => {
  it('creates the firm with the zone derived from the state, status new, no evidence, the site as a bare domain and the number canonical', async () => {
    const { f, device } = await harness();
    expect(await receiptOf(f, device, HAND_FIRM)).toMatchObject({ outcome: 'applied', reason: null, slice: { kind: 'card', firmId: HAND_ID, card: null } });
    const record = firmRecordSchema.parse(f.db.inspect(firmKey(HAND_ID)));
    expect(record).toMatchObject({ version: 1, firmId: HAND_ID, name: 'Hope Street Management', domain: 'hopestreet.example',
      city: 'Providence', state: 'RI', timeZone: 'America/New_York', derivedZoneFrom: 'territory_state_map', status: 'new',
      enteredBy: 'hand', evidenceSummary: '', enteredAt: FRIDAY, updatedAt: FRIDAY });
    expect(record.routes).toEqual([{ id: handEnteredRouteId(HAND_ID, '+14015550230'), channel: 'phone', value: '+14015550230',
      purpose: 'business', verification: 'confirmed', version: 1, enteredAt: FRIDAY }]);
    // No evidence record, no account record and no research job: adding a firm enqueues nothing (research is S4).
    const keys = f.db.dump().map(item => item.sk!.S!);
    expect(keys.filter(key => key.startsWith('EVIDENCE#') || key.startsWith('ACCOUNT#') || key.startsWith('RESEARCH'))).toEqual([]);
    expect(zoneOfState('RI')).toEqual({ timeZone: 'America/New_York', from: 'territory_state_map' });
    expect(siteDomain('www.hopestreet.example')).toBe('hopestreet.example');
    // The same firm entered twice is refused, not duplicated: the id is derived from the name, the city and the state.
    expect(await receiptOf(f, device, HAND_FIRM)).toMatchObject({ outcome: 'refused', reason: 'firm_exists' });
    expect(f.db.dump().map(item => item.sk!.S!).filter(key => key.startsWith('FIRM#'))).toHaveLength(1);
  });

  it('refuses a free-mail address, a number the launcher would never dial, a state with no recorded zone and a firm with neither handle', async () => {
    const { f, device } = await harness();
    for (const [email, reason] of [['david@gmail.com', 'email_free_mail'], ['office@yahoo.com', 'email_free_mail'],
      ['someone@icloud.com', 'email_free_mail'], ['not-an-address', 'email_invalid']] as const) {
      expect(await receiptOf(f, device, { kind: 'add_firm', name: `Firm ${email}`, city: 'Providence', state: 'RI', email })).toMatchObject({ outcome: 'refused', reason });
    }
    // The reserved fictional block, a service code, a short code and a plant-test exchange are all refused.
    for (const [phone, reason] of [['+14015550150', 'phone_excluded'], ['911', 'phone_invalid'], ['+1401958 0201', 'phone_excluded'],
      ['+14015550201x', 'phone_invalid'], ['12345', 'phone_invalid']] as const) {
      expect(await receiptOf(f, device, { kind: 'add_firm', name: `Firm ${phone}`, city: 'Providence', state: 'RI', phone })).toMatchObject({ outcome: 'refused', reason });
    }
    // Illinois observes one zone but the contract records none for it: a firm that cannot be placed on a clock is refused here.
    expect(await receiptOf(f, device, { kind: 'add_firm', name: 'Windy City Rentals', city: 'Chicago', state: 'IL', phone: '+13125550270' }))
      .toMatchObject({ outcome: 'refused', reason: 'zone_unknown' });
    expect(await receiptOf(f, device, { kind: 'add_firm', name: 'No Handle Holdings', city: 'Providence', state: 'RI' })).toMatchObject({ outcome: 'refused', reason: 'no_route' });
    expect(f.db.dump().map(item => item.sk!.S!).filter(key => key.startsWith('FIRM#'))).toEqual([]);
  });

  it('puts the firm in the pool, on the next morning list, with a card the Today view serves and a Firm view of its own', async () => {
    const { f, device } = await harness('2026-09-18T09:05:00.000Z');
    await receiptOf(f, device, HAND_FIRM);
    const card = (await createAccountFirmSource(f.store).listFirms()).find(firm => firm.firmId === HAND_ID)!;
    expect(card).toMatchObject({ firmId: HAND_ID, name: 'Hope Street Management', city: 'Providence', state: 'RI', timeZone: 'America/New_York',
      enteredBy: 'hand', sourceCount: 0, hold: null, suppressed: null, calls: 0, lastCall: null, enrollment: null,
      derivation: { source: 'hand_entered', sourceId: null, state: 'RI', zoneFrom: 'territory_state_map' },
      phone: { number: '+14015550230', verification: 'confirmed' } });
    // The build offers it like a researched firm: one pool entry, no exclusion.
    await tickOf(f)();
    const day = readDay(f, '2026-09-18')!;
    expect(day.lanes.new.map(entry => entry.firmId)).toEqual([HAND_ID]);
    expect(day.poolSize).toBe(1);
    expect(day.excluded).toEqual({});
    f.advance('2026-09-18T14:00:00.000Z');
    const view = todayViewSchema.parse(f.json(await f.request('GET', '/v1/today', { authorization: device.bearer })));
    if (view.list === null) throw new Error(`no list: ${view.reason}`);
    expect(view.list.lanes.new).toHaveLength(1);
    expect(view.list.lanes.new[0]).toMatchObject({ firmId: HAND_ID, lane: 'new', reason: 'new_firm', name: 'Hope Street Management',
      phone: { number: '+14015550230', verification: 'confirmed' }, website: 'hopestreet.example', city: 'Providence', state: 'RI',
      localTime: '10:00', openNow: true, dialAllowed: true, holdReason: null, lastOutcome: null, pendingCallback: null, nextStep: { kind: 'first_call' } });
    const firm = v1FirmViewSchema.parse(f.json(await f.request('GET', '/v1/firms', { authorization: device.bearer, query: `firmId=${HAND_ID}` })));
    expect(firm).toMatchObject({ firmId: HAND_ID, status: 'new', dialAllowed: true, sequence: null, calls: [], callbacks: [], suppression: null,
      evidence: { sources: 0, researchedAt: null, enteredBy: 'hand' }, holds: [] });
    expect(firm.routes).toEqual([{ routeId: handEnteredRouteId(HAND_ID, '+14015550230'), channel: 'phone', value: '+14015550230',
      verification: 'confirmed', retired: false, suppressed: false }]);
  });

  it('admits one route by hand on a researched firm without touching its account record, and refuses an unknown firm, a repeat and a free-mail address', async () => {
    const { f, device } = await harness();
    await putFirm(f.store, riFirm(1));
    expect(await receiptOf(f, device, { kind: 'admit_route', firmId: 'account-nobody', phone: '+14015550240' })).toMatchObject({ outcome: 'refused', reason: 'firm_unknown' });
    expect(await receiptOf(f, device, { kind: 'admit_route', firmId: 'account-ri-1', email: 'david@gmail.com' })).toMatchObject({ outcome: 'refused', reason: 'email_free_mail' });
    expect(await receiptOf(f, device, { kind: 'admit_route', firmId: 'account-ri-1', phone: '+14015550140' })).toMatchObject({ outcome: 'refused', reason: 'phone_excluded' });
    expect(await receiptOf(f, device, { kind: 'admit_route', firmId: 'account-ri-1', email: 'office@accountri1.example' })).toMatchObject({ outcome: 'applied', reason: null });
    const record = firmRecordSchema.parse(f.db.inspect(firmKey('account-ri-1')));
    expect(record).toMatchObject({ firmId: 'account-ri-1', enteredBy: 'research', status: 'listed', state: 'RI', timeZone: 'America/New_York' });
    expect(record.routes.map(route => route.value)).toEqual(['office@accountri1.example']);
    // The researched account record is untouched: a hand-admitted route never claims a fetched source.
    expect(JSON.stringify(f.db.inspect('ACCOUNT#account-ri-1'))).not.toContain('office@accountri1.example');
    // The card joins both: the researched phone and the hand-admitted address.
    const card = (await createAccountFirmSource(f.store).listFirms()).find(firm => firm.firmId === 'account-ri-1')!;
    expect(card.routes.map(route => route.value).sort()).toEqual(['+14015550201', 'office@accountri1.example']);
    expect(card.phone).toMatchObject({ number: '+14015550201', verification: 'listed' });
    // The same address twice is refused rather than written again, whatever spelling it arrives in.
    expect(await receiptOf(f, device, { kind: 'admit_route', firmId: 'account-ri-1', email: 'Office@AccountRi1.Example' })).toMatchObject({ outcome: 'refused', reason: 'route_exists' });
    expect(await receiptOf(f, device, { kind: 'admit_route', firmId: 'account-ri-1', phone: '(401) 555-0201' })).toMatchObject({ outcome: 'refused', reason: 'route_exists' });
    expect(firmRecordSchema.parse(f.db.inspect(firmKey('account-ri-1'))).routes).toHaveLength(1);
  });

  it('gives a hand-entered firm a second phone a wrong number can move to, since it publishes none', async () => {
    const { f, device } = await harness();
    await receiptOf(f, device, HAND_FIRM);
    expect(await receiptOf(f, device, { kind: 'admit_route', firmId: HAND_ID, phone: '+14015550231' })).toMatchObject({ outcome: 'applied' });
    const first = handEnteredRouteId(HAND_ID, '+14015550230');
    const wrong = await receiptOf(f, device, { kind: 'log_call_outcome', firmId: HAND_ID, outcome: 'wrong_number', observedAt: FRIDAY });
    expect(wrong).toMatchObject({ outcome: 'applied' });
    expect(f.db.inspect(`TERRITORY_RETIRED_ROUTE#${HAND_ID}#${first}`)).toMatchObject({ routeId: first, reason: 'wrong_number' });
    const view = v1FirmViewSchema.parse(f.json(await f.request('GET', '/v1/firms', { authorization: device.bearer, query: `firmId=${HAND_ID}` })));
    expect(view.routes.map(route => ({ value: route.value, retired: route.retired }))).toEqual(
      [{ value: '+14015550230', retired: true }, { value: '+14015550231', retired: false }].sort((a, b) =>
        handEnteredRouteId(HAND_ID, a.value) < handEnteredRouteId(HAND_ID, b.value) ? -1 : 1));
    expect(view.sequence).toMatchObject({ source: 'sequence', state: 'active', lastAdvance: 'wrong_number_restarted' });
  });
});
