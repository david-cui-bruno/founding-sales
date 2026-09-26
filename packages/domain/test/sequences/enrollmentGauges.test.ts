import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BlockedActionKind, HoldReasonCode } from '@fss/contracts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { openHold, releaseHold, type OpenHoldInput } from '../../policy/holds.ts';
import { openPause } from '../../policy/pauses.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { completeEnrollment, enrollContact, stopEnrollments } from '../../sequences/enrollments.ts';
import { CLOCK_CLEARING_HOLDS, completeStepExecution, runDueStepExecution } from '../../sequences/executions.ts';
import { EXPECTED_HOLD_REASONS, collectSequenceMetrics, countEnrollments } from '../../sequences/metrics.ts';
import { unavailableSendHandoff } from '../../sequences/sendHandoff.ts';
import { firstStageId } from '../db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedSequences, type SeededSequences } from './support/sequenceFixtures.ts';

/**
 * `ActiveEnrollments` and `HeldEnrollments` against a real PostgreSQL (specification
 * 4.3, 11.2, 13.3).
 *
 * The alarm is `IF(active > 0, held / active, 0) >= 1`, so the two numbers are one
 * claim — "every live enrollment is blocked by something nobody chose" — and each case
 * below is one way that claim can be true or false:
 *
 * * nothing enrolled is 0 and 0, published, so the alarm is OK and never fires;
 * * each hold kind that counts, at each scope a hold attaches at (enrollment, firm,
 *   opportunity, owner, workspace), plus long-hold review and a step the worker held
 *   with no hold row at all;
 * * each that does not: an administrator's pause, a Today delay, the send hand-off's
 *   hold when sending is switched off, and the four holds that clear with the clock;
 * * a hold on an action kind the enrollment's next step does not use, which does not
 *   block it until the cadence reaches that channel;
 * * completed and stopped enrollments, which are neither active nor held;
 * * two workspaces, summed, with no hold crossing between them.
 *
 * The firms, contacts and addresses are fictional (`example.test`), and nothing names a
 * person, an address or a number.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let sequences: SeededSequences;

type Slug = 'alpha' | 'beta';

interface Prospect {
  readonly workspace: Slug;
  readonly firmId: string;
  readonly contactId: string;
  readonly opportunityId: string;
  readonly enrollmentId: string;
}

let prospectCounter = 0;

const salesperson = (workspace: Slug): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded[workspace].workspaceId, {
      kind: 'user',
      userId: seeded[workspace].salesperson.userId,
      role: 'salesperson',
    }),
    database.session,
  );

const admin = (workspace: Slug): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded[workspace].workspaceId, {
      kind: 'user',
      userId: seeded[workspace].admin.userId,
      role: 'admin',
    }),
    database.session,
  );

const worker = (workspace: Slug): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded[workspace].workspaceId, { kind: 'system', component: 'worker' }),
    database.session,
  );

async function one(sql: string, values: readonly unknown[]): Promise<string> {
  const { rows } = await database.session.query<{ id: string }>(sql, values);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`the fixture returned no row: ${sql.slice(0, 60)}`);
  return id;
}

/**
 * A new firm, its contact, a usable route and an open opportunity, assigned to the
 * workspace's salesperson, and the contact enrolled in the published version. One firm
 * per prospect, because a firm has at most one open opportunity.
 */
