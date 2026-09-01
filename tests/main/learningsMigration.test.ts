import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { migration0004Learnings } from '../../src/main/db/migrations/0004Learnings';
import { insertPerson, seedProspect, DOMAIN_TIMESTAMP } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

describe('0004Learnings migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    await migration0004Learnings.up(database.kysely);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function insertLearning(input: {
    id: string;
    category?: string;
    statement?: string;
    status?: string;
    statusReason?: string | null;
    confidence?: string;
    contradictionOf?: string | null;
  }): void {
    database.raw.prepare(`
      INSERT INTO learnings (
        id, category, statement, status, status_reason, confidence,
        contradiction_of, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.id,
      input.category ?? 'pain',
      input.statement ?? 'Owners lose weekends to showings.',
      input.status ?? 'active',
      input.statusReason ?? null,
      input.confidence ?? 'medium',
      input.contradictionOf ?? null,
      DOMAIN_TIMESTAMP,
      DOMAIN_TIMESTAMP,
    );
  }

  function insertEvidence(input: {
    id: string;
    learningId: string;
    personId?: string | null;
    activityId?: string | null;
    quote?: string;
  }): void {
    database.raw.prepare(`
      INSERT INTO learning_evidence (
        id, learning_id, person_id, activity_id, quote, noted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.learningId,
      input.personId ?? null,
      input.activityId ?? null,
      input.quote ?? 'We keep losing weekends to showings.',
      DOMAIN_TIMESTAMP,
      DOMAIN_TIMESTAMP,
    );
  }

  it('creates the learnings tables and evidence index', () => {
    const objects = database.raw.prepare<[], { name: string; type: string }>(`
      SELECT name, type FROM sqlite_master
      WHERE name IN ('learnings', 'learning_evidence', 'learning_evidence_learning_idx')
      ORDER BY name
    `).all();

    expect(objects).toEqual([
      { name: 'learning_evidence', type: 'table' },
      { name: 'learning_evidence_learning_idx', type: 'index' },
      { name: 'learnings', type: 'table' },
    ]);
  });

  it('stores a learning with person-linked evidence', () => {
    insertPerson(database.raw, 'person-1');
    insertLearning({ id: 'learning-1' });
    insertEvidence({ id: 'evidence-1', learningId: 'learning-1', personId: 'person-1' });

    expect(database.raw.prepare(
      'SELECT COUNT(*) AS count FROM learning_evidence',
    ).get()).toEqual({ count: 1 });
  });

  it('rejects unknown categories, confidences, statuses, and blank statements', () => {
    expect(() => insertLearning({ id: 'bad', category: 'vibes' })).toThrow();
    expect(() => insertLearning({ id: 'bad', confidence: 'certain' })).toThrow();
    expect(() => insertLearning({ id: 'bad', status: 'archived' })).toThrow();
    expect(() => insertLearning({ id: 'bad', statement: '   ' })).toThrow();
  });

  it('requires a reason when a learning is stored contradicted', () => {
    expect(() => insertLearning({
      id: 'bad', status: 'contradicted', statusReason: null,
    })).toThrow();
    insertLearning({
      id: 'ok', status: 'contradicted', statusReason: 'Contradicted by learning-2',
    });
  });

  it('allows updating status, status_reason, confidence, version, updated_at', () => {
    insertLearning({ id: 'learning-1' });

    database.raw.prepare(`
      UPDATE learnings
      SET status = 'retired', status_reason = NULL, confidence = 'high',
        version = version + 1, updated_at = ?
      WHERE id = 'learning-1'
    `).run('2026-08-31T12:00:00.000Z');

    expect(database.raw.prepare(
      "SELECT status, confidence, version FROM learnings WHERE id = 'learning-1'",
    ).get()).toEqual({ status: 'retired', confidence: 'high', version: 2 });
  });

  it.each([
    ["statement = 'Rewritten claim.'"],
    ["category = 'objection'"],
    ["contradiction_of = 'learning-2'"],
    ["created_at = '2026-01-01T00:00:00.000Z'"],
  ])('rejects UPDATE of immutable learning column: %s', (assignment) => {
    insertLearning({ id: 'learning-1' });
    insertLearning({ id: 'learning-2' });

    expect(() => database.raw.prepare(
      `UPDATE learnings SET ${assignment} WHERE id = 'learning-1'`,
    ).run()).toThrow(/immutable/);
  });

  it('rejects DELETE on learnings', () => {
    insertLearning({ id: 'learning-1' });

    expect(() => database.raw.prepare(
      "DELETE FROM learnings WHERE id = 'learning-1'",
    ).run()).toThrow();
  });

  it('keeps evidence rows append-only', () => {
    insertLearning({ id: 'learning-1' });
    insertEvidence({ id: 'evidence-1', learningId: 'learning-1' });

    expect(() => database.raw.prepare(
      "UPDATE learning_evidence SET quote = 'Edited.' WHERE id = 'evidence-1'",
    ).run()).toThrow();
    expect(() => database.raw.prepare(
      "DELETE FROM learning_evidence WHERE id = 'evidence-1'",
    ).run()).toThrow();
  });

  it('enforces the learning and person foreign keys on evidence', () => {
    insertLearning({ id: 'learning-1' });

    expect(() => insertEvidence({
      id: 'evidence-orphan', learningId: 'missing-learning',
    })).toThrow();
    expect(() => insertEvidence({
      id: 'evidence-ghost', learningId: 'learning-1', personId: 'missing-person',
    })).toThrow();
  });

  it('requires activity evidence to belong to the evidence person', () => {
    const prospect = seedProspect(database.raw, 'alpha');
    insertPerson(database.raw, 'person-other');
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at, metadata_json, created_at
      ) VALUES ('activity-1', ?, 'call', 'outbound', 'phone', ?, '{}', ?)
    `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    insertLearning({ id: 'learning-1' });

    insertEvidence({
      id: 'evidence-1', learningId: 'learning-1',
      personId: prospect.personId, activityId: 'activity-1',
    });
    expect(() => insertEvidence({
      id: 'evidence-2', learningId: 'learning-1',
      personId: 'person-other', activityId: 'activity-1',
    })).toThrow();
  });

  it('rejects blank evidence quotes and a contradiction of a missing learning', () => {
    insertLearning({ id: 'learning-1' });

    expect(() => insertEvidence({
      id: 'evidence-blank', learningId: 'learning-1', quote: '  ',
    })).toThrow();
    expect(() => insertLearning({
      id: 'learning-2', contradictionOf: 'missing-learning',
    })).toThrow();
  });
});
