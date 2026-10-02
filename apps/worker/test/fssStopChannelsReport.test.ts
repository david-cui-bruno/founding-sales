import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { insertStop, seedChannelFirm, type ChannelFirm } from '@fss/domain/test/suppression/support/channelWorld.ts';
import { main } from '../src/tools/fss.ts';
import { stopChannelsReportCommand } from '../src/tools/fss/admin.ts';
import { COMMAND_DEPENDENCIES, parseFssCommand } from '../src/tools/fss/commands.ts';

/**
 * `fss admin stop-channels report` on real PostgreSQL (slice S3X, contract check CC2b,
 * DESIGN-S3X §0.1): the contacts migration 0037 made undialable, measured after the release.
 *
 * Counted: a stop recorded before 0037 on the person's address (which now reads `all` and,
 * with the addresses in the dial keys, stops their calls), on a person one could dial, whom
 * nothing else stops dialling. Not counted: a person whose number or firm was already stopped
 * for calls, a person with no number, and an e-mail opt-out recorded after 0037 (`email`,
 * which stops no call).
 *
 * The output goes to the operations task's log, so it carries ids and counts only.
 * Fictional throughout: `example.test` addresses and 555-01XX numbers.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let url = '';
let appliedAt = '';
const firms: Record<string, ChannelFirm> = {};

const before = (): string => new Date(Date.parse(appliedAt) - 86_400_000).toISOString();
const after = (): string => new Date(Date.parse(appliedAt) + 60_000).toISOString();

async function run(argv: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  const printed: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    printed.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return { code: await main(argv, { DATABASE_URL: url }), stdout: printed.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  const named = await database.session.query<{ name: string }>('SELECT current_database() AS name');
  const clusterUrl = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '');
  clusterUrl.pathname = `/${named.rows[0]?.name ?? ''}`;
  url = clusterUrl.toString();
  seeded = await seedTwoWorkspaces(database.session);
  const applied = await database.session.query<{ at: Date }>('SELECT applied_at AS at FROM schema_versions WHERE version = 37');
  appliedAt = (applied.rows[0]?.at ?? new Date()).toISOString();
  const workspace = seeded.alpha.workspaceId;
  const stop = async (input: Parameters<typeof insertStop>[2]): Promise<void> => {
    await insertStop(database.session, workspace, input);
  };

  // Counted: an opt-out from before 0037 on a person with a number and no other stop.
  firms['legacy'] = await seedChannelFirm(database.session, seeded.alpha);
  await stop({ scope: 'handle', key: firms['legacy'].address, at: before() });

  // Not counted: their number was already stopped for calls.
  firms['numberStopped'] = await seedChannelFirm(database.session, seeded.alpha);
  await stop({ scope: 'handle', key: firms['numberStopped'].address, at: before() });
  await stop({ scope: 'handle', key: firms['numberStopped'].otherPhone, channel: 'phone', at: before(), source: 'prospect_do_not_call' });

  // Not counted: their firm was already stopped for calls.
  firms['firmStopped'] = await seedChannelFirm(database.session, seeded.alpha);
  await stop({ scope: 'handle', key: firms['firmStopped'].address, at: before() });
  await stop({ scope: 'firm', key: firms['firmStopped'].firmId, channel: 'phone', at: before(), source: 'prospect_do_not_call' });

  // Not counted: an e-mail opt-out since 0037, which stops no call.
  firms['emailSince'] = await seedChannelFirm(database.session, seeded.alpha);
  await stop({ scope: 'handle', key: firms['emailSince'].address, channel: 'email', at: after() });

  // Not counted: an `all` address stop recorded since 0037 was chosen as all (the recorded-
  // before filter alone excludes it).
  firms['allSince'] = await seedChannelFirm(database.session, seeded.alpha);
  await stop({ scope: 'handle', key: firms['allSince'].address, channel: 'all', at: after() });

  // Not counted: an `email` address stop stops no call whenever it was recorded (the channel
  // filter alone excludes it; no such row predates 0037 in production).
  firms['emailBefore'] = await seedChannelFirm(database.session, seeded.alpha);
  await stop({ scope: 'handle', key: firms['emailBefore'].address, channel: 'email', at: before() });

  // Not counted: nobody to dial.
  firms['noNumber'] = await seedChannelFirm(database.session, seeded.alpha);
  await database.session.query('DELETE FROM phone_routes WHERE workspace_id = $1 AND contact_id = $2', [workspace, firms['noNumber'].contactId]);
  await stop({ scope: 'handle', key: firms['noNumber'].address, at: before() });
});

afterAll(async () => {
  await database.drop();
});

describe('fss admin stop-channels report', () => {
  it('is a parseable database-only command', () => {
    expect(parseFssCommand(['admin', 'stop-channels', 'report'])).toMatchObject({ ok: true });
    expect(parseFssCommand(['admin', 'stop-channels', 'report', '--workspace', 'x'])).toMatchObject({ ok: false });
    expect(COMMAND_DEPENDENCIES['stop-channels report']).toBe('database');
  });

  it('counts exactly the dialable contact whose pre-0037 address stop now stops calls, by id only', async () => {
    const { code, stdout } = await run(['admin', 'stop-channels', 'report']);
    expect(code, stdout).toBe(0);
    const answer = JSON.parse(stdout) as {
      ok: boolean;
      report: {
        schemaVersion: number;
        migration0037AppliedAt: string;
        workspaces: { workspaceId: string; newlyUndialableContacts: number; atFirms: number; contacts: { contactId: string; firmId: string }[] }[];
      };
    };
    expect(answer.ok).toBe(true);
    expect(answer.report.schemaVersion).toBeGreaterThanOrEqual(37);
    expect(answer.report.migration0037AppliedAt).toBe(appliedAt);
    const alpha = answer.report.workspaces.find(entry => entry.workspaceId === seeded.alpha.workspaceId);
    expect(alpha).toEqual({
      workspaceId: seeded.alpha.workspaceId,
      newlyUndialableContacts: 1,
      atFirms: 1,
      contacts: [{ contactId: firms['legacy']?.contactId, firmId: firms['legacy']?.firmId }],
    });
    expect(answer.report.workspaces.find(entry => entry.workspaceId === seeded.beta.workspaceId)).toMatchObject({
      newlyUndialableContacts: 0,
      contacts: [],
    });
    // Ids and counts only: no address and no number reaches the log.
    expect(stdout).not.toContain('@');
    expect(stdout).not.toMatch(/\+1\d{10}/u);
  });

  it('writes nothing, and refuses below schema 37', async () => {
    const counted = await database.session.query<{ n: string }>('SELECT count(*)::text AS n FROM suppression_events');
    await run(['admin', 'stop-channels', 'report']);
    expect((await database.session.query<{ n: string }>('SELECT count(*)::text AS n FROM suppression_events')).rows[0]?.n).toBe(counted.rows[0]?.n);

    const old = await createTestDatabase({ throughVersion: 36 });
    try {
      const outcome = await stopChannelsReportCommand({ session: old.session } as Parameters<typeof stopChannelsReportCommand>[0]);
      expect(outcome).toMatchObject({ ok: false, reason: 'schema_too_old' });
    } finally {
      await old.drop();
    }
  });
});
