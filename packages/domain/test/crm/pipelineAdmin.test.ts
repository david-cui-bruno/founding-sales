import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { readPipelineBoardForActor } from '../../crm/board.ts';
import { listPipelineStages } from '../../crm/pipeline.ts';
import {
  createPipelineStage,
  renamePipelineStage,
  reorderPipelineStages,
  retirePipelineStage,
} from '../../crm/stageAdmin.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';

/**
 * Stage administration and the pipeline board read (specification 7.2, 8.1,
 * Appendix F, Appendix G 7 and 8).
 *
 * Two things the coordinator handed this lane. "Admins may rename, reorder, add, or
 * retire nonterminal stages. Won and Lost are terminal" is the whole of the first,
 * and the word the tests below turn on is *nonterminal*: all four verbs are refused
 * on Won and Lost, because an opportunity must always have somewhere terminal to go
 * and a renamed or reordered terminal stage is the start of that going wrong. See
 * `docs/decisions/g9-terminal-stages-are-not-administrable.md`.
 *
 * The second is G6's gap: the board could offer a stage change only for a firm whose
 * page had been opened, because `GET /firms` returns `FirmIdentityDto` and an
 * identity carries no opportunity id. The resolution is a board read that carries the
 * id for the firms the caller could actually act on, and nothing for the rest; see
 * `docs/decisions/g9-pipeline-board-read.md`.
 */

