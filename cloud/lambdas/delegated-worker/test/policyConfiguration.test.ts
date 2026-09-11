import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WorkerPolicyConfiguration } from '../src/policyConfiguration';
import { WorkerAuth, pairingKey, type WorkerScope } from '../src/workerAuth';
import { RemoteGoogleAuthorization } from '../src/remoteGoogleAuthorization';
import { googleScopes } from '../src/googleGrantCapabilities';
import { DynamoStore, keyPart } from '../src/dynamoStore';
import { dispatchCapPolicyKey } from '../src/dispatchRepository';
import { ConditionalCommandHarness } from './sdkHarness';
import type { SchedulingRules } from '../../../../src/shared/contracts/meetingContract';

async function fixture(scopes: WorkerScope[] = ['commands:write', 'google:grant']) {
  const dynamo = new ConditionalCommandHarness(); const options = { dynamo, workspaceId: 'policy-fiction', tableName: 'policy-fiction', clock: { now: () => '2026-09-15T12:00:00.000Z' } };
  const auth = new WorkerAuth(options); const store = new DynamoStore(options); let http = 0;
  const authorization = new RemoteGoogleAuthorization({ auth, config: { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 9) }, fetch: async url => {
    http++;
    if (String(url).endsWith('/token')) return Response.json({ access_token: 'fictional-token', refresh_token: 'fictional-refresh', token_type: 'Bearer', expires_in: 3600, scope: `openid email ${Object.values(googleScopes).join(' ')}` });
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'subject-fiction', email: 'founder@example.test', email_verified: true });
    throw Error('unconfigured_provider_boundary');
  } });
  const pair = await auth.redeemPairing((await auth.issuePairing({ scopes, expiresInSeconds: 300 })).code, 'fictional-source');
  const started = await authorization.beginGoogleGrant(pair.pairingId, ['send', 'relevant_read', 'availability', 'event_write'], { confirmed: true, ownedCalendarId: 'founder@example.test', conflictCalendarIds: ['founder@example.test', 'other@example.test'] });
  await authorization.completeGoogleGrant(new URL(started.authorizationUrl).searchParams.get('state')!, 'fictional-code');
  const common = { version: 1 as const, requestId: randomUUID(), workspaceId: options.workspaceId, pairingId: pair.pairingId, mailboxSubject: 'subject-fiction', expectedRevision: null as number | null };
  const caps = { ...common, kind: 'sender-caps' as const, policy: { sender: 'founder@example.test', dailyLimit: 8 } };
  const rules: SchedulingRules = { revision: 1, confirmed: true, timezone: 'America/New_York', weeklyWindows: [{ weekday: 2, start: '09:00', end: '17:00' }], durationMinutes: 30, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, minimumNoticeMinutes: 60, horizonDays: 30, ownedCalendarId: 'founder@example.test', conflictCalendarIds: ['founder@example.test', 'other@example.test'], location: { kind: 'text', value: 'Fictional office' }, allowCancel: true, allowReschedule: true };
  return { auth, store, pair, authorization, dynamo, options, caps, rules, bearer: `Bearer ${pair.credential}`, http: () => http, service: new WorkerPolicyConfiguration({ auth, authorization }), grantKey: `GOOGLE_GRANT#${keyPart(pair.pairingId)}` };
}

