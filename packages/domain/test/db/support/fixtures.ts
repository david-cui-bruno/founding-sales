import { randomUUID } from 'node:crypto';
import type { SessionQueryable } from '../../../db/queryable.ts';

/**
 * The two-workspace fixture every database test uses.
 *
 * Specification section 6 and Appendix G 8: two workspaces with colliding external
 * identifiers — the same command id, the same calling number, the same job
 * idempotency key, the same device label — and two users who share a display email.
 * Nothing may cross, and every test that creates business rows starts from here.
 */

export interface SeededMember {
  readonly userId: string;
  readonly membershipId: string;
  readonly deviceId: string;
  readonly email: string;
}

export interface SeededWorkspace {
  readonly workspaceId: string;
  readonly slug: string;
  readonly admin: SeededMember;
  readonly salesperson: SeededMember;
}

export interface TwoWorkspaces {
  readonly alpha: SeededWorkspace;
  readonly beta: SeededWorkspace;
  /** The command id both workspaces use. A receipt in one is invisible to the other. */
  readonly collidingCommandId: string;
  /** The calling number both workspaces register. Unique per workspace, not globally. */
  readonly collidingE164: string;
  /** The job kind and idempotency key both workspaces enqueue. */
  readonly collidingJobKey: { readonly kind: string; readonly idempotencyKey: string };
  /** The display email the two salespeople share. `users.email` is display data, never a key. */
  readonly sharedEmail: string;
}

const hash = (seed: string): string => {
  let value = '';
  for (let index = 0; index < 64; index += 1) {
    value += '0123456789abcdef'[(seed.charCodeAt(index % seed.length) + index * 7) % 16];
  }
  return value;
};

async function seedMember(
  session: SessionQueryable,
  workspaceId: string,
  role: 'admin' | 'salesperson',
  email: string,
  deviceLabel: string,
): Promise<SeededMember> {
  const user = await session.query<{ id: string }>(
    'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
    [`sub-${randomUUID()}`, email, `${role} ${email.split('@')[0] ?? ''}`],
  );
  const userId = user.rows[0]?.id ?? '';
  const membership = await session.query<{ id: string }>(
    'INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, userId, role],
  );
  const device = await session.query<{ id: string }>(
    'INSERT INTO devices (workspace_id, user_id, device_label, secret_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [workspaceId, userId, deviceLabel, hash(`${workspaceId}:${userId}`)],
  );
  return {
    userId,
    membershipId: membership.rows[0]?.id ?? '',
    deviceId: device.rows[0]?.id ?? '',
    email,
  };
}

async function seedWorkspace(session: SessionQueryable, slug: string, sharedEmail: string): Promise<SeededWorkspace> {
  const created = await session.query<{ id: string }>(
    'INSERT INTO workspaces (slug, display_name) VALUES ($1, $2) RETURNING id',
    [slug, `Workspace ${slug}`],
  );
  const workspaceId = created.rows[0]?.id ?? '';
  return {
    workspaceId,
    slug,
    admin: await seedMember(session, workspaceId, 'admin', `admin-${slug}@example.test`, "David's MacBook"),
    // Both workspaces' salespeople share one display email on purpose.
    salesperson: await seedMember(session, workspaceId, 'salesperson', sharedEmail, "David's MacBook"),
  };
}

export async function seedTwoWorkspaces(session: SessionQueryable): Promise<TwoWorkspaces> {
  const sharedEmail = 'shared.display@example.test';
  const alpha = await seedWorkspace(session, 'alpha', sharedEmail);
  const beta = await seedWorkspace(session, 'beta', sharedEmail);
  return {
    alpha,
    beta,
    collidingCommandId: randomUUID(),
    // A reserved fictional number (NANP 555-01XX block), never a dialable one.
    collidingE164: '+14015550123',
    collidingJobKey: { kind: 'mail.sync', idempotencyKey: 'mail-sync:mailbox-1' },
    sharedEmail,
  };
}

/** A 64-character lowercase hex digest for a payload hash column, derived from a label. */
export const payloadHash = hash;
