import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { settingsViewSchema, v1CommandReceiptSchema } from '../../../../../src/shared/contracts/v1Contract';
import { CALL_POLICY_KEY, callPolicyRecordSchema, windowForState } from '../../src/v1/callPolicy';
import { CALL_WINDOW_FLOOR } from '../../src/v1/callWindow';
import { PAUSED_SETTINGS_KEY, PHONE_SETUP_KEY, phoneSetupRecordSchema, pausedRecordSchema } from '../../src/v1/phoneSetup';
import { readSettingsView } from '../../src/v1/settingsView';
import { runSendStepJob, readSend, type SendDependencies } from '../../src/v1/send';
import { sendStepJobId } from '../../src/queue/jobs';
import { GOOGLE_GRANT_PREFIX } from '../../src/v1/mailbox';
import { gmailFetch, mailboxAccess, POSTAL_ADDRESS, sendWorkspace } from './sendFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * Settings on the real handler and the real store adapter (FSS target design section 3; slice S5). Every control
 * the design's mapping table keeps has a section, every command returns the section it changed, and nothing here
 * sends, dials or asks a provider anything: the one send this file runs is the pause fence's proof, and its Gmail
 * calls go through the injected fetch.
 */

const START = '2026-09-18T12:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const send = (f: ReturnType<typeof v1Fixture>, fetch: typeof globalThis.fetch): SendDependencies => ({ store: f.store, mailbox: mailboxAccess(), fetch });

async function command(f: ReturnType<typeof v1Fixture>, bearer: string, body: Record<string, unknown>) {
  const response = await f.request('POST', '/v1/commands', { authorization: bearer, body: { commandId: randomUUID(), ...body } });
  return { status: response.statusCode, receipt: response.statusCode === 200 ? v1CommandReceiptSchema.parse(f.json(response)) : null };
}

