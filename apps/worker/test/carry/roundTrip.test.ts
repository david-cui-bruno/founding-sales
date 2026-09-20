import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryContext, withTransaction, workspaceScope } from '@fss/domain/db';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { listEffectiveSuppressions, recordingSuppressionJournal } from '@fss/domain/suppression';
import { aesGcmCipher } from '../../tools/carry/artifact.ts';
import { recordedFixtureReader } from '../../tools/carry/dynamoPort.ts';
import { runCarryExport } from '../../tools/carry/export.ts';
import { openCarryArtifact, runCarryImport } from '../../tools/carry/import.ts';
import { shredCarryArtifact } from '../../tools/carry/shred.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../fixtures/carry/workspaces.ts';
import {
  FIXTURE_WATERMARK,
  goodOldTable,
  tableWithPostWatermarkWrite,
} from '../fixtures/carry/oldTable.ts';

/**
 * The carry, end to end, on the fixtures (specification 2 "Data carry", 17, Appendix
 * G 8 and 20; lane G11).
 *
 * Everything the brief calls acceptance is here and in this order: counts and hashes
 * equal, every suppression present, templates unapproved, a second import that
 * changes nothing, the artifact gone and audited, and post-watermark data that never
 * flows back.
 *
 * The second workspace is not decoration. The same artifact is imported into two
 * workspaces whose old firm ids collide exactly, and the assertions at the end are
 * that neither workspace can see the other's rows — which is the only way to prove
 * that "idempotent by the old item id" is scoped and not global.
 */

const watermarkFlag = JSON.stringify({
  schema: 'fss.carry.watermark.v1',
  disabledAt: FIXTURE_WATERMARK,
  scheduleRuleName: 'fss-old-worker-schedule',
  recordedBy: 'operator',
});

const NOW = new Date('2026-09-21T14:00:00.000Z');