describe('stage administration', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let admin: RepositoryContext;
  let salesperson: RepositoryContext;
  let betaAdmin: RepositoryContext;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    salesperson = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
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

  it('starts from section 8.1 s default pipeline', async () => {
    const stages = await listPipelineStages(admin);
    expect(stages.map(stage => stage.key)).toEqual([
      'new',
      'contacting',
      'engaged',
      'qualified',
      'proposal',
      'won',
      'lost',
    ]);
    expect(stages.filter(stage => stage.terminal_kind !== null).map(stage => stage.key)).toEqual(['won', 'lost']);
  });

  it('refuses every stage command from a salesperson', async () => {
    expect(await createPipelineStage(salesperson, { key: 'demo', displayName: 'Demo' })).toEqual({
      ok: false,
      reason: 'admin_only',
    });
    expect(await renamePipelineStage(salesperson, { stageKey: 'engaged', displayName: 'Talking' })).toEqual({
      ok: false,
      reason: 'admin_only',
    });
    expect(await reorderPipelineStages(salesperson, { stageKeys: ['new'] })).toEqual({
      ok: false,
      reason: 'admin_only',
    });
    expect(await retirePipelineStage(salesperson, { stageKey: 'proposal' })).toEqual({
      ok: false,
      reason: 'admin_only',
    });
    expect((await listPipelineStages(admin)).map(stage => stage.key)).toHaveLength(7);
  });

  it('adds a stage before the terminal ones and keeps Won and Lost last', async () => {
    const created = await createPipelineStage(admin, { key: 'demo', displayName: 'Demo' });
    expect(created.ok).toBe(true);
    const stages = await listPipelineStages(admin);
    expect(stages.map(stage => stage.key)).toEqual([
      'new',
      'contacting',
      'engaged',
      'qualified',
      'proposal',
      'demo',
      'won',
      'lost',
    ]);
    expect(stages.map(stage => stage.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // A second stage with the same key is refused rather than taking the unique
    // index, which would abort the transaction and lose the command receipt.
    expect(await createPipelineStage(admin, { key: 'demo', displayName: 'Demo again' })).toEqual({
      ok: false,
      reason: 'stage_key_exists',
    });
    // A terminal stage is never added: the workspace has exactly one Won and one Lost.
    expect(await createPipelineStage(admin, { key: 'closed', displayName: 'Closed', position: 1 })).toMatchObject({
      ok: true,
    });
    expect((await listPipelineStages(admin)).map(stage => stage.key)[0]).toBe('closed');
  });

  it('renames and reorders the nonterminal stages, and leaves the keys alone', async () => {
    const renamed = await renamePipelineStage(admin, { stageKey: 'engaged', displayName: 'In conversation' });
    expect(renamed.ok).toBe(true);
    if (renamed.ok) expect(renamed.value.display_name).toBe('In conversation');
    // The key is the stable identifier every other table and every client uses. A
    // rename changes the label a person reads and nothing else.
    expect((await listPipelineStages(admin)).find(stage => stage.key === 'engaged')?.display_name).toBe(
      'In conversation',
    );

    const nonTerminal = (await listPipelineStages(admin))
      .filter(stage => stage.terminal_kind === null)
      .map(stage => stage.key);
    const reversed = [...nonTerminal].reverse();
    const reordered = await reorderPipelineStages(admin, { stageKeys: reversed });
    expect(reordered.ok).toBe(true);

    const after = await listPipelineStages(admin);
    expect(after.filter(stage => stage.terminal_kind === null).map(stage => stage.key)).toEqual(reversed);
    expect(after.map(stage => stage.key).slice(-2)).toEqual(['won', 'lost']);
    expect(after.map(stage => stage.position)).toEqual(after.map((_, index) => index + 1));

    // A partial list is refused: a reorder names every nonterminal stage or none, so
    // there is no "what happened to the ones you left out" question.
    expect(await reorderPipelineStages(admin, { stageKeys: [reversed[0] ?? ''] })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    // So is a list naming a terminal stage.
    expect(await reorderPipelineStages(admin, { stageKeys: [...reversed, 'won'] })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
  });

  it('refuses to rename, reorder or retire a terminal stage', async () => {
    expect(await renamePipelineStage(admin, { stageKey: 'won', displayName: 'Closed won' })).toEqual({
      ok: false,
      reason: 'stage_terminal',
    });
    expect(await retirePipelineStage(admin, { stageKey: 'lost' })).toEqual({
      ok: false,
      reason: 'stage_terminal',
    });
    expect((await listPipelineStages(admin)).find(stage => stage.key === 'won')?.display_name).toBe('Won');
  });

  it('retires a nonterminal stage, keeps it readable, and refuses the last one', async () => {
    const retired = await retirePipelineStage(admin, { stageKey: 'demo' });
    expect(retired.ok).toBe(true);
    if (retired.ok) expect(retired.value.openOpportunities).toBe(0);

    const stages = await listPipelineStages(admin);
    // "Retired stages remain readable": still in the list, marked.
    expect(stages.find(stage => stage.key === 'demo')?.retired).toBe(true);
    expect(await retirePipelineStage(admin, { stageKey: 'demo' })).toEqual({
      ok: false,
      reason: 'stage_retired',
    });

    // Retiring every nonterminal stage would leave a reopened opportunity with
    // nowhere to start, so the last one is refused.
    const live = stages.filter(stage => stage.terminal_kind === null && !stage.retired).map(stage => stage.key);
    for (const key of live.slice(0, -1)) {
      expect((await retirePipelineStage(admin, { stageKey: key })).ok, key).toBe(true);
    }
    const last = live.at(-1) ?? '';
    expect(await retirePipelineStage(admin, { stageKey: last })).toEqual({
      ok: false,
      reason: 'stage_last_active',
    });
  });

  it('keeps the other workspace s pipeline untouched throughout', async () => {
    const beta = await listPipelineStages(betaAdmin);
    expect(beta.map(stage => stage.key)).toEqual([
      'new',
      'contacting',
      'engaged',
      'qualified',
      'proposal',
      'won',
      'lost',
    ]);
    expect(beta.every(stage => !stage.retired)).toBe(true);
    expect(beta.find(stage => stage.key === 'engaged')?.display_name).toBe('Engaged');
  });

  it('refuses a stage key that is not a key', async () => {
    expect(await createPipelineStage(admin, { key: 'Not A Key', displayName: 'x' })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(await createPipelineStage(admin, { key: 'ok_key', displayName: '  ' })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(await renamePipelineStage(admin, { stageKey: 'nope', displayName: 'x' })).toEqual({
      ok: false,
      reason: 'stage_unknown',
    });
  });
});

describe('the pipeline board read', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let assignee: RepositoryContext;
  let colleague: RepositoryContext;
  let admin: RepositoryContext;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);

    // Appendix G 7's second salesperson, in the same workspace, assigned nothing.
    const other = await database.session.query<{ id: string }>(
      'INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, $3) RETURNING id',
      [`sub-${randomUUID()}`, 'second.salesperson@example.test', 'Second Salesperson'],
    );
    const otherUserId = other.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role, status) VALUES ($1, $2, 'salesperson', 'active')",
      [seeded.alpha.workspaceId, otherUserId],
    );

    assignee = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: 'user',
        userId: seeded.alpha.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );
    colleague = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: otherUserId, role: 'salesperson' }),
      database.session,
    );
    admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('shows every firm to every active member, at identity visibility', async () => {
    for (const [name, context] of [
      ['assignee', assignee],
      ['colleague', colleague],
      ['admin', admin],
    ] as const) {
      const board = await readPipelineBoardForActor(context);
      const firms = board.columns.flatMap(column => column.firms);
      expect(firms.map(firm => firm.id), name).toContain(crm.alpha.firmId);
      // Appendix F row 1 and nothing more: the identity DTO has no field a note, a
      // body or an address could go in, so this is redaction by construction.
      const firm = firms.find(entry => entry.id === crm.alpha.firmId);
      expect(Object.keys(firm ?? {}).sort(), name).toEqual([
        'assignedUserId',
        'controlMode',
        'id',
        'locality',
        'name',
        'openedAt',
        'opportunityStatus',
        'regionCode',
        'stageKey',
        'status',
        'timeZone',
        'timeZoneUnresolvedReason',
        'website',
      ]);
    }
  });

  it('carries the opportunity id only for the firms the caller could act on', async () => {
    const own = await readPipelineBoardForActor(assignee);
    expect(own.opportunityIdByFirmId[crm.alpha.firmId]).toBe(crm.alpha.opportunityId);

    // The colleague sees the firm and its stage, and is offered no stage change,
    // because the mutation would be refused under the firm's row lock anyway. The
    // board says so before the click rather than after it.
    const theirs = await readPipelineBoardForActor(colleague);
    expect(theirs.opportunityIdByFirmId[crm.alpha.firmId]).toBeUndefined();
    expect(Object.keys(theirs.opportunityIdByFirmId)).toEqual([]);

    // An admin may change any firm's stage, so an admin gets every id.
    const theAdmins = await readPipelineBoardForActor(admin);
    expect(theAdmins.opportunityIdByFirmId[crm.alpha.firmId]).toBe(crm.alpha.opportunityId);
  });

  it('never crosses a workspace, even with colliding firm names', async () => {
    const board = await readPipelineBoardForActor(admin);
    const firms = board.columns.flatMap(column => column.firms);
    expect(firms.map(firm => firm.id)).not.toContain(crm.beta.firmId);
    expect(Object.keys(board.opportunityIdByFirmId)).not.toContain(crm.beta.firmId);
    expect(board.opportunityIdByFirmId[crm.alpha.firmId]).not.toBe(crm.beta.opportunityId);
  });

  it('puts every stage in the board, including retired ones, in order', async () => {
    const board = await readPipelineBoardForActor(admin);
    expect(board.columns.map(column => column.stage.key)).toEqual([
      'new',
      'contacting',
      'engaged',
      'qualified',
      'proposal',
      'won',
      'lost',
    ]);
    // Exactly one column holds the seeded firm, and it is the one its stage names.
    const holding = board.columns.filter(column => column.firms.length > 0);
    expect(holding).toHaveLength(1);
    expect(holding[0]?.stage.key).toBe('new');
  });
});