describe('GET /v1/settings: every kept control has a section', () => {
  it('serves all ten sections, valid against the contract, behind the device token and never through a provider', async () => {
    const f = v1Fixture(START);
    expect((await f.request('GET', '/v1/settings')).statusCode).toBe(401);
    const device = await f.pairDevice('David MacBook');
    const view = settingsViewSchema.parse(f.json(await f.request('GET', '/v1/settings', { authorization: device.bearer })));

    // States: no posture recorded yet, and the reference texts at the revision a posture is stamped with.
    expect(view.postures).toEqual([]);
    expect(view.referenceTexts.states.map(entry => entry.state)).toEqual(['RI', 'MA', 'TX']);
    // Templates: the five seeds, unapproved, with the footer missing because there is no postal address yet.
    expect(view.templates?.map(template => template.templateId)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    for (const template of view.templates ?? []) {
      expect(template.state).toBe('draft');
      expect(template.approved).toBe(false);
      expect(template.footerPresent).toBe(false);
      expect(template.issues).toEqual(['postal_address_not_set']);
    }
    // Sending: the ceiling fixed in code, no narrowing yet, no address, and day one of the ramp with nothing used.
    expect(view.sending?.ceiling).toEqual({ dailyLimit: 40, startPerDay: 10, stepPerDay: 2, maxPerDay: 40 });
    expect(view.sending?.dailyLimit).toBe(40);
    expect(view.sending?.postalAddress).toBeNull();
    expect(view.sending?.footerBlock).toBeNull();
    expect(view.sending?.capLine).toEqual({ date: '2026-09-18', cap: 10, day: 1, used: 0, remaining: 10 });
    // Research: S4's record is absent, so the section says so rather than showing an empty config.
    expect(view.research?.present).toBe(false);
    expect(view.research?.readOnlyReason).toBe('research_config_absent');
    expect(view.research?.config).toBeNull();
    // Calls: the code floor itself, Monday to Friday, with no narrowing and no revision yet.
    expect(view.calls?.floor).toEqual({ days: [1, 2, 3, 4, 5], window: { startMinute: 480, endMinute: 1200 } });
    expect(view.calls?.window).toEqual({ startMinute: 480, endMinute: 1200 });
    expect(view.calls?.byState).toEqual([]);
    expect(view.calls?.revision).toBe(0);
    // Phone, Google, devices, paused.
    expect(view.phone).toEqual({ status: 'cleared', confirmedAt: null, proofDigest: null, confirmedBy: null, revision: 0, updatedAt: null });
    expect(view.google?.status).toBe('not_connected');
    expect(view.google?.reconsentAtCutover).toBe(true);
    expect(view.devices?.map(entry => entry.label)).toEqual(['David MacBook']);
    expect(view.paused).toEqual({ paused: false, reason: null, at: null, by: null, revision: 0 });
  });

  it('shows the templates approved, the footer present and the cap line once an address and an approval exist', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    await sendWorkspace(f, device.bearer);
    const view = settingsViewSchema.parse(f.json(await f.request('GET', '/v1/settings', { authorization: device.bearer })));
    expect(view.sending?.postalAddress).toBe(POSTAL_ADDRESS);
    expect(view.sending?.footerBlock).toContain(POSTAL_ADDRESS);
    const approved = view.templates?.find(template => template.templateId === 'T4');
    expect(approved?.state).toBe('approved');
    expect(approved?.approved).toBe(true);
    expect(approved?.footerPresent).toBe(true);
    expect(approved?.issues).toEqual([]);
    // Every other template still has the seeded text, which ends at the sign-off and therefore has no footer.
    const untouched = view.templates?.find(template => template.templateId === 'T1');
    expect(untouched?.approved).toBe(false);
    expect(untouched?.footerPresent).toBe(false);
    expect(untouched?.issues).toEqual(['template_footer_missing']);
    // The posture the workspace fixture recorded is in the States section too.
    expect(view.postures.map(posture => ({ state: posture.state, posture: posture.posture }))).toEqual([{ state: 'RI', posture: 'calling' }]);
  });

  it('reads the Google grant from the table alone: connected, revoked, more than one, and never a token refresh', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    const grant = (id: string, value: unknown) => f.store.transact([f.store.put(`${GOOGLE_GRANT_PREFIX}${id}`, value, null)]);
    const read = async () => settingsViewSchema.parse(f.json(await f.request('GET', '/v1/settings', { authorization: device.bearer }))).google;

    await grant('pairing-one', { grant: { email: 'founder@usecallie.invalid', subject: 'founder@usecallie.invalid' } });
    expect(await read()).toMatchObject({ status: 'connected', email: 'founder@usecallie.invalid', grants: 1, reconsentAtCutover: true });
    await grant('pairing-two', { grant: { email: 'second@usecallie.invalid', subject: 'second@usecallie.invalid' } });
    expect(await read()).toMatchObject({ status: 'multiple_grants', email: null, grants: 2 });
    await f.store.transact([f.store.put(`${GOOGLE_GRANT_PREFIX}pairing-one`, { revoked: true, grant: { email: 'founder@usecallie.invalid', subject: 'founder@usecallie.invalid' } }, 1)]);
    expect(await read()).toMatchObject({ status: 'connected', grants: 1 });
    await f.store.transact([f.store.put(`${GOOGLE_GRANT_PREFIX}pairing-two`, { revoked: true, grant: { email: 'second@usecallie.invalid', subject: 'second@usecallie.invalid' } }, 1)]);
    expect(await read()).toMatchObject({ status: 'revoked', email: null, grants: 0 });
  });
});