describe('the data carry, end to end', () => {
  let database: TestDatabase;
  let workspaces: TwoWorkspaces;
  let directory: string;
  const cipher = aesGcmCipher(randomBytes(32));

  beforeAll(async () => {
    database = await createTestDatabase();
    workspaces = await seedTwoWorkspaces(database.session);
    directory = await mkdtemp(join(tmpdir(), 'fss-carry-'));
  }, 120_000);

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
    await database?.drop();
  });

  const contextFor = (workspaceId: string) =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'migration' }), database.session);

  it('exports every kind under the watermark and writes a manifest of counts and hashes', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(goodOldTable()),
      watermarkFlag,
      cipher,
      now: NOW,
      artifactId: 'carry-round-trip',
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    expect(exported.value.manifest.kinds.firm.count).toBe(4);
    expect(exported.value.manifest.kinds.evidence.count).toBe(2);
    expect(exported.value.manifest.kinds.suppression.count).toBe(4);
    expect(exported.value.manifest.kinds.template.count).toBe(2);
    // One firm has both a FIRM# and an ACCOUNT# row; the FIRM# record wins and the
    // firm is carried once.
    expect(exported.value.manifest.items.filter(entry => entry.kind === 'firm')).toHaveLength(4);
    expect(exported.value.receipt.watermarkAt).toBe(FIXTURE_WATERMARK);
    expect(exported.value.receipt.manifestDigest).toHaveLength(64);
    // Nothing readable leaks out of the sealed bytes.
    expect(exported.value.sealed.includes(Buffer.from('Alpha Synthetic Partners'))).toBe(false);
  });

  it('carries firms, evidence and every suppression into two workspaces without crossing', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(goodOldTable()),
      watermarkFlag,
      cipher,
      now: NOW,
      artifactId: 'carry-round-trip',
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;

    const opened = await openCarryArtifact({
      sealed: exported.value.sealed,
      receipt: exported.value.receipt,
      cipher,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    for (const workspace of [workspaces.alpha, workspaces.beta]) {
      const report = await withTransaction(database.session, async () =>
        runCarryImport(contextFor(workspace.workspaceId), {
          manifest: opened.value.manifest,
          records: opened.value.records,
          journal: recordingSuppressionJournal(),
        }),
      );
      expect(report.ok).toBe(true);
      if (!report.ok) return;
      expect(report.value.parity.matched).toBe(true);
      expect(report.value.carried.firm).toEqual({ created: 4, reused: 0 });
      expect(report.value.carried.evidence).toEqual({ created: 2, reused: 0 });
      expect(report.value.carried.suppression).toEqual({ created: 4, reused: 0 });
      // The template versions table does not exist yet; the seam is reported, never
      // silently counted as carried.
      expect(report.value.carried.template).toEqual({ created: 0, reused: 0, deferred: 2 });
    }

    const alphaFirms = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM firms WHERE workspace_id = $1',
      [workspaces.alpha.workspaceId],
    );
    expect(alphaFirms.rows[0]?.count).toBe('4');

    for (const workspace of [workspaces.alpha, workspaces.beta]) {
      const effective = await listEffectiveSuppressions(contextFor(workspace.workspaceId));
      expect(effective).toHaveLength(4);
      expect(effective.every(entry => entry.source === 'import')).toBe(true);
      expect(effective.every(entry => entry.canonicalizerVersion.length > 0)).toBe(true);
    }

    // Appendix G 8: the same old ids in both workspaces, and no row sees the other.
    const aliases = await database.session.query<{ workspace_id: string; alias_value: string }>(
      `SELECT workspace_id, alias_value FROM record_aliases
        WHERE alias_kind = 'external_id' AND alias_value = 'account-alpha'`,
    );
    expect(aliases.rows).toHaveLength(2);
    expect(new Set(aliases.rows.map(row => row.workspace_id)).size).toBe(2);
  });

  it('records the zone only where the versioned rule can establish it', async () => {
    const resolved = await database.session.query<{ name: string; time_zone: string | null; time_zone_confidence: string | null }>(
      `SELECT f.name, f.time_zone, f.time_zone_confidence
         FROM firms f
        WHERE f.workspace_id = $1
        ORDER BY f.name`,
      [workspaces.alpha.workspaceId],
    );
    const byName = new Map(resolved.rows.map(row => [row.name, row]));
    // Rhode Island observes one zone: the state default, at medium confidence.
    expect(byName.get('Alpha Synthetic Partners')?.time_zone).toBe('America/New_York');
    expect(byName.get('Alpha Synthetic Partners')?.time_zone_confidence).toBe('medium');
    // Texas spans two. The old record's state-wide guess is not carried, so the firm
    // arrives uncallable rather than callable at the wrong hour.
    expect(byName.get('Bravo Invented Group')?.time_zone).toBeNull();
  });

  it('changes nothing when the same artifact is imported again', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(goodOldTable()),
      watermarkFlag,
      cipher,
      now: NOW,
      artifactId: 'carry-round-trip',
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const opened = await openCarryArtifact({ sealed: exported.value.sealed, receipt: exported.value.receipt, cipher });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const before = await counts(database, workspaces.alpha.workspaceId);
    const report = await withTransaction(database.session, async () =>
      runCarryImport(contextFor(workspaces.alpha.workspaceId), {
        manifest: opened.value.manifest,
        records: opened.value.records,
        journal: recordingSuppressionJournal(),
      }),
    );
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.carried.firm).toEqual({ created: 0, reused: 4 });
    expect(report.value.carried.evidence).toEqual({ created: 0, reused: 2 });
    expect(report.value.carried.suppression).toEqual({ created: 0, reused: 4 });
    expect(report.value.parity.matched).toBe(true);
    expect(await counts(database, workspaces.alpha.workspaceId)).toEqual(before);
  });

  it('refuses to export anything the old table wrote after the watermark', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(tableWithPostWatermarkWrite()),
      watermarkFlag,
      cipher,
      now: NOW,
      artifactId: 'carry-post-watermark',
    });
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.reason).toBe('post_watermark_items_present');
    expect(exported.detail).toEqual({ suppression: 1 });
  });

  it('refuses to import a record recorded after the watermark, even in a hand-made artifact', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(goodOldTable()),
      watermarkFlag,
      cipher,
      now: NOW,
      artifactId: 'carry-tampered',
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const opened = await openCarryArtifact({ sealed: exported.value.sealed, receipt: exported.value.receipt, cipher });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const tampered = {
      ...opened.value.manifest,
      watermarkAt: '2026-09-19T00:00:00.000Z',
    };
    const report = await withTransaction(database.session, async () =>
      runCarryImport(contextFor(workspaces.alpha.workspaceId), {
        manifest: tampered,
        records: opened.value.records,
        journal: recordingSuppressionJournal(),
      }),
    ).catch(() => ({ ok: false as const, reason: 'threw' as const, detail: {} }));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.reason).toBe('post_watermark_record');
  });

  it('shreds the artifact and writes the audit row', async () => {
    const exported = await runCarryExport({
      reader: recordedFixtureReader(goodOldTable()),
      watermarkFlag,
      cipher,
      now: NOW,
      artifactId: 'carry-shred',
    });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const path = join(directory, 'carry-shred.fss-carry');
    await writeFile(path, exported.value.sealed);
    expect((await stat(path)).size).toBeGreaterThan(0);

    const shredded = await withTransaction(database.session, async () =>
      shredCarryArtifact(contextFor(workspaces.alpha.workspaceId), {
        path,
        receipt: exported.value.receipt,
      }),
    );
    expect(shredded.ok).toBe(true);
    await expect(readFile(path)).rejects.toThrow();

    const audited = await database.session.query<{ action: string; detail: Record<string, unknown> }>(
      `SELECT action, detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'carry.artifact_deleted'`,
      [workspaces.alpha.workspaceId],
    );
    expect(audited.rows).toHaveLength(1);
    expect(audited.rows[0]?.detail).toMatchObject({ artifactId: 'carry-shred' });
    // The audit row records identifiers and counts, never a name or a handle.
    expect(JSON.stringify(audited.rows[0]?.detail)).not.toContain('Alpha');
  });

  it('carries no write back to the old table: the reader has no way to write one', () => {
    const reader = recordedFixtureReader(goodOldTable());
    expect(Object.keys(reader).sort()).toEqual(['description', 'listByPrefix']);
  });

  it('records one audit event for the carry itself', async () => {
    const audited = await database.session.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events
        WHERE workspace_id = $1 AND action = 'carry.imported'
        ORDER BY occurred_at`,
      [workspaces.alpha.workspaceId],
    );
    expect(audited.rows.length).toBeGreaterThanOrEqual(1);
    expect(audited.rows[0]?.detail).toMatchObject({ watermarkAt: FIXTURE_WATERMARK });
  });
});

async function counts(database: TestDatabase, workspaceId: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of ['firms', 'evidence_items', 'suppression_events', 'phone_routes', 'email_addresses', 'record_aliases']) {
    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE workspace_id = $1`,
      [workspaceId],
    );
    result[table] = rows[0]?.count ?? '0';
  }
  return result;
}
