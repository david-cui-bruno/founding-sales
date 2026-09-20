import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { commitDeparture, previewDeparture } from '../../retention/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedMail, type SeededMail } from '../db/support/mailFixtures.ts';

/**
 * Departure (specification 10.3, Appendix F).
 *
 * > Departure immediately revokes membership, devices, sessions, and OAuth grants and
 * > deletes refresh-token material. Firm-related business correspondence remains;
 * > private drafts, raw mailbox material, and unrelated metadata expire under the
 * > table above.
 *
 * Two sentences, two halves of every test below: what is revoked or deleted now, and
 * what is still there afterwards. The second half is the one a careless
 * implementation gets wrong — a departure that deleted the departed salesperson's
 * firms would delete Callie's business history, and 10.3 says it remains.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let mail: SeededMail;

const adminContext = (
  workspaceId: string,
  userId: string,
  db: SessionQueryable = database.session,
): RepositoryContext => repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role: 'admin' }), db);

const salespersonContext = (
  workspaceId: string,
  userId: string,
  db: SessionQueryable = database.session,
): RepositoryContext =>
  repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role: 'salesperson' }), db);

const count = async (sql: string, values: readonly unknown[]): Promise<number> => {
  const { rows } = await database.session.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
};

/** A session, a device credential and an envelope-encrypted refresh token for a member. */
async function seedGrants(workspaceId: string, userId: string, deviceId: string): Promise<void> {
  // A 64-character lowercase hex digest, derived from the device so two members
  // never collide on `sessions_token_unique`.
  const hash = createHash('sha256').update(`${workspaceId}:${deviceId}`).digest('hex');
  await database.session.query(
    `INSERT INTO sessions (workspace_id, user_id, device_id, access_token_hash, expires_at, reauthenticate_after)
     VALUES ($1, $2, $3, $4, now() + INTERVAL '1 hour', now() + INTERVAL '30 days')`,
    [workspaceId, userId, deviceId, hash],
  );
  await database.session.query(
    `INSERT INTO device_refresh_credentials (workspace_id, device_id, generation, secret_hash, expires_at)
     VALUES ($1, $2, 1, $3, now() + INTERVAL '30 days')`,
    [workspaceId, deviceId, hash],
  );
}

async function seedMailboxToken(workspaceId: string, mailboxId: string): Promise<void> {
  await database.session.query(
    `INSERT INTO mailbox_tokens (workspace_id, mailbox_id, key_id, wrapped_data_key, ciphertext, iv, auth_tag)
     VALUES ($1, $2, 'alias/fss-envelope-test',
             decode('00112233', 'hex'), decode('445566', 'hex'),
             decode('000102030405060708090a0b', 'hex'),
             decode('000102030405060708090a0b0c0d0e0f', 'hex'))`,
    [workspaceId, mailboxId],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  mail = await seedMail(database.session, seeded, crm);
  for (const side of [seeded.alpha, seeded.beta]) {
    await seedGrants(side.workspaceId, side.salesperson.userId, side.salesperson.deviceId);
    await seedGrants(side.workspaceId, side.admin.userId, side.admin.deviceId);
  }
  await seedMailboxToken(seeded.alpha.workspaceId, mail.alpha.mailboxId);
  await seedMailboxToken(seeded.beta.workspaceId, mail.beta.mailboxId);
});

afterAll(async () => {
  await database.drop();
});

describe('who may depart whom', () => {
  it('refuses a salesperson', async () => {
    const outcome = await commitDeparture(
      salespersonContext(seeded.alpha.workspaceId, seeded.alpha.salesperson.userId),
      { userId: seeded.alpha.admin.userId, commandId: 'departure-refused-1' },
    );
    expect(outcome).toMatchObject({ ok: false, reason: 'admin_only' });
  });

  it('refuses an admin departing themselves', async () => {
    const outcome = await commitDeparture(adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId), {
      userId: seeded.alpha.admin.userId,
      commandId: 'departure-refused-2',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'self_departure' });
  });

  it('refuses the last active admin', async () => {
    // Beta's admin is the only active admin there; departing them would strand the
    // workspace, which 5.2 forbids by name.
    const outcome = await commitDeparture(adminContext(seeded.beta.workspaceId, seeded.beta.salesperson.userId), {
      userId: seeded.beta.admin.userId,
      commandId: 'departure-refused-3',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'last_active_admin' });
  });
});

