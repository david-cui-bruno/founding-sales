import { randomBytes, randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import type { SessionQueryable } from '@fss/domain/db';
import type { AuthConfig, AuthDeps } from '../../src/auth/index.ts';
import { createGoogleClient, httpFetch } from '../../src/auth/index.ts';
import { startGoogleStub, type GoogleStub } from './googleStub.ts';

/**
 * The fixture every identity test starts from.
 *
 * Two workspaces with colliding external identifiers (specification 6, Appendix G 8):
 * the same device label, the same command id, and two salespeople who share a display
 * email. Nothing may cross. Every secret — the Google client id, the client secret,
 * the state-signing key, every device secret — is generated when the fixture starts.
 */

export const CURRENT_CLIENT_VERSION = '1.4.0';
export const OUTDATED_CLIENT_VERSION = '1.0.0';

export interface SeededMember {
  readonly userId: string;
  readonly googleSub: string;
  readonly email: string;
  readonly role: 'admin' | 'salesperson';
}

export interface SeededWorkspace {
  readonly workspaceId: string;
  readonly slug: string;
  readonly admin: SeededMember;
  readonly salesperson: SeededMember;
  /** A user in the hosted domain with a `users` row but no membership at all. */
  readonly outsider: SeededMember;
}

export interface AuthFixture {
  readonly database: TestDatabase;
  readonly db: SessionQueryable;
  readonly google: GoogleStub;
  readonly deps: AuthDeps;
  readonly alpha: SeededWorkspace;
  readonly beta: SeededWorkspace;
  readonly hostedDomain: string;
  readonly collidingDeviceLabel: string;
  readonly collidingCommandId: string;
  /** Move the fixture's clock. Every auth function reads `deps.now()`, never `Date.now()`. */
  advance(milliseconds: number): void;
  setNow(instant: Date): void;
  stop(): Promise<void>;
}

const HOSTED_DOMAIN = 'callie.example';

async function seedUser(
  db: SessionQueryable,
  role: 'admin' | 'salesperson',
  email: string,
): Promise<SeededMember> {
  const googleSub = `sub-${randomUUID()}`;
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
    [googleSub, email, `${role} ${email.split('@')[0] ?? ''}`],
  );
  return { userId: rows[0]?.id ?? '', googleSub, email, role };
}

async function seedWorkspace(db: SessionQueryable, slug: string, sharedEmail: string): Promise<SeededWorkspace> {
  const created = await db.query<{ id: string }>(
    'INSERT INTO workspaces (slug, display_name) VALUES ($1, $2) RETURNING id',
    [slug, `Workspace ${slug}`],
  );
  const workspaceId = created.rows[0]?.id ?? '';
  const admin = await seedUser(db, 'admin', `admin-${slug}@${HOSTED_DOMAIN}`);
  const salesperson = await seedUser(db, 'salesperson', sharedEmail);
  const outsider = await seedUser(db, 'salesperson', `outsider-${slug}@${HOSTED_DOMAIN}`);
  for (const member of [admin, salesperson]) {
    await db.query('INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [
      workspaceId,
      member.userId,
      member.role,
    ]);
  }
  return { workspaceId, slug, admin, salesperson, outsider };
}

export function authConfigFor(google: GoogleStub): AuthConfig {
  return {
    oidc: {
      issuer: google.issuer,
      discoveryUrl: google.discoveryUrl,
      clientId: google.clientId,
      clientSecret: google.clientSecret,
      redirectUri: 'https://api.fss.example/auth/google/callback',
      hostedDomain: HOSTED_DOMAIN,
      clockSkewSeconds: 60,
    },
    sessions: {
      accessSessionSeconds: 3600,
      refreshCredentialSeconds: 30 * 24 * 3600,
      fullSignInSeconds: 30 * 24 * 3600,
      authorizationRequestSeconds: 600,
    },
    // A ceiling on the 1.4 line: 1.2.0 to 1.4.999 are admitted (lane g78). The fixture's
    // current client is 1.4.0 and its outdated one 1.0.0, as before.
    supportedClientVersions: { minimum: '1.2.0', ceiling: '1.4.x', incompatible: [] },
    stateSigningKey: randomBytes(32),
  };
}

export async function createAuthFixture(): Promise<AuthFixture> {
  const database = await createTestDatabase();
  const google = await startGoogleStub();
  const sharedEmail = `shared.display@${HOSTED_DOMAIN}`;
  const alpha = await seedWorkspace(database.session, 'alpha', sharedEmail);
  const beta = await seedWorkspace(database.session, 'beta', sharedEmail);

  let current = Date.now();
  const config = authConfigFor(google);
  const deps: AuthDeps = {
    db: database.session,
    config,
    google: createGoogleClient({ fetch: httpFetch, now: () => new Date(current) }),
    now: () => new Date(current),
    randomSecret: () => randomBytes(32).toString('base64url'),
  };

  return {
    database,
    db: database.session,
    google,
    deps,
    alpha,
    beta,
    hostedDomain: HOSTED_DOMAIN,
    collidingDeviceLabel: "David's MacBook",
    collidingCommandId: randomUUID(),
    advance: milliseconds => {
      current += milliseconds;
    },
    setNow: instant => {
      current = instant.getTime();
    },
    stop: async () => {
      await google.stop();
      await database.drop();
    },
  };
}

/** The `state` a start-sign-in answer put in the authorization URL. */
export function stateOf(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get('state') ?? '';
}

/** The `nonce` a start-sign-in answer put in the authorization URL. */
export function nonceOf(authorizationUrl: string): string {
  return new URL(authorizationUrl).searchParams.get('nonce') ?? '';
}