describe('set_call_policy: hours may only narrow the floor', () => {
  it('records a narrower window and a per-state narrowing, returns the section, and refuses a window outside the floor', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice('David MacBook');

    // 09:00 to 17:00 is inside Monday-to-Friday 08:00 to 20:00, so it is recorded.
    const narrowed = await command(f, device.bearer, { kind: 'set_call_policy', window: { startMinute: 9 * 60, endMinute: 17 * 60 },
      byState: [{ state: 'RI', window: { startMinute: 10 * 60, endMinute: 16 * 60 } }], capPerRun: 20 });
    expect(narrowed.receipt).toMatchObject({ outcome: 'applied', reason: null,
      slice: { kind: 'call_policy', calls: { window: { startMinute: 540, endMinute: 1020 }, capPerRun: 20, revision: 1 } } });
    const stored = callPolicyRecordSchema.parse(f.db.inspect(CALL_POLICY_KEY));
    expect(stored).toMatchObject({ window: { startMinute: 540, endMinute: 1020 }, capPerRun: 20, revision: 1, updatedBy: 'David MacBook' });
    expect(stored.byState).toEqual([{ state: 'RI', window: { startMinute: 600, endMinute: 960 } }]);
    // The narrowing is what the dial evaluation reads for that state; every other state keeps the policy's window.
    expect(windowForState(stored, 'RI')).toEqual({ startMinute: 600, endMinute: 960 });
    expect(windowForState(stored, 'MA')).toEqual({ startMinute: 540, endMinute: 1020 });
    expect(windowForState(null, 'RI')).toEqual(CALL_WINDOW_FLOOR);

    // Every window the floor does not contain is refused whole, and nothing is written.
    const revisionBefore = stored.revision;
    for (const window of [{ startMinute: 7 * 60, endMinute: 17 * 60 }, { startMinute: 9 * 60, endMinute: 21 * 60 }, { startMinute: 0, endMinute: 24 * 60 }]) {
      const refused = await command(f, device.bearer, { kind: 'set_call_policy', window });
      expect(refused.receipt).toEqual({ commandId: refused.receipt!.commandId, outcome: 'refused', reason: 'call_policy_outside_floor' });
    }
    // A per-state window outside the floor refuses the whole command, including the global window beside it.
    const mixed = await command(f, device.bearer, { kind: 'set_call_policy', window: { startMinute: 11 * 60, endMinute: 12 * 60 },
      byState: [{ state: 'MA', window: { startMinute: 6 * 60, endMinute: 19 * 60 } }] });
    expect(mixed.receipt?.reason).toBe('call_policy_outside_floor');
    // An empty window never reaches the floor check: the command contract refuses it as a malformed request, which
    // is a 400 and no receipt at all, rather than a silent fall back to the floor.
    const empty = await f.request('POST', '/v1/commands', { authorization: device.bearer,
      body: { commandId: randomUUID(), kind: 'set_call_policy', window: { startMinute: 17 * 60, endMinute: 9 * 60 } } });
    expect(empty.statusCode).toBe(400);
    expect(f.json(empty)).toEqual({ error: 'invalid_request' });
    expect(callPolicyRecordSchema.parse(f.db.inspect(CALL_POLICY_KEY)).revision).toBe(revisionBefore);

    // A second decision keeps what it does not name and bumps the revision.
    const again = await command(f, device.bearer, { kind: 'set_call_policy', capPerRun: 5 });
    expect(again.receipt).toMatchObject({ outcome: 'applied', slice: { kind: 'call_policy', calls: { window: { startMinute: 540, endMinute: 1020 }, capPerRun: 5, revision: 2 } } });
  });
});

describe('confirm_phone_setup and clear_phone_setup', () => {
  it('records the digest of the proof with who confirmed it, clears it, and never stores the proof itself', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice('David MacBook');
    const proofDigest = sha('fictional-local-proof-fingerprint');

    const confirmed = await command(f, device.bearer, { kind: 'confirm_phone_setup', proofDigest });
    expect(confirmed.receipt).toMatchObject({ outcome: 'applied', reason: null,
      slice: { kind: 'phone_setup', phone: { status: 'confirmed', confirmedAt: START, proofDigest, confirmedBy: 'David MacBook', revision: 1 } } });
    const stored = phoneSetupRecordSchema.parse(f.db.inspect(PHONE_SETUP_KEY));
    expect(stored).toMatchObject({ status: 'confirmed', proofDigest, confirmedBy: 'David MacBook', revision: 1 });
    expect(JSON.stringify(stored)).not.toContain('fictional-local-proof-fingerprint');
    expect(settingsViewSchema.parse(f.json(await f.request('GET', '/v1/settings', { authorization: device.bearer }))).phone)
      .toMatchObject({ status: 'confirmed', proofDigest });

    f.advance('2026-09-19T09:00:00.000Z');
    const cleared = await command(f, device.bearer, { kind: 'clear_phone_setup' });
    expect(cleared.receipt).toMatchObject({ slice: { kind: 'phone_setup', phone: { status: 'cleared', confirmedAt: null, proofDigest: null, confirmedBy: null, revision: 2 } } });
    expect(phoneSetupRecordSchema.parse(f.db.inspect(PHONE_SETUP_KEY))).toMatchObject({ status: 'cleared', proofDigest: null });

    // A digest that is not a sha256 is a malformed request, refused before any write.
    const bad = await f.request('POST', '/v1/commands', { authorization: device.bearer, body: { commandId: randomUUID(), kind: 'confirm_phone_setup', proofDigest: 'not-a-digest' } });
    expect(bad.statusCode).toBe(400);
    expect(phoneSetupRecordSchema.parse(f.db.inspect(PHONE_SETUP_KEY)).status).toBe('cleared');
  });
});

