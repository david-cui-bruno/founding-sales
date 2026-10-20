import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { createDraftVersion, createSequence, saveSteps } from '../../sequences/definitions.ts';
import { listSequenceVersions } from '../../sequences/rows.ts';
import { createTemplateVersion, readTemplateVersion } from '../../templates/templates.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { emailStep, templateText } from './support/versionFixtures.ts';

let database: TestDatabase;
let seeded: TwoWorkspaces;
const context = (workspace: 'alpha' | 'beta' = 'alpha', role: 'admin' | 'salesperson' = 'admin') =>
  repositoryContext(workspaceScope(seeded[workspace].workspaceId, {
    kind: 'user', userId: seeded[workspace][role].userId, role,
  }), database.session);

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
});
afterAll(async () => { await database.drop(); });

describe('unpublished first-cold five-touch persistence', () => {
  it('commits unapproved copy and cadence, reads it from a fresh context, and refuses conflicting creation', async () => {
    const templateIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const template = await createTemplateVersion(context(), {
        ...templateText(`First-cold touch ${String(index + 1)}. Not an agreed call follow-up.`),
        name: `First-cold ${String(index + 1)}`,
        approve: false,
      });
      if (!template.ok) throw new Error(template.reason);
      templateIds.push(template.value.id);
    }
    const sequence = await createSequence(context(), { name: 'Unapproved first-cold five-touch draft' });
    if (!sequence.ok) throw new Error(sequence.reason);
    const draft = await createDraftVersion(context(), { sequenceId: sequence.value.id });
    if (!draft.ok) throw new Error(draft.reason);
    const hours = [0, 72, 168, 312, 480];
    const steps = templateIds.map((id, index) => emailStep(id, index + 1, hours[index] ?? 0));
    await database.session.query('BEGIN');
    try {
      expect(await saveSteps(context(), { sequenceVersionId: draft.value.sequenceVersionId, steps }))
        .toMatchObject({ ok: true, value: { steps: 5, newVersion: false } });
      await database.session.query('COMMIT');
    } catch (error) {
      await database.session.query('ROLLBACK');
      throw error;
    }

    const readback = await listSequenceVersions(context(), sequence.value.id);
    expect(readback).toHaveLength(1);
    expect(readback[0]).toMatchObject({ state: 'draft', publishedAt: null });
    expect(readback[0]?.steps.map(step => ({
      ordinal: step.ordinal, channel: step.channel, delay: step.delay, templateVersionId: step.templateVersionId,
    }))).toEqual(steps);
    for (const id of templateIds) {
      expect(await readTemplateVersion(context(), id)).toMatchObject({ approvedAt: null, retiredAt: null });
    }
    expect(await createDraftVersion(context(), { sequenceId: sequence.value.id, steps: [] }))
      .toEqual({ ok: false, reason: 'draft_exists' });
    expect(await listSequenceVersions(context(), sequence.value.id)).toEqual(readback);
    expect(await saveSteps(context('alpha', 'salesperson'), { sequenceVersionId: draft.value.sequenceVersionId, steps: [] }))
      .toEqual({ ok: false, reason: 'admin_only' });
    expect(await saveSteps(context('beta'), { sequenceVersionId: draft.value.sequenceVersionId, steps: [] }))
      .toEqual({ ok: false, reason: 'version_unknown' });
    const first = steps[0];
    if (first === undefined) throw new Error('five-touch fixture missing first step');
    expect(await saveSteps(context(), { sequenceVersionId: draft.value.sequenceVersionId, steps: [{ ...first, ordinal: 2 }] }))
      .toEqual({ ok: false, reason: 'invalid_input' });
    expect(await listSequenceVersions(context(), sequence.value.id)).toEqual(readback);
    const { rows } = await database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sequence_enrollments WHERE sequence_version_id = $1',
      [draft.value.sequenceVersionId],
    );
    expect(rows[0]?.count).toBe('0');
  });
});