describe('departure leaves business history and removes private material', () => {
  it('previews the revocations without performing any of them', async () => {
    const context = adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId);
    const preview = await previewDeparture(context, { userId: seeded.alpha.salesperson.userId });
    expect(preview.ok, preview.reason).toBe(true);
    expect(preview.value?.activeDevices).toBeGreaterThan(0);
    expect(preview.value?.activeSessions).toBeGreaterThan(0);
    expect(preview.value?.connectedMailboxes).toBe(1);
    expect(preview.value?.refreshTokenRows).toBe(1);
    expect(preview.value?.assignedFirms).toBeGreaterThanOrEqual(0);

    expect(
      await count("SELECT count(*) AS count FROM sessions WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'", [
        seeded.alpha.workspaceId,
        seeded.alpha.salesperson.userId,
      ]),
    ).toBeGreaterThan(0);
  });

  it('revokes membership, devices, sessions and the Gmail grant, and deletes the refresh-token material as one row', async () => {
    const context = adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId);
    const messagesBefore = await count('SELECT count(*) AS count FROM mail_messages WHERE workspace_id = $1', [
      seeded.alpha.workspaceId,
    ]);

    const outcome = await commitDeparture(context, {
      userId: seeded.alpha.salesperson.userId,
      commandId: 'departure-alpha-1',
    });
    expect(outcome.ok, outcome.reason).toBe(true);
    expect(outcome.value?.refreshTokenMaterialDeleted).toBe(true);

    expect(
      await count(
        "SELECT count(*) AS count FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'",
        [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
      ),
    ).toBe(0);
    expect(
      await count("SELECT count(*) AS count FROM devices WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'", [
        seeded.alpha.workspaceId,
        seeded.alpha.salesperson.userId,
      ]),
    ).toBe(0);
    expect(
      await count("SELECT count(*) AS count FROM sessions WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'", [
        seeded.alpha.workspaceId,
        seeded.alpha.salesperson.userId,
      ]),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*) AS count FROM device_refresh_credentials c
           JOIN devices d ON d.workspace_id = c.workspace_id AND d.id = c.device_id
          WHERE c.workspace_id = $1 AND d.user_id = $2 AND c.state = 'active'`,
        [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
      ),
    ).toBe(0);
    expect(
      await count("SELECT count(*) AS count FROM mailboxes WHERE workspace_id = $1 AND owner_user_id = $2 AND status = 'connected'", [
        seeded.alpha.workspaceId,
        seeded.alpha.salesperson.userId,
      ]),
    ).toBe(0);

    // The one irreversible removal: the envelope-encrypted refresh token is gone.
    expect(
      await count('SELECT count(*) AS count FROM mailbox_tokens WHERE workspace_id = $1 AND mailbox_id = $2', [
        seeded.alpha.workspaceId,
        mail.alpha.mailboxId,
      ]),
    ).toBe(0);

    // Business correspondence remains. The mailbox row remains too: it is what the
    // firm's messages hang off, and deleting it would delete them.
    expect(await count('SELECT count(*) AS count FROM mail_messages WHERE workspace_id = $1', [
      seeded.alpha.workspaceId,
    ])).toBe(messagesBefore);
    expect(
      await count('SELECT count(*) AS count FROM firms WHERE workspace_id = $1', [seeded.alpha.workspaceId]),
    ).toBeGreaterThan(0);
    expect(
      await count('SELECT count(*) AS count FROM opportunity_stage_events WHERE workspace_id = $1', [
        seeded.alpha.workspaceId,
      ]),
    ).toBeGreaterThan(0);

    // Audited.
    expect(
      await count("SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1 AND action = 'departure.committed'", [
        seeded.alpha.workspaceId,
      ]),
    ).toBe(1);

    // Nothing crossed: beta's salesperson still has everything.
    expect(
      await count("SELECT count(*) AS count FROM devices WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'", [
        seeded.beta.workspaceId,
        seeded.beta.salesperson.userId,
      ]),
    ).toBeGreaterThan(0);
    expect(
      await count('SELECT count(*) AS count FROM mailbox_tokens WHERE workspace_id = $1', [seeded.beta.workspaceId]),
    ).toBe(1);
  });

  it('holds the departed member’s firms for reassignment rather than unassigning them silently', async () => {
    const held = await count(
      `SELECT count(*) AS count FROM active_holds
        WHERE workspace_id = $1 AND reason_code = 'reassignment' AND released_at IS NULL
          AND source_event_kind = 'membership.departed'`,
      [seeded.alpha.workspaceId],
    );
    const assigned = await count(
      'SELECT count(*) AS count FROM firms WHERE workspace_id = $1 AND assigned_user_id = $2',
      [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
    );
    // One hold per firm the departed member still owns, and the assignment is still
    // there so an admin can see whose work needs a new owner.
    expect(held).toBe(assigned);
    expect(held).toBeGreaterThan(0);
    const { rows } = await database.session.query<{ blocked_action_kinds: string[] }>(
      `SELECT blocked_action_kinds FROM active_holds
        WHERE workspace_id = $1 AND reason_code = 'reassignment' AND source_event_kind = 'membership.departed'
        LIMIT 1`,
      [seeded.alpha.workspaceId],
    );
    expect(rows[0]?.blocked_action_kinds).toContain('enrollment_advance');
    expect(rows[0]?.blocked_action_kinds).toContain('email_send');
  });

  it('is replay safe: a second departure reports the first rather than revoking again', async () => {
    const context = adminContext(seeded.alpha.workspaceId, seeded.alpha.admin.userId);
    const holdsBefore = await count(
      "SELECT count(*) AS count FROM active_holds WHERE workspace_id = $1 AND source_event_kind = 'membership.departed'",
      [seeded.alpha.workspaceId],
    );
    const outcome = await commitDeparture(context, {
      userId: seeded.alpha.salesperson.userId,
      commandId: 'departure-alpha-2',
    });
    expect(outcome.ok, outcome.reason).toBe(true);
    expect(outcome.value?.replayed).toBe(true);
    expect(
      await count(
        "SELECT count(*) AS count FROM active_holds WHERE workspace_id = $1 AND source_event_kind = 'membership.departed'",
        [seeded.alpha.workspaceId],
      ),
    ).toBe(holdsBefore);
    expect(
      await count("SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1 AND action = 'departure.committed'", [
        seeded.alpha.workspaceId,
      ]),
    ).toBe(1);
  });
});
