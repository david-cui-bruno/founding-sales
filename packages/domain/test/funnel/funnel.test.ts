import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { recordFunnelFact } from '../../funnel/facts.ts';
import { funnelFacts } from '../../funnel/read.ts';
import { FUNNEL_FACT_KINDS, isFunnelFactKind } from '../../funnel/kinds.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';

/**
 * The funnel: one recorder, one read (migration 0022, `docs/greenfield/funnel.md`).
 *
 * The frame is the dashboard's, because the question the read matrix asks of an
 * aggregate is the same one: two salespeople in one workspace with one firm each,
 * plus a second workspace with rows of its own, so a workspace-wide count *is* the
 * other person's count. The firm-less fact is this lane's addition to that frame —
 * a demo visitor or a published post belongs to the workspace and to nobody's list.
 */

const WINDOW = { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };
const WORKSPACE = { onlyAssignedTo: null } as const;

describe('the funnel', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let admin: RepositoryContext;
  let assignee: RepositoryContext;
  let colleague: RepositoryContext;
  let betaAdmin: RepositoryContext;
  let assigneeUserId: string;
  let colleagueUserId: string;
  let colleagueFirmId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    assigneeUserId = seeded.alpha.salesperson.userId;

    const other = await database.session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`sub-${randomUUID()}`, 'funnel.colleague@example.test', 'Second Salesperson'],
    );
    colleagueUserId = other.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'salesperson', 'active')",
      [seeded.alpha.workspaceId, colleagueUserId],
    );
    const firm = await database.session.query<{ id: string }>(
      'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
      [seeded.alpha.workspaceId, 'Southwind Test Partners', colleagueUserId],
    );
    colleagueFirmId = firm.rows[0]?.id ?? '';
    // The assignee's firm, so the audience rule has something to filter on.
    await database.session.query('UPDATE firms SET assigned_user_id = $3 WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      crm.alpha.firmId,
      assigneeUserId,
    ]);

    admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    assignee = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: assigneeUserId, role: 'salesperson' }),
      database.session,
    );
    colleague = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: colleagueUserId, role: 'salesperson' }),
      database.session,
    );
    betaAdmin = repositoryContext(
      workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.admin.userId, role: 'admin' }),
      database.session,
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  // ------------------------------------------------------------- the recorder
  describe('recording a fact', () => {
    // The kinds here are the recorder's own (`recorder.*`), because every test in
    // this file shares one database: a fact written to prove deduplication must not
    // become a count the read's cases assert on.
    it('writes one row, and a second call with the same key is a duplicate rather than a crash', async () => {
      const key = `record-once-${randomUUID()}`;
      const first = await recordFunnelFact(admin, {
        kind: 'recorder.placed',
        source: 'telephony',
        dedupeKey: key,
        firmId: crm.alpha.firmId,
        occurredAt: '2026-09-05T10:00:00.000Z',
        detail: { attempt: 1 },
      });
      expect(first).toMatchObject({ recorded: true });

      const again = await recordFunnelFact(admin, {
        kind: 'recorder.placed',
        source: 'telephony',
        dedupeKey: key,
        firmId: crm.alpha.firmId,
      });
      expect(again).toEqual({ recorded: false, reason: 'duplicate' });

      const { rows } = await database.session.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM funnel_facts WHERE workspace_id = $1 AND dedupe_key = $2',
        [seeded.alpha.workspaceId, key],
      );
      expect(rows[0]?.count).toBe('1');
    });

    it('records the actor the context names', async () => {
      const key = `actor-${randomUUID()}`;
      await recordFunnelFact(assignee, { kind: 'recorder.placed', source: 'telephony', dedupeKey: key, firmId: crm.alpha.firmId });
      const { rows } = await database.session.query<{ actor_kind: string; actor_user_id: string | null }>(
        'SELECT actor_kind, actor_user_id FROM funnel_facts WHERE workspace_id = $1 AND dedupe_key = $2',
        [seeded.alpha.workspaceId, key],
      );
      expect(rows[0]).toEqual({ actor_kind: 'user', actor_user_id: assigneeUserId });
    });

    it('refuses a bad kind and a bad source before any insert', async () => {
      const badKind = `bad-kind-${randomUUID()}`;
      expect(
        await recordFunnelFact(admin, { kind: 'Firm Created', source: 'crm', dedupeKey: badKind }),
      ).toEqual({ recorded: false, reason: 'invalid_kind' });
      // A kind with four parts is outside the shape too, so the dictionary is not the
      // only thing standing between a typo and a dashboard key.
      expect(
        await recordFunnelFact(admin, { kind: 'a.b.c.d', source: 'crm', dedupeKey: badKind }),
      ).toEqual({ recorded: false, reason: 'invalid_kind' });

      const badSource = `bad-source-${randomUUID()}`;
      expect(
        await recordFunnelFact(admin, { kind: 'firm.created', source: 'CRM', dedupeKey: badSource }),
      ).toEqual({ recorded: false, reason: 'invalid_source' });

      // Nothing was written: the refusal happens before the statement, so the
      // caller's transaction is alive and a constraint never fired.
      const { rows } = await database.session.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM funnel_facts WHERE workspace_id = $1 AND dedupe_key = ANY($2::text[])',
        [seeded.alpha.workspaceId, [badKind, badSource]],
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('records a kind the v1 dictionary does not have, because the kind is open', async () => {
      const key = `open-kind-${randomUUID()}`;
      expect(isFunnelFactKind('widget.frobbed')).toBe(false);
      expect(await recordFunnelFact(admin, { kind: 'widget.frobbed', source: 'crm', dedupeKey: key })).toMatchObject({
        recorded: true,
      });
    });

    it('keeps the v1 dictionary inside the shape the database enforces', () => {
      for (const kind of FUNNEL_FACT_KINDS) expect(isFunnelFactKind(kind), kind).toBe(true);
      expect(FUNNEL_FACT_KINDS).toContain('firm.created');
    });
  });

  // ------------------------------------------------------------------ the read
  describe('the read', () => {
    beforeAll(async () => {
      // Two facts on the assignee's firm of one kind (so a firm counts once), one on
      // the colleague's, one with no firm at all, one outside the window, and one in
      // the other workspace.
      const facts: readonly {
        kind: string;
        firmId: string | null;
        at: string;
        workspaceId: string;
        key: string;
      }[] = [
        { kind: 'call.placed', firmId: crm.alpha.firmId, at: '2026-09-10T10:00:00.000Z', workspaceId: seeded.alpha.workspaceId, key: 'read-a1' },
        { kind: 'call.placed', firmId: crm.alpha.firmId, at: '2026-09-11T10:00:00.000Z', workspaceId: seeded.alpha.workspaceId, key: 'read-a2' },
        { kind: 'call.connected', firmId: crm.alpha.firmId, at: '2026-09-12T10:00:00.000Z', workspaceId: seeded.alpha.workspaceId, key: 'read-a3' },
        { kind: 'call.placed', firmId: colleagueFirmId, at: '2026-09-13T10:00:00.000Z', workspaceId: seeded.alpha.workspaceId, key: 'read-b1' },
        { kind: 'demo.started', firmId: null, at: '2026-09-14T10:00:00.000Z', workspaceId: seeded.alpha.workspaceId, key: 'read-w1' },
        // The boundary: `to` is exclusive, `from` is inclusive.
        { kind: 'call.placed', firmId: crm.alpha.firmId, at: '2026-10-01T00:00:00.000Z', workspaceId: seeded.alpha.workspaceId, key: 'read-after' },
        { kind: 'call.placed', firmId: crm.alpha.firmId, at: '2026-09-01T00:00:00.000Z', workspaceId: seeded.alpha.workspaceId, key: 'read-at-from' },
        { kind: 'call.placed', firmId: crm.beta.firmId, at: '2026-09-15T10:00:00.000Z', workspaceId: seeded.beta.workspaceId, key: 'read-beta' },
      ];
      for (const fact of facts) {
        await database.session.query(
          `INSERT INTO funnel_facts (workspace_id, kind, firm_id, dedupe_key, source, actor_kind, occurred_at)
           VALUES ($1, $2, $3, $4, 'crm', 'system', $5::timestamptz)`,
          [fact.workspaceId, fact.kind, fact.firmId, fact.key, fact.at],
        );
      }
    });

    const countFor = (rows: readonly { key: string; count: number }[], key: string): number =>
      rows.find(row => row.key === key)?.count ?? 0;

    it('gives an admin the whole workspace, firm-less facts included', async () => {
      const answer = await funnelFacts(admin, WINDOW, WORKSPACE);
      expect(answer.available).toBe(true);
      // Three `call.placed` inside the window on alpha's firms, plus the one at the
      // inclusive `from` boundary; the one at `to` is outside.
      expect(countFor(answer.byKind, 'call.placed')).toBe(4);
      expect(countFor(answer.byKind, 'demo.started')).toBe(1);
      // A firm counts once per kind however many facts it has.
      expect(countFor(answer.firmsByKind, 'call.placed')).toBe(2);
      // The firm-less kind has no firm to count, so it is not in `firmsByKind`.
      expect(answer.firmsByKind.map(row => row.key)).not.toContain('demo.started');
      expect(answer.uniqueFirms).toBe(2);
      expect(answer.firmsInScope).toBeGreaterThan(0);
    });

    it('gives a salesperson their own firm and no firm-less fact', async () => {
      const answer = await funnelFacts(assignee, WINDOW, { onlyAssignedTo: assigneeUserId });
      expect(countFor(answer.byKind, 'call.placed')).toBe(3);
      expect(countFor(answer.byKind, 'call.connected')).toBe(1);
      // The workspace's own fact is the workspace's, and a salesperson does not see
      // the workspace.
      expect(answer.byKind.map(row => row.key)).not.toContain('demo.started');
      expect(answer.uniqueFirms).toBe(1);
      expect(answer.firmsInScope).toBe(1);

      const theirs = await funnelFacts(colleague, WINDOW, { onlyAssignedTo: colleagueUserId });
      expect(countFor(theirs.byKind, 'call.placed')).toBe(1);
      expect(countFor(theirs.byKind, 'call.connected')).toBe(0);
      expect(theirs.uniqueFirms).toBe(1);
    });

    it('gives the other workspace none of it', async () => {
      const answer = await funnelFacts(betaAdmin, WINDOW, WORKSPACE);
      expect(countFor(answer.byKind, 'call.placed')).toBe(1);
      expect(countFor(answer.byKind, 'call.connected')).toBe(0);
      expect(countFor(answer.byKind, 'demo.started')).toBe(0);
      expect(answer.uniqueFirms).toBe(1);
    });

    it('is inclusive at `from` and exclusive at `to`', async () => {
      const atFrom = await funnelFacts(admin, { from: '2026-09-01T00:00:00.000Z', to: '2026-09-01T00:00:00.001Z' }, WORKSPACE);
      expect(countFor(atFrom.byKind, 'call.placed')).toBe(1);

      const atTo = await funnelFacts(admin, { from: '2026-09-30T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }, WORKSPACE);
      expect(countFor(atTo.byKind, 'call.placed')).toBe(0);

      const past = await funnelFacts(admin, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' }, WORKSPACE);
      expect(countFor(past.byKind, 'call.placed')).toBe(1);
    });

    it('names kinds and never a firm', async () => {
      const answer = await funnelFacts(admin, WINDOW, WORKSPACE);
      const rendered = JSON.stringify(answer);
      expect(rendered).not.toContain('Northwind');
      expect(rendered).not.toContain('Southwind');
      expect(rendered).not.toContain(crm.alpha.firmId);
    });
  });
});
