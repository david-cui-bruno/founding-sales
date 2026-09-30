import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SENDING_STOP_LINE } from '@fss/contracts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { allowAllEligibility } from '../../sequences/eligibility.ts';
import { enrollContact } from '../../sequences/enrollments.ts';
import { runDueStepExecution } from '../../sequences/executions.ts';
import { recordingSendHandoff } from '../../sequences/sendHandoff.ts';
import { listStepExecutions } from '../../sequences/rows.ts';
import { createTemplateVersion } from '../../templates/templates.ts';
import { createDraftVersion, createSequence, publishVersion } from '../../sequences/definitions.ts';
import { sendFooterBlock } from '../../src/rules/templates.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { FIXTURE_SIGN_OFF, fixtureBody, seedSequences } from './support/sequenceFixtures.ts';

/**
 * The step composes the footer **before** it hands anything to the send (lane W3-F,
 * migration 0020).
 *
 * `runEmailStep` renders, composes and only then calls `prepare`, so the bytes that
 * cross the hand-off are the bytes the fence freezes. A body that cannot be given exactly
 * one final stop line inside the fence's 4,000 characters holds the step **with no fence
 * created at all** — the review's "check the final rendered body before fence insertion
 * and return a handled hold".
 *
 * ## The vacuous-pass trap
 *
 * A hold is easy to produce by breaking the world. Each case here asserts what the
 * hand-off received as well as what the step became, and the hold case asserts that the
 * hand-off received *nothing*: a fence prepared and then held would pass a weaker test
 * and would be the bug.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;

const ADDRESS = '1 Example Way, Suite 2\nProvidence, RI 02903';
const DUE = '2026-09-21T13:00:00Z';

const contextFor = (who: 'admin' | 'salesperson'): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha[who].userId, role: who }),
    database.session,
  );

const worker = (): RepositoryContext =>
  repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
    database.session,
  );

async function setPostalAddress(address: string | null): Promise<void> {
  await database.session.query(
    `UPDATE workspace_settings SET superseded_at = greatest(now(), changed_at), superseded_by_version = version + 1
      WHERE workspace_id = $1 AND setting_key = 'postal_address' AND superseded_at IS NULL`,
    [seeded.alpha.workspaceId],
  );
  const { rows } = await database.session.query<{ next: number }>(
    `SELECT coalesce(max(version), 0) + 1 AS next FROM workspace_settings
      WHERE workspace_id = $1 AND setting_key = 'postal_address'`,
    [seeded.alpha.workspaceId],
  );
  await database.session.query(
    `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, change_note, changed_by_user_id)
     VALUES ($1, 'postal_address', $2, $3::jsonb, 'fixture', $4)`,
    [seeded.alpha.workspaceId, Number(rows[0]?.next ?? 1), JSON.stringify({ address }), seeded.alpha.admin.userId],
  );
}

/**
 * The version the next enrollment runs: one e-mail step on an approved template with
 * `body`. Since send-path v2 (S2) an approved template and a published version never
 * change, so a different body is a new template version in a new published plan rather
 * than an edit of the seeded one.
 */
let versionUnderTest = '';

async function templateBody(body: string, variables: readonly string[] = ['firm_name']): Promise<void> {
  const created = await createTemplateVersion(contextFor('admin'), {
    name: 'Seeded, edited',
    subject: 'Hello {firm_name}',
    body,
    footer: { signOff: FIXTURE_SIGN_OFF },
    requiredVariables: ['firm_name', ...variables],
    approve: true,
  });
  if (!created.ok) throw new Error(`the template was refused: ${created.reason}`);
  const sequence = await createSequence(contextFor('admin'), { name: `Footer plan ${crypto.randomUUID()}` });
  if (!sequence.ok) throw new Error(`the sequence was refused: ${sequence.reason}`);
  const draft = await createDraftVersion(contextFor('admin'), {
    sequenceId: sequence.value.id,
    steps: [{ ordinal: 1, channel: 'email', delay: { unit: 'elapsed', hours: 0 }, templateVersionId: created.value.id }],
  });
  if (!draft.ok) throw new Error(`the draft was refused: ${draft.reason}`);
  const published = await publishVersion(contextFor('admin'), { sequenceVersionId: draft.value.sequenceVersionId });
  if (!published.ok) throw new Error(`the publication was refused: ${published.reason}`);
  versionUnderTest = draft.value.sequenceVersionId;
}

async function setDue(enrollmentId: string): Promise<void> {
  await database.session.query(
    `UPDATE step_executions SET due_at = $3::timestamptz, not_before = $3::timestamptz, original_due_at = $3::timestamptz
      WHERE workspace_id = $1 AND enrollment_id = $2 AND state IN ('pending', 'held')`,
    [seeded.alpha.workspaceId, enrollmentId, DUE],
  );
}

async function enrolledAndDue(): Promise<string> {
  const result = await enrollContact(contextFor('salesperson'), {
    sequenceVersionId: versionUnderTest,
    originKind: 'prospecting' as const,
    opportunityId: crm.alpha.opportunityId,
    firmId: crm.alpha.firmId,
    contactId: crm.alpha.contactId,
  });
  if (!result.ok) throw new Error(`the enrollment fixture was refused: ${result.reason}`);
  await setDue(result.value.enrollmentId);
  return result.value.enrollmentId;
}

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, seeded);
  // The holiday calendar the enrollments freeze; the plans themselves are made per case.
  await seedSequences(database.session, seeded);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.session.query('DELETE FROM step_execution_shifts');
  await database.session.query('DELETE FROM step_executions');
  // Migration 0025: a permission names the one run it bought, so the binding is
  // released before the enrollment it names is deleted.
  await database.session.query('UPDATE follow_up_permissions SET enrollment_id = NULL');
  await database.session.query('DELETE FROM sequence_enrollments');
  await database.session.query('DELETE FROM active_holds');
  await templateBody(fixtureBody('A short note about {firm_name}.'));
});

