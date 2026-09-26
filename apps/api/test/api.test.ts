import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { API_SCHEMA_RANGE, CURRENT_SCHEMA_VERSION } from '@fss/domain/db/schemaRange.ts';
import { clientVersionPolicySchema } from '@fss/contracts';
import { buildHealthReport } from '../src/health.ts';
import { MAX_REQUEST_BYTES, REFUSAL_STATUS, checkEnvelope, redactError } from '../src/limits.ts';
import { contextFor, scopeForPrincipal, systemScope, type VerifiedPrincipal } from '../src/scope.ts';
import { route } from '../src/server.ts';

const CLIENT_VERSIONS = clientVersionPolicySchema.parse({ minimum: '1.0.0', ceiling: '1.0.x', incompatible: [] });

const PRINCIPAL: VerifiedPrincipal = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'salesperson',
  membershipStatus: 'active',
  deviceId: '33333333-3333-4333-8333-333333333333',
  deviceStatus: 'active',
};

describe('request limits', () => {
  it('lets a bodyless request through', () => {
    expect(checkEnvelope({ method: 'GET', contentType: undefined, contentLength: undefined })).toEqual({
      accepted: true,
    });
  });

  it('refuses anything but application/json on a body-carrying request', () => {
    expect(checkEnvelope({ method: 'POST', contentType: 'text/plain', contentLength: '2' })).toEqual({
      accepted: false,
      code: 'unsupported_media_type',
    });
    expect(
      checkEnvelope({ method: 'POST', contentType: 'application/json; charset=utf-8', contentLength: '2' }),
    ).toEqual({ accepted: true });
  });

  it('refuses a body larger than the limit, and one that does not declare its length', () => {
    expect(
      checkEnvelope({
        method: 'POST',
        contentType: 'application/json',
        contentLength: String(MAX_REQUEST_BYTES + 1),
      }),
    ).toEqual({ accepted: false, code: 'payload_too_large' });
    expect(checkEnvelope({ method: 'POST', contentType: 'application/json', contentLength: undefined })).toEqual({
      accepted: false,
      code: 'payload_too_large',
    });
    expect(checkEnvelope({ method: 'POST', contentType: 'application/json', contentLength: 'lots' })).toEqual({
      accepted: false,
      code: 'payload_too_large',
    });
  });

  it('redacts every error to a code and a fixed sentence', () => {
    const redacted = redactError('internal_error');
    expect(redacted).toEqual({ error: 'internal_error', message: 'The request could not be completed.' });
    expect(JSON.stringify(redacted)).not.toContain('postgres');
  });
});

describe('typed workspace scope wiring', () => {
  it('builds a scope for a verified principal', () => {
    const outcome = scopeForPrincipal(PRINCIPAL);
    expect(outcome.authorized).toBe(true);
    if (outcome.authorized) {
      expect(outcome.scope.workspaceId).toBe(PRINCIPAL.workspaceId);
      // The context is the only way into a repository, and it needs the scope value.
      const context = contextFor(outcome.scope, { query: async () => await Promise.resolve({ rows: [], rowCount: 0 }) });
      expect(context.scope).toBe(outcome.scope);
    }
  });

  it('refuses an inactive membership and a revoked device, before any business logic', () => {
    expect(scopeForPrincipal({ ...PRINCIPAL, membershipStatus: 'inactive' })).toEqual({
      authorized: false,
      refusal: 'membership_inactive',
    });
    expect(scopeForPrincipal({ ...PRINCIPAL, deviceStatus: 'revoked' })).toEqual({
      authorized: false,
      refusal: 'device_revoked',
    });
    expect(scopeForPrincipal({ ...PRINCIPAL, workspaceId: 'callie' })).toEqual({
      authorized: false,
      refusal: 'principal_malformed',
    });
  });

  it('gives the worker and the scheduler a scope with no user and no role', () => {
    expect(systemScope(PRINCIPAL.workspaceId, 'worker').actor).toEqual({ kind: 'system', component: 'worker' });
  });
});

describe('the health route against a real database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('reports the schema range and the database version', async () => {
    const report = await buildHealthReport({
      session: database.session,
      supportedClientVersions: CLIENT_VERSIONS,
      sendingEnabled: false,
    });
    expect(report).toEqual({
      status: 'serving',
      component: 'api',
      // From the constants rather than repeated here: the next lane to add a
      // migration widens `schemaRange.ts` and this keeps agreeing with it.
      schema: {
        declaredRange: { minimum: API_SCHEMA_RANGE.minimum, maximum: API_SCHEMA_RANGE.maximum },
        databaseVersion: CURRENT_SCHEMA_VERSION,
        accepted: true,
        reason: null,
      },
      // The published range, not the policy: `1.0.x` tops out at 1.0.999 (lane g78).
      supportedClientVersions: { minimum: '1.0.0', maximum: '1.0.999' },
      sendingEnabled: false,
    });
  });

  it('says sending is disabled until an admin enables it', async () => {
    const report = await buildHealthReport({
      session: database.session,
      supportedClientVersions: CLIENT_VERSIONS,
      sendingEnabled: false,
    });
    expect(report.sendingEnabled).toBe(false);
  });

  it('is degraded, not silent, when the database cannot answer', async () => {
    const broken = {
      query: async () => {
        await Promise.resolve();
        throw new Error('connection to server at "10.0.0.5", port 5432 failed: password authentication failed');
      },
    };
    const report = await buildHealthReport({
      session: broken,
      supportedClientVersions: CLIENT_VERSIONS,
      sendingEnabled: false,
    });
    expect(report.status).toBe('degraded');
    expect(report.schema.reason).toBe('database_unreachable');
    // The host, the port and the role never leave the catch.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('10.0.0.5');
    expect(serialized).not.toContain('password');
  });

  it('reports degraded when the database is behind the binary', async () => {
    const behind = await createTestDatabase({ throughVersion: 0 });
    try {
      const report = await buildHealthReport({
        session: behind.session,
        supportedClientVersions: CLIENT_VERSIONS,
        sendingEnabled: false,
      });
      expect(report.status).toBe('degraded');
      expect(report.schema).toMatchObject({ databaseVersion: 0, accepted: false, reason: 'database_behind_binary' });
    } finally {
      await behind.drop();
    }
  });

  it('serves /health and refuses everything else', async () => {
    const options = {
      session: database.session,
      supportedClientVersions: CLIENT_VERSIONS,
      sendingEnabled: false,
    };
    expect((await route('GET', '/health', options)).status).toBe(200);
    expect(await route('POST', '/health', options)).toEqual({
      status: REFUSAL_STATUS.method_not_allowed,
      body: redactError('method_not_allowed'),
    });
    // No business route exists yet, and the router says so rather than falling through.
    for (const path of ['/', '/firms', '/commands', '/health/']) {
      expect(await route('GET', path, options), path).toEqual({
        status: REFUSAL_STATUS.not_found,
        body: redactError('not_found'),
      });
    }
  });
});
