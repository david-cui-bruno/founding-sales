import { describe, expect, it } from 'vitest';
import { clientVersionPolicySchema } from '@fss/contracts';
import type { SessionQueryable } from '@fss/domain/db';
import { RouteRegistryError, createRouteRegistry, type RouteModule } from '../src/bootstrap/routeRegistry.ts';
import { mountedRoutes } from '../src/bootstrap/routes.ts';
import { apiRouteModules } from '../src/routes/modules.ts';
import { registryFor, route, type ApiOptions } from '../src/server.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { DEFAULT_UPGRADE_URL } from '../src/routes/types.ts';

/**
 * What the API mounts, and what it refuses to mount.
 *
 * Lane G3b moved G2's and G3a's routers off the `for` loop in `server.ts` and on to
 * G5b's registry. The loop's failure mode was silent — a module whose guard was
 * wrong answered for somebody else's path, and the module with the authorization in
 * it never ran — so these assertions are about the collision rules rather than about
 * any one endpoint.
 *
 * No database: `createRouteRegistry` is a pure function of the module list, and the
 * mounted list is the thing worth pinning.
 */

const NEVER_QUERIED: SessionQueryable = {
  query: async () => {
    await Promise.resolve();
    throw new Error('the registry must not query the database to decide what is mounted');
  },
};

function options(): ApiOptions {
  return {
    session: NEVER_QUERIED,
    supportedClientVersions: clientVersionPolicySchema.parse({ minimum: '1.0.0', ceiling: '1.0.x', incompatible: [] }),
    sendingEnabled: false,
    expectedSystemGeneration: null,
  };
}

const routing = {
  session: NEVER_QUERIED,
  supportedClientVersions: clientVersionPolicySchema.parse({ minimum: '1.0.0', ceiling: '1.0.x', incompatible: [] }),
  sendingEnabled: false,
  upgradeUrl: DEFAULT_UPGRADE_URL,
  // Lane G4's routes take the suppression journal from here. The no-op is the right
  // one for a test that builds a registry and never serves a request; the production
  // bootstrap calls `requireDurableJournal` instead.
  suppressionJournal: localNoopSuppressionJournal(),
};