async function enrolledProspect(workspace: Slug): Promise<Prospect> {
  prospectCounter += 1;
  const label = `gauge-${String(prospectCounter)}`;
  const workspaceId = seeded[workspace].workspaceId;
  const firmId = await one(
    `INSERT INTO firms (workspace_id, name, assigned_user_id, website, region_code, postal_code,
                        time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
     VALUES ($1, $2, $3, $4, 'RI', '02903', 'America/New_York', 'medium', 'state_default', 'firm-zone.1')
     RETURNING id`,
    [workspaceId, `Gauge Test Firm ${label}`, seeded[workspace].salesperson.userId, `https://${label}.example.test`],
  );
  const contactId = await one(
    "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Dana Example') RETURNING id",
    [workspaceId, firmId],
  );
  await database.session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility,
                                  eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'salesperson', now(), 0.950, 'passed', 'usable', 'route-policy.1')`,
    [workspaceId, firmId, contactId, `dana@${label}.example.test`],
  );
  const opportunityId = await one(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, now()) RETURNING id`,
    [workspaceId, firmId, await firstStageId(database.session, workspaceId)],
  );
  const enrolled = await enrollContact(salesperson(workspace), {
    sequenceVersionId: sequences[workspace].publishedVersionId,
    opportunityId,
    firmId,
    contactId,
  });
  if (!enrolled.ok) throw new Error(`the enrollment fixture was refused: ${enrolled.reason}`);
  return { workspace, firmId, contactId, opportunityId, enrollmentId: enrolled.value.enrollmentId };
}

/** Open a hold the way its lane does: a system actor, in the prospect's workspace. */
async function hold(workspace: Slug, input: Omit<OpenHoldInput, 'sourceEventKind'> & { readonly sourceEventKind?: string }): Promise<string> {
  return await openHold(worker(workspace), { sourceEventKind: 'g72.test', ...input });
}

/** Record on the prospect's unfinished step what the worker records when it holds one. */
async function holdStep(prospect: Prospect, reasonCode: HoldReasonCode): Promise<void> {
  const updated = await database.session.query(
    `UPDATE step_executions SET state = 'held', hold_reason_code = $3, updated_at = now()
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')`,
    [seeded[prospect.workspace].workspaceId, prospect.enrollmentId, reasonCode],
  );
  expect(updated.rowCount).toBe(1);
}

const counts = async (): Promise<{ readonly active: number; readonly held: number }> =>
  await countEnrollments(database.session);

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  sequences = await seedSequences(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.session.query('DELETE FROM step_execution_shifts');
  await database.session.query('DELETE FROM step_executions');
  await database.session.query('DELETE FROM sequence_enrollments');
  await database.session.query('DELETE FROM administrative_pauses');
  await database.session.query('DELETE FROM active_holds');
});

describe('with nothing enrolled', () => {
  it('publishes both gauges as 0, as a Count with no dimension, so the alarm reads 0 and not missing data', async () => {
    expect(await collectSequenceMetrics(database.session)).toEqual([
      { name: 'ActiveEnrollments', value: 0, unit: 'Count' },
      { name: 'HeldEnrollments', value: 0, unit: 'Count' },
    ]);
  });

  it('stays 0 and 0 under a restore hold, because a hold over no enrollment holds nothing', async () => {
    await hold('alpha', {
      scopeKind: 'workspace',
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ['email_send', 'call_task', 'dial_authorization', 'enrollment_advance', 'research'],
    });
    expect(await counts()).toEqual({ active: 0, held: 0 });
  });
});

describe('an enrollment that is waiting', () => {
  it('is active and not held', async () => {
    await enrolledProspect('alpha');
    expect(await counts()).toEqual({ active: 1, held: 0 });
  });
});

