import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { QueryOutcome, QueryResultRowLike, SessionQueryable } from '../../db/queryable.ts';
import {
  repositoryContext,
  workspaceScope,
  type RepositoryContext,
  type WorkspaceScope,
} from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { createContact } from '../../crm/contacts.ts';
import { recordFunnelFact } from '../../funnel/facts.ts';
import { readFirmForActor } from '../../crm/dto.ts';
import { recordEvidence } from '../../crm/evidence.ts';
import { createFirm, reassignFirm, resolveZoneForFirm, updateFirm } from '../../crm/firms.ts';
import { mergeFirms } from '../../crm/merges.ts';
import { changeStage, reopenOpportunity } from '../../crm/pipeline.ts';
import { addEmailRoute, addPhoneRoute, retireRoute, verifyRoute } from '../../crm/routes.ts';

/**
 * The CRM commands against a real PostgreSQL.
 *
 * Appendix G 7 is the spine of this file: "Two salespeople and one assigned firm:
 * every mutation and sensitive read by the other is refused, including concurrent
 * reassignment." Appendix G 37 is the other half: "Firm/contact merge preserves
 * suppressions, correspondence, opportunity history, aliases, and uniqueness under
 * concurrent research enrichment."
 *
 * Every command runs in the caller's transaction, so the concurrency cases below open
 * two real `app_runtime` sessions and let them contend on the database rather than on
 * a mock.
 */