describe('authenticated policy configuration', () => {
  it('configures actual sender caps atomically with a replay receipt and no execution authority or provider call', async () => {
    const f = await fixture(); const http = f.http(); const before = f.dynamo.transactions.length;
    const result = await f.service.apply(f.caps, f.bearer);
    expect(result).toMatchObject({ requestId: f.caps.requestId, kind: 'sender-caps', status: 'applied', revision: 1 });
    expect(f.dynamo.inspect(dispatchCapPolicyKey(f.caps.policy.sender))).toEqual(f.caps.policy);
    expect(f.dynamo.transactions.length - before).toBe(1);
    const tx = f.dynamo.transactions.at(-1)!;
    const keys = tx.TransactItems!.map(i => (i.Put?.Item ?? i.ConditionCheck?.Key)?.sk?.S);
    expect(keys).toContain(f.grantKey); expect(keys).toContain(pairingKey(f.pair.pairingId));
    expect(keys.some(key => key?.startsWith('POLICY_CONFIGURATION_REQUEST#'))).toBe(true);
    expect(keys.some(key => /^(AUTH|ACCOUNT|ACTION|DISPATCH_CAP)#/.test(key ?? ''))).toBe(false);
    expect(await f.service.apply(f.caps, f.bearer)).toEqual(result);
    expect(f.dynamo.transactions.length - before).toBe(1); expect(f.http()).toBe(http);
  });
  it('calls the actual scheduling rules setter with exact grant selection and revision CAS', async () => {
    const f = await fixture(); const request = { ...f.caps, kind: 'meeting-rules', rules: f.rules, policy: undefined as { sender: string; dailyLimit: number } | undefined }; delete request.policy;
    const result = await f.service.apply(request, f.bearer); expect(result.revision).toBe(1);
    expect(f.dynamo.inspect(`MEETING_RULES#${keyPart(f.rules.ownedCalendarId)}`)).toEqual(f.rules);
    await expect(f.service.apply({ ...request, requestId: randomUUID() }, f.bearer)).rejects.toThrow();
    const next = { ...request, requestId: randomUUID(), expectedRevision: 1, rules: { ...f.rules, revision: 2, minimumNoticeMinutes: 120 } };
    expect((await f.service.apply(next, f.bearer)).revision).toBe(2);
    expect(await f.service.apply(request, f.bearer)).toEqual(result);
  });
  it.each(['timezone', 'window', 'duplicate-calendar', 'duplicate-window'])('holds invalid %s rules before any write', async defect => {
    const f = await fixture(); const base = { ...f.caps, policy: undefined as { sender: string; dailyLimit: number } | undefined }; delete base.policy;
    const rules = structuredClone(f.rules);
    if (defect === 'timezone') rules.timezone = 'Not/A_Timezone';
    if (defect === 'window') rules.weeklyWindows[0]!.end = '08:00';
    if (defect === 'duplicate-calendar') {
      rules.conflictCalendarIds.push('other@example.test');
      const row = await f.store.get<{ grant: Record<string, unknown> }>(f.grantKey);
      await f.store.transact([f.store.put(f.grantKey, { ...row!.data, grant: { ...row!.data.grant, calendars: { confirmed: true, ownedCalendarId: rules.ownedCalendarId, conflictCalendarIds: rules.conflictCalendarIds } } }, row!.rev)]);
    }
    if (defect === 'duplicate-window') rules.weeklyWindows.push({ ...rules.weeklyWindows[0]! });
    const before = f.dynamo.transactions.length;
    await expect(f.service.apply({ ...base, kind: 'meeting-rules', rules }, f.bearer)).rejects.toThrow();
    expect(f.dynamo.transactions.length).toBe(before);
  });
  it.each(['sender', 'subject', 'pairing', 'workspace', 'scope', 'emergency', 'grant-revoked', 'grant-capability'])('refuses wrong %s without policy admission', async defect => {
    const f = await fixture(defect === 'scope' ? ['google:grant'] : undefined); const request = structuredClone(f.caps);
    if (defect === 'sender') request.policy.sender = 'other@example.test';
    if (defect === 'subject') request.mailboxSubject = 'different-subject';
    if (defect === 'pairing') request.pairingId = randomUUID();
    if (defect === 'workspace') request.workspaceId = 'other-workspace';
    if (defect.startsWith('grant-')) {
      const row = await f.store.get<{ grant: Record<string, unknown> }>(f.grantKey);
      await f.store.transact([f.store.put(f.grantKey, { ...row!.data, ...(defect === 'grant-revoked' ? { revoked: true } : { grant: { ...row!.data.grant, capabilities: [] } }) }, row!.rev)]);
    }
    const before = f.dynamo.transactions.length;
    await expect(f.service.apply(request, defect === 'emergency' ? `Bearer ${f.pair.emergencyCredential}` : f.bearer)).rejects.toThrow();
    expect(f.dynamo.transactions.length).toBe(before); expect(f.dynamo.inspect(dispatchCapPolicyKey(request.policy.sender))).toBeUndefined();
  });
  it.each(['grant', 'pairing'])('fences final %s revocation atomically', async target => {
    const f = await fixture(); const key = target === 'grant' ? f.grantKey : pairingKey(f.pair.pairingId);
    const row = await f.store.get<object>(key);
    f.dynamo.beforeTransaction = () => { f.dynamo.beforeTransaction = undefined; void f.store.transact([f.store.put(key, { ...row!.data, revoked: true }, row!.rev)]); };
    await expect(f.service.apply(f.caps, f.bearer)).rejects.toThrow();
    expect(f.dynamo.inspect(dispatchCapPolicyKey(f.caps.policy.sender))).toBeUndefined();
    expect(f.dynamo.inspect(`POLICY_CONFIGURATION_REQUEST#${keyPart(f.caps.requestId)}`)).toBeUndefined();
  });
  it('recovers lost acknowledgement and does not reset cap usage or repeat configuration on restart', async () => {
    const f = await fixture(); const usageKey = `DISPATCH_CAP#${keyPart(f.caps.policy.sender)}#2026-09-15`;
    await f.store.transact([f.store.put(usageKey, { sender: f.caps.policy.sender, day: '2026-09-15', used: 4 }, null)]);
    const before = f.dynamo.transactions.length;
    f.dynamo.afterCommit = () => { f.dynamo.afterCommit = undefined; throw Error('lost_response'); };
    const receipt = await f.service.apply(f.caps, f.bearer);
    expect(await new WorkerPolicyConfiguration({ auth: f.auth, authorization: f.authorization }).apply(f.caps, f.bearer)).toEqual(receipt);
    expect(f.dynamo.transactions.length - before).toBe(1); expect(f.dynamo.inspect(usageKey)).toMatchObject({ used: 4 });
    await expect(f.service.apply({ ...f.caps, policy: { ...f.caps.policy, dailyLimit: 0 } }, f.bearer)).rejects.toThrow('command_fingerprint_conflict');
    await expect(f.service.apply({ ...f.caps, requestId: randomUUID() }, f.bearer)).rejects.toThrow();
    const next = { ...f.caps, requestId: randomUUID(), expectedRevision: 1, policy: { ...f.caps.policy, dailyLimit: 0 } };
    expect((await f.service.apply(next, f.bearer)).revision).toBe(2);
    const grant = await f.store.get<object>(f.grantKey); await f.store.transact([f.store.put(f.grantKey, { ...grant!.data, revoked: true }, grant!.rev)]);
    expect(await f.service.apply(f.caps, f.bearer)).toEqual(receipt);
    await f.auth.revokePairing(f.pair.pairingId);
    await expect(f.service.apply(f.caps, f.bearer)).rejects.toThrow();
  });
  it.each([undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('requires an explicit safe nonnegative cap (%s)', async dailyLimit => {
    const f = await fixture(); const before = f.dynamo.transactions.length;
    await expect(f.service.apply({ ...f.caps, policy: { ...f.caps.policy, dailyLimit } }, f.bearer)).rejects.toThrow();
    expect(f.dynamo.transactions.length).toBe(before);
  });

  it.each(['missing-conflict', 'foreign-owned', 'alias'])('rejects %s calendar selection before setter writes', async defect => {
    const f = await fixture(); const base = { ...f.caps, policy: undefined as { sender: string; dailyLimit: number } | undefined }; delete base.policy;
    const rules = structuredClone(f.rules);
    if (defect === 'missing-conflict') rules.conflictCalendarIds = [rules.ownedCalendarId];
    if (defect === 'foreign-owned') rules.ownedCalendarId = 'foreign@example.test';
    if (defect === 'alias') {
      rules.ownedCalendarId = 'primary'; rules.conflictCalendarIds = ['primary'];
      const row = await f.store.get<{ grant: Record<string, unknown> }>(f.grantKey);
      await f.store.transact([f.store.put(f.grantKey, { ...row!.data, grant: { ...row!.data.grant, calendars: { confirmed: true, ownedCalendarId: 'primary', conflictCalendarIds: ['primary'] } } }, row!.rev)]);
    }
    const before = f.dynamo.transactions.length;
    await expect(f.service.apply({ ...base, kind: 'meeting-rules', rules }, f.bearer)).rejects.toThrow();
    expect(f.dynamo.transactions.length).toBe(before);
  });
  it('keeps explicit zero caps and current usage while reporting historical replay only', async () => {
    const f = await fixture(); const request = { ...f.caps, policy: { ...f.caps.policy, dailyLimit: 0 } };
    await f.service.apply(request, f.bearer);
    expect(f.dynamo.inspect(dispatchCapPolicyKey(request.policy.sender))).toEqual(request.policy);
    expect(JSON.stringify(await f.service.apply(request, f.bearer))).not.toMatch(/fictional-token|ciphertext|refreshToken/);
  });

});