describe('the holds that count', () => {
  /**
   * Each case holds the target and leaves a bystander at another firm with its own
   * opportunity, so a hold matched at the wrong scope shows up as a wrong count. Both
   * belong to the one salesperson, so the owner-scoped hold holds both.
   */
  const cases: readonly {
    readonly name: string;
    readonly apply: (target: Prospect) => Promise<void>;
    readonly held: number;
  }[] = [
    {
      name: 'an enrollment-scoped missing-variables hold',
      apply: async target => {
        await hold('alpha', {
          scopeKind: 'enrollment',
          scopeKey: target.enrollmentId,
          reasonCode: 'missing_variables',
          blockedActionKinds: ['email_send'],
        });
      },
      held: 1,
    },
    {
      name: 'a firm-scoped send-unknown-terminal hold, as reconciliation opens it',
      apply: async target => {
        await hold('alpha', {
          scopeKind: 'firm',
          scopeKey: target.firmId,
          reasonCode: 'send_unknown_terminal',
          blockedActionKinds: ['email_send', 'enrollment_advance'],
        });
      },
      held: 1,
    },
    {
      name: 'a firm-scoped manual-suppression review',
      apply: async target => {
        await hold('alpha', {
          scopeKind: 'firm',
          scopeKey: target.firmId,
          reasonCode: 'manual_suppression_review',
          blockedActionKinds: ['email_send', 'call_task', 'dial_authorization', 'enrollment_advance'],
        });
      },
      held: 1,
    },
    {
      name: 'an opportunity-scoped uncertain-reply hold',
      apply: async target => {
        await hold('alpha', {
          scopeKind: 'opportunity',
          scopeKey: target.opportunityId,
          reasonCode: 'uncertain_reply',
          blockedActionKinds: ['email_send', 'call_task', 'enrollment_advance'],
        });
      },
      held: 1,
    },
    {
      name: 'an owner-scoped mailbox-health hold, which holds every enrollment of that owner',
      apply: async () => {
        await hold('alpha', {
          scopeKind: 'owner',
          scopeKey: seeded.alpha.salesperson.userId,
          reasonCode: 'mailbox_disconnected',
          blockedActionKinds: ['email_send', 'call_task', 'enrollment_advance'],
        });
      },
      held: 2,
    },
    {
      name: 'a workspace-scoped restore hold, which holds the whole workspace',
      apply: async () => {
        await hold('alpha', {
          scopeKind: 'workspace',
          reasonCode: 'restore_in_progress',
          blockedActionKinds: ['email_send', 'call_task', 'dial_authorization', 'enrollment_advance', 'research'],
        });
      },
      held: 2,
    },
    {
      name: 'a hold on enrollment advance alone, which blocks every channel',
      apply: async target => {
        await hold('alpha', {
          scopeKind: 'firm',
          scopeKey: target.firmId,
          reasonCode: 'long_hold_review',
          blockedActionKinds: ['enrollment_advance'],
        });
      },
      held: 1,
    },
    {
      name: 'long-hold review, which is the enrollment’s own state',
      apply: async target => {
        await database.session.query(
          `UPDATE sequence_enrollments SET state = 'review_required', review_union_milliseconds = $3
            WHERE workspace_id = $1 AND id = $2`,
          [seeded.alpha.workspaceId, target.enrollmentId, 8 * 24 * 60 * 60 * 1000],
        );
      },
      held: 1,
    },
    {
      name: 'a step the worker held with no hold row behind it (a missing route)',
      apply: async target => {
        await holdStep(target, 'route_missing');
      },
      held: 1,
    },
  ];

  for (const testCase of cases) {
    it(`counts ${testCase.name}`, async () => {
      const target = await enrolledProspect('alpha');
      await enrolledProspect('alpha');
      expect(await counts()).toEqual({ active: 2, held: 0 });
      await testCase.apply(target);
      expect(await counts()).toEqual({ active: 2, held: testCase.held });
    });
  }

  it('still counts a counted hold under an administrator’s pause: the pause does not make a restore expected', async () => {
    await enrolledProspect('alpha');
    const paused = await openPause(admin('alpha'), { scopeKind: 'all_automation' });
    expect(paused.ok).toBe(true);
    expect(await counts()).toEqual({ active: 1, held: 0 });
    await hold('alpha', {
      scopeKind: 'workspace',
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ['email_send', 'call_task', 'dial_authorization', 'enrollment_advance', 'research'],
    });
    expect(await counts()).toEqual({ active: 1, held: 1 });
  });

  it('stops counting a hold once it is released', async () => {
    const target = await enrolledProspect('alpha');
    const holdId = await hold('alpha', {
      scopeKind: 'firm',
      scopeKey: target.firmId,
      reasonCode: 'send_unknown_terminal',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
    });
    expect(await counts()).toEqual({ active: 1, held: 1 });
    await releaseHold(worker('alpha'), holdId);
    expect(await counts()).toEqual({ active: 1, held: 0 });
  });
});

