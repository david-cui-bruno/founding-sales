import {expect, it, vi} from 'vitest';
import type {QueryResultRowLike, SessionQueryable} from '@fss/domain/db/queryable.ts';
import {formatAccessToken, sha256Hex} from '../src/auth/tokens.ts';
import {routeCallSessions} from '../src/routes/callSessions.ts';
import {samePrivatePrincipal} from '../src/routes/privateReadAuthority.ts';
import type {AuthenticatedPrincipal} from '../src/auth/sessions.ts';
import type {ApiRequest, RoutingOptions} from '../src/routes/types.ts';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const userId = '10000000-0000-4000-8000-000000000002';
const deviceId = '10000000-0000-4000-8000-000000000003';
const sessionId = '10000000-0000-4000-8000-000000000004';
const replacementId = '10000000-0000-4000-8000-000000000005';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

/** Actual route, provider-setting reader, policy deps and principal helper/authenticate.
 * Only SQL and the synchronous token port are fake. No PG, server or provider exists.
 */
function fixture() {
  let now = new Date('2026-10-26T11:00:00Z');
  let authReads = 0;
  const row = {
    id: sessionId, user_id: userId, device_id: deviceId, status: 'active',
    expires_at: new Date('2026-10-26T12:00:00Z'),
    reauthenticate_after: new Date('2026-11-01T12:00:00Z'),
    device_status: 'active', membership_status: 'active', role: 'salesperson', client_version: '1.0.0',
  };
  const providerEntered = deferred(), providerRelease = deferred();
  const currentEntered = deferred(), currentRelease = deferred();
  let delayCurrent = false;
  const events: string[] = [];
  const bearer = formatAccessToken(workspaceId, 'x'.repeat(43));
  const db: SessionQueryable = {
    async query<Row extends QueryResultRowLike>(sql: string, values?: readonly unknown[]) {
      let rows: QueryResultRowLike[];
      if (sql.includes('FROM workspace_settings')) {
        expect(values).toEqual([workspaceId, 'calling_provider']);
        events.push('provider_wait');
        providerEntered.resolve();
        await providerRelease.promise;
        rows = [{value: {provider: 'twilio'}, version: 1}];
        events.push('provider_return');
      } else if (sql.includes('FROM sessions s')) {
        expect(values).toEqual([workspaceId, sha256Hex(bearer)]);
        authReads += 1;
        if (authReads > 1) {
          events.push('current_wait');
          currentEntered.resolve();
          if (delayCurrent) await currentRelease.promise;
        }
        rows = [{...row}];
        events.push(authReads === 1 ? 'initial_auth' : 'current_auth');
      } else {
        throw new Error('Unexpected SQL in pure Voice authority test');
      }
      return {rows: rows as Row[], rowCount: rows.length};
    },
  };
  const mint = vi.fn((_identity: string, seconds: number) => {
    events.push('mint');
    return {token: 'fake-outgoing-voice-grant', expiresAtSeconds: seconds + 3600};
  });
  // Unused startup dependencies are deliberately absent: this route must not access them.
  const options = {auth: {db, now: () => now}, integrations: {twilio: {mintAccessToken: mint}}} as unknown as RoutingOptions;
  const request: ApiRequest = {
    method: 'POST', path: '/calls/access-token', headers: {authorization: `Bearer ${bearer}`},
    query: new URLSearchParams(), body: {},
  };
  return {
    row, mint, events, providerEntered, providerRelease, currentEntered, currentRelease,
    start: () => routeCallSessions(request, options),
    delayCurrent: () => { delayCurrent = true; },
    setNow: (value: Date) => { now = value; },
  };
}

type SessionRow = ReturnType<typeof fixture>['row'];
const losses: [string, Partial<SessionRow>][] = [
  ['session revocation', {status: 'ended'}],
  ['device revocation', {device_status: 'revoked'}],
  ['session revision replacement', {id: replacementId}],
  ['device revision replacement', {device_id: replacementId}],
  ['user replacement', {user_id: replacementId}],
  ['role change', {role: 'admin'}],
  ['membership deactivation', {membership_status: 'inactive'}],
];

it.each(['workspaceId', 'userId', 'deviceId', 'sessionId', 'role'] as const)(
  'the reused exact-principal comparison rejects a changed %s', field => {
    const principal: AuthenticatedPrincipal = {
      workspaceId, userId, deviceId, sessionId, role: 'salesperson',
      membershipStatus: 'active', deviceStatus: 'active',
    };
    expect(samePrivatePrincipal(principal, {...principal})).toBe(true);
    expect(samePrivatePrincipal(principal, {
      ...principal, [field]: field === 'role' ? 'admin' : replacementId,
    })).toBe(false);
  },
);

it.each(losses)('refuses %s committed during the provider-setting wait without minting', async (_name, change) => {
  const f = fixture();
  const pending = f.start();
  await f.providerEntered.promise;
  expect(f.mint).not.toHaveBeenCalled();
  Object.assign(f.row, change);
  f.providerRelease.resolve();
  expect(await pending).toEqual({status: 401, body: {error: 'session_changed'}});
  expect(f.mint).not.toHaveBeenCalled();
  expect(f.events).toEqual(['initial_auth', 'provider_wait', 'provider_return', 'current_wait', 'current_auth']);
});

it('unchanged exact principal mints once only after the final authentication await', async () => {
  const f = fixture();
  f.delayCurrent();
  const pending = f.start();
  await f.providerEntered.promise;
  expect(f.mint).not.toHaveBeenCalled();
  f.providerRelease.resolve();
  await f.currentEntered.promise;
  expect(f.mint).not.toHaveBeenCalled();
  f.currentRelease.resolve();
  expect(await pending).toEqual({status: 200, body: {
    token: 'fake-outgoing-voice-grant', identity: userId,
    expiresAt: new Date((f.mint.mock.calls[0]![1] + 3600) * 1000).toISOString(),
  }});
  expect(f.mint).toHaveBeenCalledExactlyOnceWith(userId, expect.any(Number));
  expect(f.events).toEqual(['initial_auth', 'provider_wait', 'provider_return', 'current_wait', 'current_auth', 'mint']);
});

it('uses the auth clock after the helper query await, refusing expiry during reauthentication', async () => {
  const f = fixture();
  f.delayCurrent();
  const pending = f.start();
  await f.providerEntered.promise;
  f.providerRelease.resolve();
  await f.currentEntered.promise;
  expect(f.mint).not.toHaveBeenCalled();
  f.setNow(new Date('2026-10-26T12:00:00Z'));
  f.currentRelease.resolve();
  expect(await pending).toEqual({status: 401, body: {error: 'session_changed'}});
  expect(f.mint).not.toHaveBeenCalled();
});
