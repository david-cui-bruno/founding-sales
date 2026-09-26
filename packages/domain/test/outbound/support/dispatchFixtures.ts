import pg from 'pg';
import type { SessionQueryable } from '../../../db/queryable.ts';
import { asSession, CLUSTER_URL_ENVIRONMENT_VARIABLE } from '../../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../../db/workspaceScope.ts';
import type { GmailClient } from '../../../mail/gmailClient.ts';
import type { RecordedGmailClient } from '../../../mail/gmailClientFake.ts';
import { firstStageId } from '../../db/support/crmFixtures.ts';
import type { OutboundWorld, OutboundWorldMailbox } from './outboundWorld.ts';

/**
 * What the dispatch tests share: a firm of their own, a second and third real
 * connection, and a Gmail client with a pause in the one place the dispatch path has a
 * pause — the token refresh between its first read and its claim.
 *
 * No real person, firm or address: every name is invented and every address is in
 * `example.test`, which RFC 6761 reserves.
 */

export interface SeededFirm {
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
  readonly routeId: string;
  readonly address: string;
}

let firms = 0;

/**
 * A firm, contact, usable route and open opportunity of its own, assigned to the
 * mailbox's salesperson — so a test that sets it manual or suppresses it leaves every
 * other test's firm alone.
 */
export async function seedFirm(world: OutboundWorld, mailbox: OutboundWorldMailbox, label: string): Promise<SeededFirm> {
  firms += 1;
  const session = world.database.session;
  const workspaceId = mailbox.workspace.workspaceId;
  const slug = `${label}-${String(firms)}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const address = `${slug}@prospect.example.test`;
  const firm = await session.query<{ id: string }>(
    'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspaceId, `Dispatch Fixture ${slug}`, mailbox.workspace.salesperson.userId],
  );
  const firmId = firm.rows[0]?.id ?? '';
  const contact = await session.query<{ id: string }>(
    "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Robin Example') RETURNING id",
    [workspaceId, firmId],
  );
  const contactId = contact.rows[0]?.id ?? '';
  const route = await session.query<{ id: string }>(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', now(), 0.900, 'passed', 'usable', 'route-policy.1')
     RETURNING id`,
    [workspaceId, firmId, contactId, address],
  );
  const stageId = await firstStageId(session, workspaceId);
  const opportunity = await session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [workspaceId, firmId, stageId],
  );
  return {
    firmId,
    contactId,
    opportunityId: opportunity.rows[0]?.id ?? '',
    routeId: route.rows[0]?.id ?? '',
    address,
  };
}

/** Prepare a fence for a seeded firm, through the world's real `prepareOutboundMessage`. */
export async function prepareFor(
  world: OutboundWorld,
  mailbox: OutboundWorldMailbox,
  firm: SeededFirm,
  overrides: Parameters<OutboundWorld['prepare']>[1] = {},
): Promise<string> {
  return await world.prepare(mailbox, {
    firmId: firm.firmId,
    contactId: firm.contactId,
    opportunityId: firm.opportunityId,
    emailAddressId: firm.routeId,
    toAddress: firm.address,
    ...overrides,
  });
}

export interface ExtraSession {
  readonly session: SessionQueryable;
  readonly pid: number;
  context(workspaceId: string): RepositoryContext;
  close(): Promise<void>;
}

/**
 * Another backend on the world's database, as the superuser — a second worker, or the
 * API committing a reply while the dispatch is between its read and its claim.
 */
export async function openExtraSession(world: OutboundWorld): Promise<ExtraSession> {
  const clusterUrl = process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];
  if (clusterUrl === undefined) throw new Error(`${CLUSTER_URL_ENVIRONMENT_VARIABLE} is unset`);
  const url = new URL(clusterUrl.trim());
  url.pathname = `/${world.database.name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  // A terminated backend is an event on the client; unobserved, it ends the process.
  client.on('error', () => undefined);
  await client.connect();
  const session = asSession(client as unknown as Parameters<typeof asSession>[0]);
  const { rows } = await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  let closed = false;
  return {
    session,
    pid: Number(rows[0]?.pid ?? 0),
    context: workspaceId => repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), session),
    close: async () => {
      if (closed) return;
      closed = true;
      await client.end().catch(() => undefined);
    },
  };
}

/**
 * A Gmail client whose token refresh runs `during` first.
 *
 * The refresh is step 3 of `dispatchOutboundMessage`: after the precheck read the world
 * and found it sendable, before the claiming transaction opens. That is the pause
 * Appendix G 3 describes — "worker pauses after eligibility read" — and it is a real
 * pause in the real path, not a hook the product carries for tests.
 */
export function pausingAtTokenRefresh(
  gmail: RecordedGmailClient,
  during: () => Promise<void>,
): { readonly client: GmailClient; readonly refreshes: () => number } {
  let refreshes = 0;
  return {
    client: {
      ...gmail,
      refreshAccessToken: async (...args: Parameters<GmailClient['refreshAccessToken']>) => {
        refreshes += 1;
        await during();
        return await gmail.refreshAccessToken(...args);
      },
    },
    refreshes: () => refreshes,
  };
}

/** One mailbox's automated counter for a business date, or 0 when the day has no row. */
export async function automatedSent(
  session: SessionQueryable,
  mailbox: OutboundWorldMailbox,
  businessDate: string,
): Promise<number> {
  const { rows } = await session.query<{ automated_sent: number }>(
    `SELECT automated_sent FROM mailbox_send_days
      WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
    [mailbox.workspace.workspaceId, mailbox.mailboxId, businessDate],
  );
  return Number(rows[0]?.automated_sent ?? 0);
}

/** Resolve after `milliseconds`, for "is it still waiting" assertions. */
export async function settle(milliseconds: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Whether a promise has settled, without waiting for it. */
export function tracked<T>(promise: Promise<T>): { readonly promise: Promise<T>; readonly settled: () => boolean } {
  let done = false;
  const observed = promise.then(
    value => {
      done = true;
      return value;
    },
    (error: unknown) => {
      done = true;
      throw error;
    },
  );
  return { promise: observed, settled: () => done };
}

/**
 * Wait until a backend is blocked on a lock — of this type, or of any type.
 *
 * A row lock shows as a wait on the holder's `transactionid` (or on a `tuple`), and the
 * send gate as an `advisory` wait, which is how the tests tell "the claim is waiting
 * for the reply" from "the reply is waiting for the claim".
 */
export async function waitUntilBlocked(
  observer: SessionQueryable,
  pid: number,
  locktype?: 'advisory' | 'transactionid' | 'tuple' | 'relation',
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows } = await observer.query<{ waiting: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_locks
                       WHERE pid = $1 AND NOT granted AND ($2::text IS NULL OR locktype = $2)) AS waiting`,
      [pid, locktype ?? null],
    );
    if (rows[0]?.waiting === true) return;
    await settle(25);
  }
  throw new Error(`backend ${String(pid)} never waited on ${locktype ?? 'any'} lock`);
}

/** Wait until a backend is inside `pg_sleep`. */
export async function waitUntilSleeping(observer: SessionQueryable, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows } = await observer.query<{ sleeping: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event = 'PgSleep') AS sleeping",
      [pid],
    );
    if (rows[0]?.sleeping === true) return;
    await settle(25);
  }
  throw new Error(`backend ${String(pid)} never reached pg_sleep`);
}

/** This session's backend pid. */
export async function backendPid(session: SessionQueryable): Promise<number> {
  const { rows } = await session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return Number(rows[0]?.pid ?? 0);
}