describe('what the API mounts', () => {
  it('mounts every route the process serves, and builds the registry once per options object', () => {
    const shared = options();
    const registry = registryFor(shared);
    expect(registryFor(shared)).toBe(registry);

    expect([...registry.paths()]).toEqual([
      '/admin/alerts',
      '/admin/alerts/acknowledge',
      '/admin/jobs/dead',
      '/admin/jobs/requeue',
      '/attachments/open',
      '/callbacks',
      '/callbacks/complete',
      '/callbacks/schedule',
      '/calling-identities',
      '/calling-identities/attest',
      '/calling-identities/disable',
      '/calling-identities/register',
      '/calls',
      '/calls/log',
      '/crm/firm-page',
      '/crm/firms/add',
      '/dashboard',
      '/diagnostics',
      '/dial/authorize',
      '/dial/check',
      '/dial/consume',
      '/enrollments',
      '/enrollments/enroll',
      '/enrollments/migrate/apply',
      '/enrollments/migrate/approve',
      '/enrollments/migrate/propose',
      '/enrollments/resume',
      '/enrollments/resume/preview',
      '/enrollments/steps',
      '/enrollments/stop',
      '/gmail/connect',
      '/gmail/disconnect',
      '/gmail/status',
      '/health',
      '/healthz',
      '/import/commit',
      '/import/preview',
      '/integrations/gmail/push',
      '/messages',
      '/messages/resolve-ambiguity',
      '/oauth/gmail/callback',
      '/outbound/authentication',
      '/outbound/cap',
      '/outbound/cap/override',
      '/outbound/resolve',
      '/outbound/status',
      '/pauses',
      '/pauses/open',
      '/pauses/release',
      '/pipeline/board',
      '/pipeline/stages',
      '/pipeline/stages/create',
      '/pipeline/stages/rename',
      '/pipeline/stages/reorder',
      '/pipeline/stages/retire',
      '/postures',
      '/postures/allow',
      '/postures/calling-window',
      '/postures/record',
      '/postures/reference',
      '/postures/revoke',
      '/readyz',
      '/replies',
      '/replies/card',
      '/replies/confirm',
      '/replies/settings',
      '/replies/settings/update',
      '/sequences',
      '/sequences/create',
      '/sequences/holidays',
      '/sequences/versions',
      '/sequences/versions/draft',
      '/sequences/versions/publish',
      '/sequences/versions/retire',
      '/sequences/versions/steps',
      '/settings',
      '/settings/history',
      '/settings/update',
      '/templates',
      '/templates/approve',
      '/templates/create',
      '/today',
      '/today/firm',
      '/today/pause/release',
      '/today/snooze',
      '/today/snooze/cancel',
    ]);
    expect([...registry.prefixes()]).toEqual([
      '/auth',
      '/contacts',
      '/firms',
      '/merges',
      '/opportunities',
    ]);
  });

  it('mounts the Gmail callback and the Pub/Sub push path exactly as Google was told them', () => {
    const registry = registryFor(options());
    // Both of these are facts about somebody else's configuration: the redirect URI
    // in Google's console, and `gmail_push_path` in infra/modules/stack, which is
    // also the OIDC audience the subscription mints its token for. A test pins them
    // because renaming either in this repository alone breaks a thing that is quiet
    // about being broken.
    expect(registry.moduleFor('/oauth/gmail/callback')?.name).toBe('gmail');
    expect(registry.moduleFor('/integrations/gmail/push')?.name).toBe('gmail-push');
    // Nothing else lives under either root.
    expect(registry.moduleFor('/oauth/gmail')).toBeUndefined();
    expect(registry.moduleFor('/integrations/gmail')).toBeUndefined();
    expect(registry.moduleFor('/gmail')).toBeUndefined();
  });

  it('answers the mail paths with not_found when the deployment has no Gmail configuration', async () => {
    // The same rule `auth` follows: a half-configured deployment serves nothing it
    // could only half do. `options()` supplies neither.
    for (const path of ['/gmail/connect', '/gmail/status', '/oauth/gmail/callback', '/integrations/gmail/push']) {
      const result = await route(path === '/oauth/gmail/callback' ? 'GET' : 'POST', path, options());
      expect(result.status, path).toBe(404);
    }
  });

  it('routes a firm read whose last segment is an identifier to the firms module', () => {
    const registry = registryFor(options());
    expect(registry.moduleFor('/firms/11111111-1111-4111-8111-111111111111')?.name).toBe('firms');
    expect(registry.moduleFor('/firms')?.name).toBe('firms');
    // A whole segment, not a string prefix: `/firmsomething` is nobody's.
    expect(registry.moduleFor('/firmsomething')).toBeUndefined();
  });

  it('mounts the admin job paths and the attachment link as exact claims and nothing beside them', () => {
    const registry = registryFor(options());
    expect(registry.moduleFor('/admin/jobs/dead')?.name).toBe('admin-jobs');
    expect(registry.moduleFor('/attachments/open')?.name).toBe('attachments');
    expect(registry.moduleFor('/admin/something-else')).toBeUndefined();
    expect(registry.moduleFor('/attachments')).toBeUndefined();
  });

  it('mounts none of the paths wave 2 (S6) deleted for having no caller', () => {
    const registry = registryFor(options());
    for (const path of [
      '/admin/departure/commit',
      '/admin/devices',
      '/admin/devices/revoke',
      '/admin/memberships',
      '/admin/memberships/deactivate',
      '/admin/memberships/role',
      '/export/firms',
      '/outbound/domain',
      '/retention/deletions/commit',
      '/retention/policies',
      '/retention/run',
      '/search/firms',
      '/suppressions',
      '/suppressions/record',
      '/templates/retire',
    ]) {
      expect(registry.moduleFor(path), path).toBeUndefined();
    }
  });

  it('answers the attachment link with not_found when the deployment has no identity configuration', async () => {
    expect((await route('POST', '/attachments/open', options())).status).toBe(404);
  });

  it('refuses a prefix that swallows another module’s exact path', () => {
    const greedy: RouteModule = {
      name: 'greedy',
      paths: [],
      prefixes: ['/admin'],
      handle: async () => await Promise.resolve(null),
    };
    expect(() => createRouteRegistry([...mountedRoutes(), greedy])).toThrow(RouteRegistryError);
  });

  it('refuses two modules claiming the same prefix, and a prefix beneath another', () => {
    const prefixed = (name: string, prefix: string): RouteModule => ({
      name,
      paths: [],
      prefixes: [prefix],
      handle: async () => await Promise.resolve(null),
    });
    expect(() => createRouteRegistry([prefixed('one', '/firms'), prefixed('two', '/firms')])).toThrow(
      RouteRegistryError,
    );
    expect(() => createRouteRegistry([prefixed('one', '/firms'), prefixed('two', '/firms/archive')])).toThrow(
      RouteRegistryError,
    );
    // Siblings are fine; neither contains the other.
    expect(() => createRouteRegistry([prefixed('one', '/firms'), prefixed('two', '/contacts')])).not.toThrow();
  });

  it('refuses a malformed claim rather than mounting it', () => {
    const bad = (claim: string): RouteModule => ({
      name: 'bad',
      paths: [],
      prefixes: [claim],
      handle: async () => await Promise.resolve(null),
    });
    for (const claim of ['firms', '/firms/', '/firms?x=1', '/firms/../admin']) {
      expect(() => createRouteRegistry([bad(claim)]), claim).toThrow(RouteRegistryError);
    }
  });

  it('keeps the reply read and the reply commands separate paths', () => {
    // A `/replies` prefix would have let one claim answer for the list, the card,
    // the confirmation and the configuration alike. 8.3's confirmation has
    // consequences, and the registry can only promise about the paths it was told.
    const registry = registryFor(options());
    for (const path of ['/replies', '/replies/card', '/replies/confirm', '/replies/settings']) {
      expect(registry.moduleFor(path)?.name, path).toBe('replies');
    }
    expect(registry.moduleFor('/replies/confirm-all')).toBeUndefined();
    expect(registry.moduleFor('/replies/settings/reset')).toBeUndefined();
  });

  it('answers a path nobody mounted with a redacted not_found and touches no database', async () => {
    for (const path of ['/', '/commands', '/health/', '/firmsomething']) {
      const result = await route('GET', path, options());
      expect(result, path).toEqual({
        status: 404,
        body: { error: 'not_found', message: 'No such endpoint.' },
      });
    }
  });

  it('gives every module a name an operator can read in the startup line', () => {
    const names = apiRouteModules(routing).map(module => module.name);
    expect(names).toEqual([
      'health',
      'auth',
      'firms',
      'contacts',
      'opportunities',
      'pipeline',
      'merges',
      'firm-page',
      'import',
      'add-firm',
      'postures',
      'dial',
      'calling-identities',
      'calls',
      'callbacks',
      'pauses',
      'gmail',
      'gmail-push',
      'messages',
      'replies',
      'outbound',
      'today',
      'snooze',
      'sequences',
      'templates',
      'enrollments',
      'settings',
      'dashboard',
      'diagnostics',
      'attachments',
    ]);
  });
});