describe('the step hands over composed bytes', () => {
  it('appends the sign-off and the configured address, and no stop line', async () => {
    await setPostalAddress(ADDRESS);
    const enrollmentId = await enrolledAndDue();
    const handoff = recordingSendHandoff();
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId,
      now: DUE,
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    expect(outcome.kind).toBe('handed_to_send');
    const [request] = handoff.prepared;
    expect(request?.body).toBe(
      `A short note about ${crm.collidingFirmName}.\n\n${sendFooterBlock({
        signOff: FIXTURE_SIGN_OFF,
        postalAddress: ADDRESS,
      })}`,
    );
    expect(request?.body).not.toContain(SENDING_STOP_LINE);
  });

  it('hands over today’s bytes exactly when no address is configured', async () => {
    await setPostalAddress(null);
    const enrollmentId = await enrolledAndDue();
    const handoff = recordingSendHandoff();
    expect(
      (await runDueStepExecution(worker(), {
        enrollmentId,
        now: DUE,
        eligibility: allowAllEligibility(),
        sendHandoff: handoff,
      })).kind,
    ).toBe('handed_to_send');
    expect(handoff.prepared[0]?.body).toBe(fixtureBody(`A short note about ${crm.collidingFirmName}.`));
  });

  it('composes a footerless approved body too: the shapes meet at the hand-off', async () => {
    await setPostalAddress(ADDRESS);
    await templateBody('A short note about {firm_name}.');
    const enrollmentId = await enrolledAndDue();
    const handoff = recordingSendHandoff();
    expect(
      (await runDueStepExecution(worker(), {
        enrollmentId,
        now: DUE,
        eligibility: allowAllEligibility(),
        sendHandoff: handoff,
      })).kind,
    ).toBe('handed_to_send');
    expect(handoff.prepared[0]?.body).toBe(
      `A short note about ${crm.collidingFirmName}.\n\n${sendFooterBlock({
        signOff: FIXTURE_SIGN_OFF,
        postalAddress: ADDRESS,
      })}`,
    );
  });

  it('holds the step when a rendered variable puts an opt-out link in the bytes (P1-2)', async () => {
    // `{firm_website}` is whatever the CRM holds, so an approval can be clean and the
    // rendered bytes still carry a link the outbound CHECK refuses. A handled hold,
    // before any fence exists — never an exception out of the insert.
    await setPostalAddress(null);
    await database.session.query('UPDATE firms SET website = $3 WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      crm.alpha.firmId,
      'https://x.example/unsubscribe',
    ]);
    await templateBody('Our site: {firm_website}', ['firm_website']);
    const enrollmentId = await enrolledAndDue();
    const handoff = recordingSendHandoff();
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId,
      now: DUE,
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    // Its own hold reason since migration 0024: the operator has to be able to read why
    // an approved template stopped (review of PR 311, second round).
    expect(outcome).toMatchObject({ kind: 'held', reasonCode: 'optout_link' });
    expect(handoff.prepared).toEqual([]);
    const held = await database.session.query<{ hold_reason_code: string }>(
      'SELECT hold_reason_code FROM step_executions WHERE workspace_id = $1 AND enrollment_id = $2',
      [seeded.alpha.workspaceId, enrollmentId],
    );
    expect(held.rows[0]?.hold_reason_code).toBe('optout_link');
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM outbound_messages WHERE workspace_id = $1',
      [seeded.alpha.workspaceId],
    );
    expect(Number(rows[0]?.count)).toBe(0);
    await database.session.query('UPDATE firms SET website = $3 WHERE workspace_id = $1 AND id = $2', [
      seeded.alpha.workspaceId,
      crm.alpha.firmId,
      'https://firm.example',
    ]);
  });

  it('holds the step before any fence exists when the composed body would pass 4,000', async () => {
    await setPostalAddress(null);
    const footer = FIXTURE_SIGN_OFF;
    // The longest body the template rules admit with no address: 4,000 composed.
    await templateBody(`${'x'.repeat(4000 - footer.length - 2)}\n\n${footer}`);
    await setPostalAddress(ADDRESS);

    const enrollmentId = await enrolledAndDue();
    const handoff = recordingSendHandoff();
    const outcome = await runDueStepExecution(worker(), {
      enrollmentId,
      now: DUE,
      eligibility: allowAllEligibility(),
      sendHandoff: handoff,
    });
    expect(outcome).toMatchObject({ kind: 'held', reasonCode: 'template_unapproved' });
    // Nothing was handed over: the hold happens before the fence, not after it.
    expect(handoff.prepared).toEqual([]);
    const [execution] = await listStepExecutions(worker(), { enrollmentId });
    expect(execution).toMatchObject({ state: 'held', holdReasonCode: 'template_unapproved' });

    // Clear the address and the same step goes: the refusal was the length.
    await setPostalAddress(null);
    await setDue(enrollmentId);
    const second = recordingSendHandoff();
    expect(
      (await runDueStepExecution(worker(), {
        enrollmentId,
        now: DUE,
        eligibility: allowAllEligibility(),
        sendHandoff: second,
      })).kind,
    ).toBe('handed_to_send');
    expect(second.prepared[0]?.body).toHaveLength(4000);
  });
});