describe('pause and resume', () => {
  it('holds a due send in the fence while paused and releases it on resume, with the reason on the record and the view', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice('David MacBook');
    const firm = await sendWorkspace(f, device.bearer);
    const jobId = sendStepJobId(firm.firmId, firm.stepId);

    const paused = await command(f, device.bearer, { kind: 'pause', reason: 'Phone-only stop rehearsal' });
    expect(paused.receipt).toMatchObject({ outcome: 'applied', reason: null,
      slice: { kind: 'paused', paused: { paused: true, reason: 'Phone-only stop rehearsal', at: START, by: 'David MacBook', revision: 1 } } });
    expect(pausedRecordSchema.parse(f.db.inspect(PAUSED_SETTINGS_KEY))).toMatchObject({ paused: true, reason: 'Phone-only stop rehearsal' });
    expect(settingsViewSchema.parse(f.json(await f.request('GET', '/v1/settings', { authorization: device.bearer }))).paused)
      .toMatchObject({ paused: true, reason: 'Phone-only stop rehearsal' });

    // The send fence holds the due step with `paused` and makes no Gmail call at all.
    const held = gmailFetch({ send: ['accepted'] });
    const first = await runSendStepJob(send(f, held.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(first).toMatchObject({ outcome: 'held', code: 'paused', reason: 'paused' });
    expect(held.calls).toEqual([]);
    expect(await readSend(f.store, firm.firmId, firm.stepId)).toBeNull();

    // Resume clears the reason: a running workspace never shows a stale sentence.
    f.advance('2026-09-18T13:00:00.000Z');
    const resumed = await command(f, device.bearer, { kind: 'resume', reason: 'rehearsal over' });
    expect(resumed.receipt).toMatchObject({ slice: { kind: 'paused', paused: { paused: false, reason: null, at: '2026-09-18T13:00:00.000Z', by: 'David MacBook', revision: 2 } } });
    expect(pausedRecordSchema.parse(f.db.inspect(PAUSED_SETTINGS_KEY))).toMatchObject({ paused: false, reason: null });

    const released = gmailFetch({ send: ['accepted'] });
    const second = await runSendStepJob(send(f, released.fetch), { jobId, firmId: firm.firmId, stepId: firm.stepId }, AbortSignal.timeout(5000));
    expect(second.outcome).toBe('sent');
    expect((await readSend(f.store, firm.firmId, firm.stepId))?.record.state).toBe('accepted');
  });

  it('reads a paused record it cannot parse as paused, so Settings and the send fence never disagree', async () => {
    const f = v1Fixture(START);
    const device = await f.pairDevice();
    await f.store.transact([f.store.put(PAUSED_SETTINGS_KEY, { paused: 'yes please' }, null)]);
    expect((await readSettingsView(f.store)).paused).toEqual({ paused: true, reason: 'paused_record_unreadable', at: null, by: null, revision: 0 });
    expect(settingsViewSchema.parse(f.json(await f.request('GET', '/v1/settings', { authorization: device.bearer }))).paused?.paused).toBe(true);
  });
});