describe('the holds that do not count', () => {
  it('does not count an administrator’s pause over all automation, or over the email channel', async () => {
    await enrolledProspect('alpha');
    expect((await openPause(admin('alpha'), { scopeKind: 'all_automation' })).ok).toBe(true);
    expect((await openPause(admin('alpha'), { scopeKind: 'channel', channel: 'email' })).ok).toBe(true);
    expect(await counts()).toEqual({ active: 1, held: 0 });
  });

  it('does not count a salesperson’s Today delay, which is a firm-scoped scoped_pause', async () => {
    const target = await enrolledProspect('alpha');
    await hold('alpha', {
      scopeKind: 'firm',
      scopeKey: target.firmId,
      reasonCode: 'scoped_pause',
      blockedActionKinds: ['email_send'],
      sourceEventKind: 'today.delay_requested',
    });
    expect(await counts()).toEqual({ active: 1, held: 0 });
  });

  it('does not count the send hand-off holding a due email because sending is switched off', async () => {
    // The worker's own path: the step is due inside the firm's window (Friday 18
    // September 2026, 09:00 New York), every eligibility question says yes, and the
    // hand-off refuses the way `outboundSendHandoff` does when the deployment's flag,
    // the attestation or the domain says no sending — `scoped_pause`, no hold row.
    const target = await enrolledProspect('alpha');
    await database.session.query(
      `UPDATE step_executions
          SET due_at = TIMESTAMPTZ '2026-09-18T13:00:00Z', not_before = TIMESTAMPTZ '2026-09-18T13:00:00Z',
              original_due_at = TIMESTAMPTZ '2026-09-18T13:00:00Z'
        WHERE workspace_id = $1 AND enrollment_id = $2`,
      [seeded.alpha.workspaceId, target.enrollmentId],
    );
    const outcome = await runDueStepExecution(worker('alpha'), {
      enrollmentId: target.enrollmentId,
      now: '2026-09-18T14:00:00Z',
      eligibility: allowAllEligibility(),
      sendHandoff: unavailableSendHandoff(),
    });
    expect(outcome).toMatchObject({ kind: 'held', reasonCode: 'scoped_pause' });
    const holds = await database.session.query('SELECT 1 FROM active_holds WHERE workspace_id = $1', [
      seeded.alpha.workspaceId,
    ]);
    expect(holds.rows).toHaveLength(0);
    expect(await counts()).toEqual({ active: 1, held: 0 });
  });

  for (const reasonCode of Object.keys(CLOCK_CLEARING_HOLDS) as HoldReasonCode[]) {
    it(`does not count ${reasonCode}, which clears with the clock, on the step or as a firm hold`, async () => {
      const target = await enrolledProspect('alpha');
      await holdStep(target, reasonCode);
      await hold('alpha', {
        scopeKind: 'firm',
        scopeKey: target.firmId,
        reasonCode,
        blockedActionKinds: ['email_send', 'enrollment_advance'],
      });
      expect(await counts()).toEqual({ active: 1, held: 0 });
    });
  }

  it('does not count a hold on dialing or research, which no sequence step is blocked under', async () => {
    const target = await enrolledProspect('alpha');
    for (const kinds of [['dial_authorization'], ['research']] as const) {
      await hold('alpha', {
        scopeKind: 'firm',
        scopeKey: target.firmId,
        reasonCode: 'manual_suppression_review',
        blockedActionKinds: kinds,
      });
    }
    expect(await counts()).toEqual({ active: 1, held: 0 });
  });

  it('does not count a hold on calls while the next step is an email, and counts it once the call step is next', async () => {
    const target = await enrolledProspect('alpha');
    const callsOnly: readonly BlockedActionKind[] = ['call_task'];
    await hold('alpha', {
      scopeKind: 'opportunity',
      scopeKey: target.opportunityId,
      reasonCode: 'ambiguous_match',
      blockedActionKinds: callsOnly,
    });
    expect(await counts()).toEqual({ active: 1, held: 0 });

    // The email step completes; the cadence's next step is the call task.
    const { rows } = await database.session.query<{ id: string }>(
      "SELECT id FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2 AND state = 'pending'",
      [seeded.alpha.workspaceId, target.enrollmentId],
    );
    const completed = await completeStepExecution(worker('alpha'), {
      stepExecutionId: rows[0]?.id ?? '',
      completionSource: 'send',
      result: 'sent',
    });
    expect(completed.ok && completed.value.successorExecutionId !== null).toBe(true);
    expect(await counts()).toEqual({ active: 1, held: 1 });
  });

  it('does not count a hold on another firm, another opportunity, another owner or another workspace', async () => {
    await enrolledProspect('alpha');
    // A real firm and opportunity in alpha whose only enrollment has ended.
    const elsewhere = await enrolledProspect('alpha');
    await stopEnrollments(worker('alpha'), { enrollmentId: elsewhere.enrollmentId, reason: 'admin_stop' });
    await hold('alpha', {
      scopeKind: 'firm',
      scopeKey: elsewhere.firmId,
      reasonCode: 'send_unknown_terminal',
      blockedActionKinds: ['email_send', 'enrollment_advance'],
    });
    await hold('alpha', {
      scopeKind: 'opportunity',
      scopeKey: elsewhere.opportunityId,
      reasonCode: 'uncertain_reply',
      blockedActionKinds: ['email_send', 'call_task', 'enrollment_advance'],
    });
    // The administrator owns no enrollment; the salesperson does.
    await hold('alpha', {
      scopeKind: 'owner',
      scopeKey: seeded.alpha.admin.userId,
      reasonCode: 'mailbox_disconnected',
      blockedActionKinds: ['email_send', 'call_task', 'enrollment_advance'],
    });
    await hold('beta', {
      scopeKind: 'workspace',
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ['email_send', 'call_task', 'enrollment_advance'],
    });
    expect(await counts()).toEqual({ active: 1, held: 0 });
  });
});