describe('CRM commands', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;

  /** The assigned salesperson's scope. */
  let assignee: WorkspaceScope;
  /** Another salesperson in the same workspace, assigned nothing. */
  let stranger: WorkspaceScope;
  let admin: WorkspaceScope;
  let strangerUserId: string;

  const contextOn = (db: SessionQueryable, scope: WorkspaceScope): RepositoryContext =>
    repositoryContext(scope, db);

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);

    // A second salesperson in alpha, so "the other salesperson" is a real membership
    // rather than an absent one: the refusal must be about assignment, not membership.
    const user = await session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-stranger', 'stranger@example.test', 'Stranger') RETURNING id",
    );
    strangerUserId = user.rows[0]?.id ?? '';
    await session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [seeded.alpha.workspaceId, strangerUserId],
    );

    assignee = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.salesperson.userId,
      role: 'salesperson',
    });
    stranger = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: strangerUserId,
      role: 'salesperson',
    });
    admin = workspaceScope(seeded.alpha.workspaceId, {
      kind: 'user',
      userId: seeded.alpha.admin.userId,
      role: 'admin',
    });
  });

  afterAll(async () => {
    await database.drop();
  });

  /** Run `work` in its own transaction on a fresh app_runtime session, then roll back. */
  const inRolledBackTransaction = async <T>(
    scope: WorkspaceScope,
    work: (context: RepositoryContext) => Promise<T>,
  ): Promise<T> => {
    const other = await database.appRuntimeSession();
    await other.query('BEGIN');
    try {
      return await work(contextOn(other, scope));
    } finally {
      await other.query('ROLLBACK');
    }
  };

  // ---------------------------------------------------------- Appendix G 7
  describe('two salespeople and one assigned firm (Appendix G 7)', () => {
    it('refuses every mutation by the salesperson the firm is not assigned to', async () => {
      const refusals = await inRolledBackTransaction(stranger, async context => [
        await updateFirm(context, { firmId: crm.alpha.firmId, patch: { name: 'Renamed' } }),
        await createContact(context, { firmId: crm.alpha.firmId, fullName: 'Intruder' }),
        await addPhoneRoute(context, {
          firmId: crm.alpha.firmId,
          e164: '+14015550166',
          source: 'salesperson',
        }),
        await addEmailRoute(context, {
          firmId: crm.alpha.firmId,
          address: 'intruder@northwind.example.test',
          source: 'salesperson',
        }),
        await recordEvidence(context, {
          firmId: crm.alpha.firmId,
          provider: 'places',
          sourceReference: 'ref-1',
          contentHash: 'a'.repeat(64),
        }),
        await changeStage(context, {
          opportunityId: crm.alpha.opportunityId,
          toStageKey: 'contacting',
        }),
        await reassignFirm(context, { firmId: crm.alpha.firmId, toUserId: strangerUserId }),
      ]);
      for (const refusal of refusals) {
        expect(refusal).toMatchObject({ ok: false, reason: 'not_assigned' });
      }
    });

    it('refuses the other salesperson every sensitive read and permits the identity read', async () => {
      const redacted = await readFirmForActor(contextOn(session, stranger), { firmId: crm.alpha.firmId });
      expect(redacted).toMatchObject({ ok: true });
      if (redacted.ok) {
        expect(redacted.value.visibility).toBe('any_active_member');
        expect(redacted.value.firm).not.toHaveProperty('contacts');
        expect(redacted.value.firm).not.toHaveProperty('notes');
        expect(redacted.value.firm.name).toBe(crm.collidingFirmName);
      }

      const full = await readFirmForActor(contextOn(session, assignee), { firmId: crm.alpha.firmId });
      expect(full).toMatchObject({ ok: true });
      if (full.ok) {
        expect(full.value.visibility).toBe('assigned_or_admin');
        expect(full.value.firm).toHaveProperty('contacts');
      }
    });

    it('lets the assigned salesperson and an admin mutate', async () => {
      const byAssignee = await inRolledBackTransaction(
        assignee,
        async context => await updateFirm(context, { firmId: crm.alpha.firmId, patch: { name: 'Renamed' } }),
      );
      expect(byAssignee).toMatchObject({ ok: true });

      const byAdmin = await inRolledBackTransaction(
        admin,
        async context => await updateFirm(context, { firmId: crm.alpha.firmId, patch: { website: 'https://renamed.example.test' } }),
      );
      expect(byAdmin).toMatchObject({ ok: true });
    });

    it('refuses the former assignee the moment a concurrent reassignment commits', async () => {
      const reassigning = await database.appRuntimeSession();
      const mutating = await database.appRuntimeSession();

      try {
        await reassigning.query('BEGIN');
        const reassigned = await reassignFirm(contextOn(reassigning, admin), {
          firmId: crm.alpha.firmId,
          toUserId: strangerUserId,
          reason: 'territory change',
        });
        expect(reassigned).toMatchObject({ ok: true });

        // The former assignee's mutation starts while the reassignment is uncommitted.
        // It blocks on the firm's row lock rather than reading the stale assignee.
        await mutating.query('BEGIN');
        const blocked = updateFirm(contextOn(mutating, assignee), {
          firmId: crm.alpha.firmId,
          patch: { name: 'Renamed by the former owner' },
        });

        await reassigning.query('COMMIT');
        expect(await blocked).toMatchObject({ ok: false, reason: 'not_assigned' });
      } finally {
        // A failed assertion must not leave a row lock behind: every later test in
        // this file touches the same firm, and they would all time out instead of
        // reporting the one thing that actually broke.
        await mutating.query('ROLLBACK');
        await reassigning.query('ROLLBACK');
      }

      // Put the assignment back for the rest of the file.
      await session.query('UPDATE firms SET assigned_user_id = $3 WHERE workspace_id = $1 AND id = $2', [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
        seeded.alpha.salesperson.userId,
      ]);
      await session.query(
        "UPDATE active_holds SET released_at = now() WHERE workspace_id = $1 AND reason_code = 'reassignment' AND released_at IS NULL",
        [seeded.alpha.workspaceId],
      );
    });

    it('records the reassignment hold, the transfer hook and the audit event in one transaction', async () => {
      await inRolledBackTransaction(admin, async context => {
        const outcome = await reassignFirm(context, {
          firmId: crm.alpha.firmId,
          toUserId: strangerUserId,
          reason: 'territory change',
        });
        expect(outcome).toMatchObject({ ok: true });
        if (!outcome.ok) return;
        const { holdId } = outcome.value;

        const holds = await context.db.query<{ scope_key: string; blocked_action_kinds: string[] }>(
          'SELECT scope_key, blocked_action_kinds FROM active_holds WHERE workspace_id = $1 AND id = $2',
          [seeded.alpha.workspaceId, holdId],
        );
        expect(holds.rows).toHaveLength(1);
        expect(holds.rows[0]?.scope_key).toBe(crm.alpha.firmId);
        expect(holds.rows[0]?.blocked_action_kinds).toContain('email_send');

        // The transfer hook and the audit event are in the same transaction as the
        // assignee change; they are matched by this reassignment's own hold id, so an
        // earlier committed reassignment in this file cannot make the count agree by
        // accident.
        const events = await context.db.query<{ event_kind: string }>(
          `SELECT event_kind FROM crm_domain_events
            WHERE workspace_id = $1 AND event_kind = 'firm.reassigned' AND dedupe_key = $2`,
          [seeded.alpha.workspaceId, `${crm.alpha.firmId}:${holdId}`],
        );
        expect(events.rows).toHaveLength(1);

        const audits = await context.db.query<{ detail: { holdId?: string; toUserId?: string } }>(
          `SELECT detail FROM audit_events
            WHERE workspace_id = $1 AND action = 'firm.reassigned' AND subject_id = $2
            ORDER BY occurred_at DESC LIMIT 1`,
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        expect(audits.rows[0]?.detail.toUserId).toBe(strangerUserId);
      });
    });
  });

  // ------------------------------------------------------------- pipeline
  describe('stage changes', () => {
    it('writes the stage and its append-only event in one transaction', async () => {
      await inRolledBackTransaction(assignee, async context => {
        const moved = await changeStage(context, {
          opportunityId: crm.alpha.opportunityId,
          toStageKey: 'contacting',
        });
        expect(moved).toMatchObject({ ok: true });
        const { rows } = await context.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM opportunity_stage_events WHERE workspace_id = $1 AND opportunity_id = $2',
          [seeded.alpha.workspaceId, crm.alpha.opportunityId],
        );
        expect(Number(rows[0]?.count)).toBe(2);
      });
    });

    it('refuses Lost without a reason and accepts it with one', async () => {
      await inRolledBackTransaction(assignee, async context => {
        expect(
          await changeStage(context, { opportunityId: crm.alpha.opportunityId, toStageKey: 'lost' }),
        ).toMatchObject({ ok: false, reason: 'lost_reason_required' });
        expect(
          await changeStage(context, {
            opportunityId: crm.alpha.opportunityId,
            toStageKey: 'lost',
            reason: 'chose a competitor',
          }),
        ).toMatchObject({ ok: true });
      });
    });

    it('raises the terminal-stop signal the sequences lane subscribes to', async () => {
      await inRolledBackTransaction(assignee, async context => {
        await changeStage(context, {
          opportunityId: crm.alpha.opportunityId,
          toStageKey: 'won',
        });
        const { rows } = await context.db.query<{ event_kind: string; opportunity_id: string }>(
          "SELECT event_kind, opportunity_id FROM crm_domain_events WHERE workspace_id = $1 AND event_kind = 'opportunity.terminal_stop'",
          [seeded.alpha.workspaceId],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.opportunity_id).toBe(crm.alpha.opportunityId);
      });
    });

    it('reopens as an explicit command that never restarts automation', async () => {
      await inRolledBackTransaction(assignee, async context => {
        await changeStage(context, {
          opportunityId: crm.alpha.opportunityId,
          toStageKey: 'won',
        });
        const reopened = await reopenOpportunity(context, {
          firmId: crm.alpha.firmId,
          reason: 'the buyer came back',
        });
        expect(reopened).toMatchObject({ ok: true });
        if (!reopened.ok) return;
        const { rows } = await context.db.query<{ control_mode: string; status: string }>(
          'SELECT control_mode, status FROM opportunities WHERE workspace_id = $1 AND id = $2',
          [seeded.alpha.workspaceId, reopened.value.opportunityId],
        );
        expect(rows[0]).toMatchObject({ control_mode: 'manual', status: 'open' });
      });
    });

    it('refuses a reopen while an open opportunity already exists', async () => {
      await inRolledBackTransaction(assignee, async context => {
        expect(await reopenOpportunity(context, { firmId: crm.alpha.firmId, reason: 'again' })).toMatchObject({
          ok: false,
          reason: 'opportunity_open_exists',
        });
      });
    });
  });

  // --------------------------------------------------------------- routes
  describe('routes', () => {
    it('adds a phone number usable on entry, with the evidence the CHECK asks for, and a failed one as invalid', async () => {
      await inRolledBackTransaction(assignee, async context => {
        // Wave 2 (S4.4): no confirm step, whatever the source said about its confidence.
        const entered = await addPhoneRoute(context, {
          firmId: crm.alpha.firmId,
          e164: '+14015550155',
          source: 'research_provider',
          associationConfidence: 0.4,
        });
        expect(entered).toMatchObject({ ok: true });
        if (!entered.ok) return;
        expect(entered.value).toMatchObject({
          eligibility: 'usable',
          technical_validation: 'passed',
          eligibility_policy_version: 'phone-on-entry.1',
        });
        expect(Number(entered.value.association_confidence)).toBe(0.4);

        const bare = await addPhoneRoute(context, { firmId: crm.alpha.firmId, e164: '+14015550156', source: 'import' });
        expect(bare.ok && [bare.value.eligibility, Number(bare.value.association_confidence)]).toEqual(['usable', 1]);

        // A test that says the line is dead still wins: a failure is a new retrieval.
        const failed = await verifyRoute(context, {
          routeKind: 'phone',
          routeId: entered.value.id,
          technicalValidation: 'failed',
        });
        expect(failed.ok && failed.value.eligibility).toBe('invalid');
        expect(failed.ok && failed.value.version).toBe(entered.value.version + 1);
      });
    });

    it('retires a route and bumps its version, so a stale card cannot dial it', async () => {
      await inRolledBackTransaction(assignee, async context => {
        const added = await addPhoneRoute(context, {
          firmId: crm.alpha.firmId,
          e164: '+14015550177',
          source: 'salesperson',
          associationConfidence: 0.99,
          technicalValidation: 'passed',
        });
        expect(added).toMatchObject({ ok: true });
        if (!added.ok) return;
        const retired = await retireRoute(context, {
          routeKind: 'phone',
          routeId: added.value.id,
          reason: 'wrong number',
        });
        expect(retired).toMatchObject({ ok: true });
        if (!retired.ok) return;
        expect(retired.value.eligibility).toBe('retired');
        expect(retired.value.version).toBeGreaterThan(added.value.version);
      });
    });
  });

  // --------------------------------------------------------------- funnel
  describe('the top of the funnel', () => {
    it('records exactly one firm.created fact, in the transaction that created the firm', async () => {
      await inRolledBackTransaction(admin, async context => {
        const created = await createFirm(context, {
          name: 'Funnel Test Firm',
          assignedUserId: seeded.alpha.salesperson.userId,
        });
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) return;

        const { rows } = await context.db.query<{
          kind: string;
          source: string;
          dedupe_key: string;
          firm_id: string;
          detail: unknown;
        }>(
          'SELECT kind, source, dedupe_key, firm_id, detail FROM funnel_facts WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, created.value.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({
          kind: 'firm.created',
          source: 'crm',
          // The key is the firm's own id, so a re-run handler writes one fact.
          dedupe_key: created.value.id,
          firm_id: created.value.id,
          detail: { assigned: true },
        });
      });
    });

    it('leaves no fact behind when the transaction that created the firm rolls back', async () => {
      let firmId = '';
      await inRolledBackTransaction(admin, async context => {
        const created = await createFirm(context, { name: 'Rolled Back Test Firm' });
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) return;
        firmId = created.value.id;
      });
      const { rows } = await session.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM funnel_facts WHERE workspace_id = $1 AND firm_id = $2',
        [seeded.alpha.workspaceId, firmId],
      );
      expect(rows[0]?.count).toBe('0');
    });
  });

  // ------------------------------------------------- the research enqueue
  describe('the research enqueue a new firm triggers', () => {
    it('creates the firm and the funnel fact even when the enqueue throws', async () => {
      await inRolledBackTransaction(admin, async context => {
        // Research being off already refused without stopping anything. An exception
        // did not: a jobs table that would not take the row would have failed the
        // whole command, which is the tail wagging the dog. The savepoint is the
        // difference between "the run was not queued" and "the firm was not created".
        const failing = {
          ...context,
          db: {
            query: async <Row extends QueryResultRowLike>(
              text: string,
              values?: readonly unknown[],
            ): Promise<QueryOutcome<Row>> => {
              if (/INSERT INTO jobs/iu.test(text)) {
                throw Object.assign(new Error('jobs is unavailable'), { code: '40001' });
              }
              return await context.db.query<Row>(text, values);
            },
          },
        };

        const created = await createFirm(failing, { name: 'Enqueue Failure Test Firm' });
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) return;

        // The firm exists, and so does its funnel fact: everything written before the
        // enqueue survived the rollback of the enqueue alone.
        const rows = await context.db.query<{ firms: string; facts: string; jobs: string }>(
          `SELECT (SELECT count(*) FROM firms WHERE workspace_id = $1 AND id = $2) AS firms,
                  (SELECT count(*) FROM funnel_facts
                    WHERE workspace_id = $1 AND firm_id = $2 AND kind = 'firm.created') AS facts,
                  (SELECT count(*) FROM jobs
                    WHERE workspace_id = $1 AND kind = 'research.firm'
                      AND payload->>'firmId' = $2::text) AS jobs`,
          [seeded.alpha.workspaceId, created.value.id],
        );
        // That this read succeeded at all is the other half of the point: a statement
        // that failed inside a transaction poisons it, and only the rolled-back
        // savepoint leaves the transaction able to run anything afterwards.
        expect(rows.rows[0]).toEqual({ firms: '1', facts: '1', jobs: '0' });
      });
    });
  });

  // ----------------------------------------------------------------- zone
  describe('firm time zone', () => {
    it('records the resolved zone with its confidence, source and rule version', async () => {
      await inRolledBackTransaction(admin, async context => {
        const created = await createFirm(context, {
          name: 'Zoned Test Firm',
          regionCode: 'RI',
          postalCode: '02903',
          assignedUserId: seeded.alpha.salesperson.userId,
        });
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) return;
        const resolved = await resolveZoneForFirm(context, { firmId: created.value.id });
        expect(resolved).toMatchObject({ ok: true });
        if (!resolved.ok) return;
        expect(resolved.value).toMatchObject({
          timeZone: 'America/New_York',
          confidence: 'medium',
          source: 'state_default',
        });
      });
    });

    it('records that a multi-zone state with no postal data has no zone, which later blocks calling', async () => {
      await inRolledBackTransaction(admin, async context => {
        const created = await createFirm(context, {
          name: 'Unzoned Test Firm',
          regionCode: 'TX',
          assignedUserId: seeded.alpha.salesperson.userId,
        });
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) return;
        const resolved = await resolveZoneForFirm(context, { firmId: created.value.id });
        expect(resolved).toMatchObject({ ok: false, reason: 'zone_unresolved' });

        const { rows } = await context.db.query<{ time_zone: string | null; time_zone_unresolved_reason: string | null }>(
          'SELECT time_zone, time_zone_unresolved_reason FROM firms WHERE workspace_id = $1 AND id = $2',
          [seeded.alpha.workspaceId, created.value.id],
        );
        expect(rows[0]).toMatchObject({ time_zone: null, time_zone_unresolved_reason: 'state_spans_zones' });
      });
    });

    it('uses the firm postal code rather than the state shortcut in a multi-zone state', async () => {
      await inRolledBackTransaction(admin, async context => {
        const created = await createFirm(context, {
          name: 'El Paso Test Firm',
          regionCode: 'TX',
          postalCode: '79901',
          assignedUserId: seeded.alpha.salesperson.userId,
        });
        expect(created).toMatchObject({ ok: true });
        if (!created.ok) return;
        const resolved = await resolveZoneForFirm(context, { firmId: created.value.id });
        expect(resolved).toMatchObject({ ok: true });
        if (!resolved.ok) return;
        expect(resolved.value).toMatchObject({ timeZone: 'America/Denver', source: 'postal', confidence: 'high' });
      });
    });
  });

  // --------------------------------------------------------- Appendix G 37
  describe('merges (Appendix G 37)', () => {
    it('carries lane R’s rows, and a judgment on both sides does not fail the merge', async () => {
      await inRolledBackTransaction(admin, async context => {
        const duplicate = await createFirm(context, { name: 'Northwind Test Holdings (researched dup)' });
        expect(duplicate).toMatchObject({ ok: true });
        if (!duplicate.ok) return;

        /** One completed run, one fact, one judgment naming a contact, and one link. */
        const research = async (firmId: string, url: string, contactName: string): Promise<void> => {
          const contact = await createContact(context, { firmId, fullName: contactName, title: 'Owner' });
          expect(contact).toMatchObject({ ok: true });
          if (!contact.ok) return;
          const run = await context.db.query<{ id: string }>(
            `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome)
             VALUES ($1, $2, 1, 'sweep', now(), 'completed') RETURNING id`,
            [seeded.alpha.workspaceId, firmId],
          );
          const runId = run.rows[0]?.id ?? '';
          const evidence = await recordEvidence(context, {
            firmId,
            provider: 'company_page',
            sourceReference: url,
            contentHash: createHash('sha256').update(url).digest('hex'),
          });
          expect(evidence).toMatchObject({ ok: true });
          if (!evidence.ok) return;
          await context.db.query(
            `INSERT INTO firm_facts (workspace_id, firm_id, run_id, evidence_id, key, block_id, quote, retrieved_at)
             VALUES ($1, $2, $3, $4, 'target_fit', 'b1', 'We manage property for owners.', now())`,
            [seeded.alpha.workspaceId, firmId, runId, evidence.value.id],
          );
          await context.db.query(
            `INSERT INTO firm_judgments
               (workspace_id, firm_id, run_id, fit, problem_evidence, timing, reachability, call_first, likely_contact_id)
             VALUES ($1, $2, $3, 'yes', 'unknown', 'unknown', 'yes', true, $4)`,
            [seeded.alpha.workspaceId, firmId, runId, contact.value.id],
          );
          await context.db.query(
            `INSERT INTO firm_links (workspace_id, firm_id, url, added_by_user_id)
             VALUES ($1, $2, $3, $4)`,
            [seeded.alpha.workspaceId, firmId, url, seeded.alpha.admin.userId],
          );
        };

        await research(crm.alpha.firmId, 'https://alpha.example.test/about', 'Target Person');
        await research(duplicate.value.id, 'https://dup.example.test/about', 'Source Person');

        // Both firms have a judgment naming one of their own contacts, and
        // `likely_contact_id` carries `(workspace, contact, firm)` ON UPDATE CASCADE —
        // so moving the contacts would have rewritten the source judgment's firm_id
        // onto the target's and violated the primary key. That is the merge this test
        // exists for.
        const merged = await mergeFirms(context, {
          sourceFirmId: duplicate.value.id,
          targetFirmId: crm.alpha.firmId,
        });
        expect(merged).toMatchObject({ ok: true });

        const judgments = await context.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM firm_judgments WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        expect(Number(judgments.rows[0]?.count)).toBe(1);

        // The links are decisions about the surviving firm, so the target has both.
        const links = await context.db.query<{ url: string }>(
          'SELECT url FROM firm_links WHERE workspace_id = $1 AND firm_id = $2 ORDER BY url',
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        expect(links.rows.map(row => row.url)).toEqual([
          'https://alpha.example.test/about',
          'https://dup.example.test/about',
        ]);
        const left = await context.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM firm_links WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, duplicate.value.id],
        );
        expect(Number(left.rows[0]?.count)).toBe(0);

        // The runs and the facts stay where they were read, as the domain events do: a
        // page read for another firm is not provenance for this one — and the evidence
        // row a fact cites stays with it, rather than being carried to the target by the
        // generic evidence move and leaving the fact quoting a page the other firm is
        // now said to have published.
        const history = await context.db.query<{ runs: string; facts: string; evidence: string }>(
          `SELECT (SELECT count(*) FROM research_runs WHERE workspace_id = $1 AND firm_id = $2) AS runs,
                  (SELECT count(*) FROM firm_facts WHERE workspace_id = $1 AND firm_id = $2) AS facts,
                  (SELECT count(*) FROM firm_facts ff
                     JOIN evidence_items e ON e.workspace_id = ff.workspace_id AND e.id = ff.evidence_id
                    WHERE ff.workspace_id = $1 AND ff.firm_id = $2 AND e.firm_id = ff.firm_id) AS evidence`,
          [seeded.alpha.workspaceId, duplicate.value.id],
        );
        expect(history.rows[0]).toEqual({ runs: '1', facts: '1', evidence: '1' });
        // And every fact in the workspace, on either firm, still cites evidence that
        // sits on the same firm it does.
        const split = await context.db.query<{ count: string }>(
          `SELECT count(*) AS count FROM firm_facts ff
             JOIN evidence_items e ON e.workspace_id = ff.workspace_id AND e.id = ff.evidence_id
            WHERE ff.workspace_id = $1 AND e.firm_id <> ff.firm_id`,
          [seeded.alpha.workspaceId],
        );
        expect(Number(split.rows[0]?.count)).toBe(0);

        // And a fresh run is queued, so the target's judgment is rebuilt from the
        // target's own pages rather than inherited.
        const jobs = await context.db.query<{ count: string }>(
          "SELECT count(*) AS count FROM jobs WHERE workspace_id = $1 AND kind = 'research.firm'",
          [seeded.alpha.workspaceId],
        );
        expect(Number(jobs.rows[0]?.count)).toBeGreaterThan(0);
      });
    });

    it('moves the source’s judgment when the target has none', async () => {
      await inRolledBackTransaction(admin, async context => {
        const duplicate = await createFirm(context, { name: 'Northwind Test Holdings (one judgment)' });
        if (!duplicate.ok) return;
        const contact = await createContact(context, {
          firmId: duplicate.value.id,
          fullName: 'Source Person',
          title: 'Owner',
        });
        if (!contact.ok) return;
        const run = await context.db.query<{ id: string }>(
          `INSERT INTO research_runs (workspace_id, firm_id, revision, trigger, completed_at, outcome)
           VALUES ($1, $2, 1, 'sweep', now(), 'completed') RETURNING id`,
          [seeded.alpha.workspaceId, duplicate.value.id],
        );
        await context.db.query(
          `INSERT INTO firm_judgments
             (workspace_id, firm_id, run_id, fit, problem_evidence, timing, reachability, call_first, likely_contact_id)
           VALUES ($1, $2, $3, 'yes', 'unknown', 'unknown', 'yes', true, $4)`,
          [seeded.alpha.workspaceId, duplicate.value.id, run.rows[0]?.id ?? '', contact.value.id],
        );

        expect(
          await mergeFirms(context, { sourceFirmId: duplicate.value.id, targetFirmId: crm.alpha.firmId }),
        ).toMatchObject({ ok: true });

        const moved = await context.db.query<{ fit: string; likely_contact_id: string | null }>(
          'SELECT fit, likely_contact_id FROM firm_judgments WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        // Moved, and the contact reference cleared: the contact had not moved yet, and
        // the composite key would have refused a row naming a contact at another firm.
        expect(moved.rows[0]).toEqual({ fit: 'yes', likely_contact_id: null });
      });
    });

    it('preserves suppressions, evidence, stage events, aliases and external ids', async () => {
      await inRolledBackTransaction(admin, async context => {
        const duplicate = await createFirm(context, {
          name: 'Northwind Test Holdings (dup)',
          externalId: 'legacy-firm-7',
          assignedUserId: seeded.alpha.salesperson.userId,
        });
        expect(duplicate).toMatchObject({ ok: true });
        if (!duplicate.ok) return;

        await recordEvidence(context, {
          firmId: duplicate.value.id,
          provider: 'places',
          sourceReference: 'dup-ref',
          contentHash: 'b'.repeat(64),
        });
        await context.db.query(
          `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source)
           VALUES ($1, $2, 'firm', $3, 'v1', 'prospect_do_not_call')`,
          [seeded.alpha.workspaceId, `dup-suppression-${duplicate.value.id}`, duplicate.value.id],
        );

        const merged = await mergeFirms(context, {
          sourceFirmId: duplicate.value.id,
          targetFirmId: crm.alpha.firmId,
        });
        expect(merged).toMatchObject({ ok: true });
        if (!merged.ok) return;

        const evidence = await context.db.query<{ count: string }>(
          'SELECT count(*) AS count FROM evidence_items WHERE workspace_id = $1 AND firm_id = $2',
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        expect(Number(evidence.rows[0]?.count)).toBeGreaterThan(0);

        const aliases = await context.db.query<{ alias_kind: string; alias_value: string }>(
          'SELECT alias_kind, alias_value FROM record_aliases WHERE workspace_id = $1 AND firm_id = $2 ORDER BY alias_kind, alias_value',
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        expect(aliases.rows.map(row => row.alias_value)).toContain('legacy-firm-7');
        expect(aliases.rows.map(row => row.alias_value)).toContain('Northwind Test Holdings (dup)');

        const suppressions = await context.db.query<{ canonical_key: string }>(
          "SELECT canonical_key FROM suppression_events WHERE workspace_id = $1 AND scope = 'firm' AND canonical_key = $2",
          [seeded.alpha.workspaceId, crm.alpha.firmId],
        );
        expect(suppressions.rows).toHaveLength(1);

        const source = await context.db.query<{ status: string; merged_into_firm_id: string }>(
          'SELECT status, merged_into_firm_id FROM firms WHERE workspace_id = $1 AND id = $2',
          [seeded.alpha.workspaceId, duplicate.value.id],
        );
        expect(source.rows[0]).toMatchObject({ status: 'merged', merged_into_firm_id: crm.alpha.firmId });

        // The merge's record is its audit event (record_merge_events has no writer since
        // wave 2; migration 0019 drops it).
        const audited = await context.db.query<{ subject_id: string }>(
          "SELECT subject_id FROM audit_events WHERE workspace_id = $1 AND action = 'firm.merged' AND detail->>'sourceFirmId' = $2",
          [seeded.alpha.workspaceId, duplicate.value.id],
        );
        expect(audited.rows).toEqual([{ subject_id: crm.alpha.firmId }]);
      });
    });

    it('returns conflicting canonical values for resolution rather than choosing one', async () => {
      await inRolledBackTransaction(admin, async context => {
        const duplicate = await createFirm(context, {
          name: 'Conflicting Test Firm',
          website: 'https://conflicting.example.test',
          assignedUserId: seeded.alpha.salesperson.userId,
        });
        if (!duplicate.ok) return;
        const merged = await mergeFirms(context, {
          sourceFirmId: duplicate.value.id,
          targetFirmId: crm.alpha.firmId,
        });
        expect(merged).toMatchObject({ ok: false, reason: 'merge_conflicts' });
        if (merged.ok) return;
        expect(merged.conflicts?.map(conflict => conflict.field)).toContain('website');
      });
    });

    it('serializes against concurrent research enrichment of the source firm', async () => {
      const enriching = await database.appRuntimeSession();
      const merging = await database.appRuntimeSession();

      const duplicate = await session.query<{ id: string }>(
        "INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, 'Raced Test Firm', $2) RETURNING id",
        [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
      );
      const duplicateId = duplicate.rows[0]?.id ?? '';

      try {
        // Research writes evidence against the source firm and has not committed.
        await enriching.query('BEGIN');
        await recordEvidence(contextOn(enriching, admin), {
          firmId: duplicateId,
          provider: 'places',
          sourceReference: 'raced-ref',
          contentHash: 'c'.repeat(64),
        });

        // The merge takes the source firm's row lock, so it cannot run past the
        // uncommitted enrichment and lose it.
        await merging.query('BEGIN');
        const pending = mergeFirms(contextOn(merging, admin), {
          sourceFirmId: duplicateId,
          targetFirmId: crm.alpha.firmId,
        });
        await enriching.query('COMMIT');
        expect(await pending).toMatchObject({ ok: true });

        const moved = await merging.query<{ count: string }>(
          'SELECT count(*) AS count FROM evidence_items WHERE workspace_id = $1 AND firm_id = $2 AND source_reference = $3',
          [seeded.alpha.workspaceId, crm.alpha.firmId, 'raced-ref'],
        );
        expect(Number(moved.rows[0]?.count)).toBe(1);
      } finally {
        await merging.query('ROLLBACK');
        await enriching.query('ROLLBACK');
      }
      await session.query('DELETE FROM evidence_items WHERE workspace_id = $1 AND firm_id = $2', [
        seeded.alpha.workspaceId,
        duplicateId,
      ]);
      await session.query('DELETE FROM firms WHERE workspace_id = $1 AND id = $2', [
        seeded.alpha.workspaceId,
        duplicateId,
      ]);
    });

    it('carries the source firm’s funnel facts to the target, and leaves the firm-only one behind', async () => {
      await inRolledBackTransaction(admin, async context => {
        const source = await createFirm(context, {
          name: 'Merged Funnel Test Firm',
          assignedUserId: seeded.alpha.salesperson.userId,
        });
        expect(source).toMatchObject({ ok: true });
        if (!source.ok) return;
        const sourceFirmId = source.value.id;

        const contact = await createContact(context, { firmId: sourceFirmId, fullName: 'Robin Placeholder' });
        expect(contact).toMatchObject({ ok: true });
        if (!contact.ok) return;
        const stage = await context.db.query<{ id: string }>(
          'SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1',
          [seeded.alpha.workspaceId],
        );
        const opportunity = await context.db.query<{ id: string }>(
          `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
           VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00') RETURNING id`,
          [seeded.alpha.workspaceId, sourceFirmId, stage.rows[0]?.id],
        );
        const opportunityId = opportunity.rows[0]?.id ?? '';

        // One fact per subject shape. A fact may not name both a contact and an
        // opportunity (`funnel_facts_one_child`), which is exactly what makes the
        // two cascades below independent of each other.
        await recordFunnelFact(context, {
          kind: 'call.placed',
          source: 'telephony',
          dedupeKey: `merge-contact-${sourceFirmId}`,
          firmId: sourceFirmId,
          contactId: contact.value.id,
        });
        await recordFunnelFact(context, {
          kind: 'offer.sent',
          source: 'offers',
          dedupeKey: `merge-opportunity-${sourceFirmId}`,
          firmId: sourceFirmId,
          opportunityId,
        });

        expect(
          await mergeFirms(context, { sourceFirmId, targetFirmId: crm.alpha.firmId }),
        ).toMatchObject({ ok: true });

        const { rows } = await context.db.query<{ dedupe_key: string; firm_id: string }>(
          `SELECT dedupe_key, firm_id FROM funnel_facts
            WHERE workspace_id = $1 AND dedupe_key = ANY($2::text[]) ORDER BY dedupe_key`,
          [
            seeded.alpha.workspaceId,
            [`merge-contact-${sourceFirmId}`, `merge-opportunity-${sourceFirmId}`, sourceFirmId],
          ],
        );
        const firmOf = (key: string): string | undefined => rows.find(row => row.dedupe_key === key)?.firm_id;
        // The two facts with a child follow their record to the target through
        // `ON UPDATE CASCADE` on the composite key.
        expect(firmOf(`merge-contact-${sourceFirmId}`)).toBe(crm.alpha.firmId);
        expect(firmOf(`merge-opportunity-${sourceFirmId}`)).toBe(crm.alpha.firmId);
        // The firm-only fact — `firm.created`, keyed by the firm's own id — stays on
        // the merged source row, as `crm_domain_events` do: the firm key does not
        // cascade, and the source is a merged record rather than a deleted one.
        expect(firmOf(sourceFirmId)).toBe(sourceFirmId);
      });
    });

    it('refuses a mutation of a firm that has already been merged away', async () => {
      await inRolledBackTransaction(admin, async context => {
        const duplicate = await createFirm(context, {
          name: 'Gone Test Firm',
          assignedUserId: seeded.alpha.salesperson.userId,
        });
        if (!duplicate.ok) return;
        await mergeFirms(context, { sourceFirmId: duplicate.value.id, targetFirmId: crm.alpha.firmId });
        expect(
          await updateFirm(context, { firmId: duplicate.value.id, patch: { name: 'Back from the dead' } }),
        ).toMatchObject({ ok: false, reason: 'firm_merged' });
      });
    });
  });

  // ----------------------------------------------------- two workspaces again
  it('refuses a command that names a firm in the other workspace', async () => {
    await inRolledBackTransaction(assignee, async context => {
      expect(await updateFirm(context, { firmId: crm.beta.firmId, patch: { name: 'Crossed' } })).toMatchObject({
        ok: false,
        reason: 'firm_unknown',
      });
    });
  });
});
