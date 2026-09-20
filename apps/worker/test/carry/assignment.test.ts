import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryContext, withTransaction, workspaceScope } from '@fss/domain/db';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { recordingSuppressionJournal } from '@fss/domain/suppression';
import { aesGcmCipher } from '../../tools/carry/artifact.ts';
import { recordedFixtureReader } from '../../tools/carry/dynamoPort.ts';
import { runCarryExport } from '../../tools/carry/export.ts';
import { openCarryArtifact, runCarryImport } from '../../tools/carry/import.ts';
import type { CarryManifest } from '../../tools/carry/manifest.ts';
import type { OldRecord } from '../../tools/carry/oldShapes.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../fixtures/carry/workspaces.ts';
import { FIXTURE_WATERMARK, goodOldTable } from '../fixtures/carry/oldTable.ts';

/**
 * `--assign-to-user`, the single-salesperson shortcut (lane G11).
 *
 * The default is that a carried firm arrives unassigned and an admin assigns it.
 * With one salesperson that is four hundred clicks for a foregone conclusion, so the
 * import takes an optional member and assigns every firm it *creates* to them.
 *
 * Three properties are the whole of it: the member is validated before anything is
 * written, only created firms are touched, and the id is in the audit row.
 */

const watermarkFlag = JSON.stringify({
  schema: 'fss.carry.watermark.v1',
  disabledAt: FIXTURE_WATERMARK,
  scheduleRuleName: 'fss-old-worker-schedule',
  recordedBy: 'operator',
});

describe('assigning the carried firms', () => {
  let database: TestDatabase;
  let workspaces: TwoWorkspaces;
  const cipher = aesGcmCipher(randomBytes(32));

  beforeAll(async () => {
    database = await createTestDatabase();
    workspaces = await seedTwoWorkspaces(database.session);
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  const contextFor = (workspaceId: string) =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'migration' }), database.session);

  async function carried(): Promise<{ manifest: CarryManifest; records: readonly OldRecord[] }> {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(goodOldTable()),
      watermarkFlag,
      cipher,
      now: new Date('2026-09-21T14:00:00.000Z'),
      artifactId: 'carry-assignment',
    });
    if (!exported.ok) throw new Error(exported.reason);
    const opened = await openCarryArtifact({ sealed: exported.value.sealed, receipt: exported.value.receipt, cipher });
    if (!opened.ok) throw new Error(opened.reason);
    return opened.value;
  }

  it('refuses a user who is not an active member of this workspace, before writing anything', async () => {
    const artifact = await carried();
    const report = await withTransaction(database.session, async () =>
      runCarryImport(contextFor(workspaces.alpha.workspaceId), {
        manifest: artifact.manifest,
        records: artifact.records,
        journal: recordingSuppressionJournal(),
        // A member of the *other* workspace. Appendix G 8: it must not be found here.
        assignToUserId: workspaces.beta.salespersonUserId,
      }),
    );
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.reason).toBe('assignee_unknown');

    const firms = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM firms WHERE workspace_id = $1',
      [workspaces.alpha.workspaceId],
    );
    expect(firms.rows[0]?.count).toBe('0');
  });

  it('assigns every firm it creates, and records the member in the audit row', async () => {
    const artifact = await carried();
    const report = await withTransaction(database.session, async () =>
      runCarryImport(contextFor(workspaces.alpha.workspaceId), {
        manifest: artifact.manifest,
        records: artifact.records,
        journal: recordingSuppressionJournal(),
        assignToUserId: workspaces.alpha.salespersonUserId,
      }),
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.assignedToUserId).toBe(workspaces.alpha.salespersonUserId);

    const assigned = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM firms WHERE workspace_id = $1 AND assigned_user_id = $2',
      [workspaces.alpha.workspaceId, workspaces.alpha.salespersonUserId],
    );
    expect(assigned.rows[0]?.count).toBe('4');

    const audited = await database.session.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE workspace_id = $1 AND action = 'carry.imported'`,
      [workspaces.alpha.workspaceId],
    );
    expect(audited.rows[0]?.detail).toMatchObject({ assignedToUserId: workspaces.alpha.salespersonUserId });
  });

  it('leaves a firm a previous run already carried exactly as it was', async () => {
    const artifact = await carried();
    const report = await withTransaction(database.session, async () =>
      runCarryImport(contextFor(workspaces.alpha.workspaceId), {
        manifest: artifact.manifest,
        records: artifact.records,
        journal: recordingSuppressionJournal(),
        // A different member. Reassignment is `reassignFirm`'s job, not the carry's.
        assignToUserId: workspaces.alpha.adminUserId,
      }),
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.carried.firm).toEqual({ created: 0, reused: 4 });

    const stillTheSalesperson = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM firms WHERE workspace_id = $1 AND assigned_user_id = $2',
      [workspaces.alpha.workspaceId, workspaces.alpha.salespersonUserId],
    );
    expect(stillTheSalesperson.rows[0]?.count).toBe('4');
    const holds = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM active_holds
        WHERE workspace_id = $1 AND reason_code = 'reassignment'`,
      [workspaces.alpha.workspaceId],
    );
    expect(holds.rows[0]?.count).toBe('0');
  });

  it('leaves every firm unassigned when no member is named', async () => {
    const artifact = await carried();
    const report = await withTransaction(database.session, async () =>
      runCarryImport(contextFor(workspaces.beta.workspaceId), {
        manifest: artifact.manifest,
        records: artifact.records,
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.assignedToUserId).toBeNull();

    const unassigned = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM firms WHERE workspace_id = $1 AND assigned_user_id IS NULL',
      [workspaces.beta.workspaceId],
    );
    expect(unassigned.rows[0]?.count).toBe('4');
  });
});