describe('enrollments that are over', () => {
  it('counts neither a completed nor a stopped enrollment as active, nor as held', async () => {
    const completed = await enrolledProspect('alpha');
    const stopped = await enrolledProspect('alpha');
    await enrolledProspect('alpha');
    expect(await counts()).toEqual({ active: 3, held: 0 });

    await completeEnrollment(worker('alpha'), completed.enrollmentId);
    await stopEnrollments(worker('alpha'), { enrollmentId: stopped.enrollmentId, reason: 'admin_stop' });
    expect(await counts()).toEqual({ active: 1, held: 0 });

    // A restore holds the one live enrollment, and nothing that has ended.
    await hold('alpha', {
      scopeKind: 'workspace',
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ['email_send', 'call_task', 'dial_authorization', 'enrollment_advance', 'research'],
    });
    expect(await counts()).toEqual({ active: 1, held: 1 });
  });

  it('counts a long-hold review as active, because it is live and only a person ends it', async () => {
    const target = await enrolledProspect('alpha');
    await database.session.query(
      `UPDATE sequence_enrollments SET state = 'review_required', review_union_milliseconds = 1
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, target.enrollmentId],
    );
    expect(await counts()).toEqual({ active: 1, held: 1 });
  });
});

describe('two workspaces', () => {
  it('sums both, with no dimension, and no hold crosses from one to the other', async () => {
    const alphaHeld = await enrolledProspect('alpha');
    await enrolledProspect('alpha');
    await enrolledProspect('beta');
    await hold('alpha', {
      scopeKind: 'firm',
      scopeKey: alphaHeld.firmId,
      reasonCode: 'provider_refusal',
      blockedActionKinds: ['email_send'],
    });
    await hold('beta', {
      scopeKind: 'workspace',
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ['email_send', 'call_task', 'dial_authorization', 'enrollment_advance', 'research'],
    });
    expect(await collectSequenceMetrics(database.session)).toEqual([
      { name: 'ActiveEnrollments', value: 3, unit: 'Count' },
      { name: 'HeldEnrollments', value: 2, unit: 'Count' },
    ]);
  });
});

describe('which reasons are expected', () => {
  it('is scoped_pause and the three clock-clearing holds, and nothing else', () => {
    expect([...EXPECTED_HOLD_REASONS].sort()).toEqual(
      ['daily_cap', 'outside_email_window', 'scoped_pause', 'send_unknown_reconciling'],
    );
  });
});
