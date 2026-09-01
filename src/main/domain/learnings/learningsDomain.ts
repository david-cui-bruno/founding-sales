import type { AppDatabase } from '../../db/database';
import {
  mutationReceiptSchema,
  type MutationReceipt,
} from '../../../shared/contracts/commonContract';
import {
  addEvidenceRequestSchema,
  captureLearningRequestSchema,
  learningsListRequestSchema,
  learningsListResponseSchema,
  updateLearningStatusRequestSchema,
  type AddEvidenceRequest,
  type CaptureEvidence,
  type CaptureLearningRequest,
  type LearningRow,
  type LearningsListRequest,
  type LearningsListResponse,
  type UpdateLearningStatusRequest,
} from '../../../shared/contracts/learningsContract';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';

export type LearningsDomainErrorCode =
  | 'LEARNING_NOT_FOUND'
  | 'LEARNING_VERSION_CONFLICT'
  | 'LEARNING_STATUS_INVALID'
  | 'EVIDENCE_PERSON_NOT_FOUND'
  | 'CONTRADICTION_TARGET_INVALID';

/** Safe, renderer-presentable domain error: no SQL, paths, or key material. */
export class LearningsDomainError extends Error {
  readonly code: LearningsDomainErrorCode;

  constructor(code: LearningsDomainErrorCode, message: string) {
    super(message);
    this.name = 'LearningsDomainError';
    this.code = code;
  }
}

export type LearningsDomainDeps = {
  database: AppDatabase;
  clock: Clock;
  ids: IdGenerator;
};

type LearningTableRow = {
  id: string;
  category: LearningRow['category'];
  statement: string;
  status: LearningRow['status'];
  status_reason: string | null;
  confidence: LearningRow['confidence'];
  contradiction_of: string | null;
  version: number;
  created_at: string;
};

type EvidenceTableRow = {
  id: string;
  learning_id: string;
  person_id: string | null;
  person_name: string | null;
  activity_id: string | null;
  quote: string;
  noted_at: string;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function currentRevision(database: AppDatabase): number {
  return (database.raw.prepare(
    'SELECT total_changes() AS count',
  ).get() as { count: number }).count;
}

function receipt(deps: LearningsDomainDeps, personIds: string[]): MutationReceipt {
  return mutationReceiptSchema.parse({
    revision: currentRevision(deps.database),
    affectedPersonIds: [...new Set(personIds)].sort(),
    affectedSalesCycleIds: [],
  });
}

function requirePersonExists(deps: LearningsDomainDeps, personId: string): void {
  const person = deps.database.raw.prepare(
    'SELECT id FROM persons WHERE id = ?',
  ).get(personId) as { id: string } | undefined;
  if (person === undefined) {
    throw new LearningsDomainError(
      'EVIDENCE_PERSON_NOT_FOUND',
      'The evidence names a person who does not exist.',
    );
  }
}

function insertEvidenceRow(
  deps: LearningsDomainDeps,
  learningId: string,
  evidence: CaptureEvidence,
  createdAt: string,
): void {
  if (evidence.personId !== null) {
    requirePersonExists(deps, evidence.personId);
  }
  deps.database.raw.prepare(`
    INSERT INTO learning_evidence (
      id, learning_id, person_id, activity_id, quote, noted_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    deps.ids.next(),
    learningId,
    evidence.personId,
    evidence.activityId,
    evidence.quote,
    evidence.notedAt,
    createdAt,
  );
}

function readLearningForUpdate(
  deps: LearningsDomainDeps,
  learningId: string,
  expectedVersion: number,
): LearningTableRow {
  const row = deps.database.raw.prepare(`
    SELECT id, category, statement, status, status_reason, confidence,
      contradiction_of, version, created_at
    FROM learnings WHERE id = ?
  `).get(learningId) as LearningTableRow | undefined;
  if (row === undefined) {
    throw new LearningsDomainError('LEARNING_NOT_FOUND', 'The learning does not exist.');
  }
  if (row.version !== expectedVersion) {
    throw new LearningsDomainError(
      'LEARNING_VERSION_CONFLICT',
      'The learning changed concurrently. Reload and retry.',
    );
  }
  return row;
}

export function listLearnings(
  deps: LearningsDomainDeps,
  input: LearningsListRequest,
): LearningsListResponse {
  const request = learningsListRequestSchema.parse(input);
  const filters: string[] = [];
  const parameters: unknown[] = [];
  if (request.categories.length > 0) {
    filters.push(
      `learning.category IN (${request.categories.map(() => '?').join(', ')})`,
    );
    parameters.push(...request.categories);
  }
  if (request.statuses.length > 0) {
    filters.push(
      `learning.status IN (${request.statuses.map(() => '?').join(', ')})`,
    );
    parameters.push(...request.statuses);
  }
  if (request.query.length > 0) {
    filters.push(`(
      learning.statement LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM learning_evidence AS quoted
        WHERE quoted.learning_id = learning.id
          AND quoted.quote LIKE ? ESCAPE '\\'
      )
    )`);
    const pattern = `%${escapeLike(request.query)}%`;
    parameters.push(pattern, pattern);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

  const learningRows = deps.database.raw.prepare(`
    SELECT learning.id, learning.category, learning.statement, learning.status,
      learning.status_reason, learning.confidence, learning.contradiction_of,
      learning.version, learning.created_at
    FROM learnings AS learning
    JOIN (
      SELECT learning_id, MAX(noted_at) AS latest_noted_at
      FROM learning_evidence GROUP BY learning_id
    ) AS observation ON observation.learning_id = learning.id
    ${where}
    ORDER BY CASE WHEN learning.status = 'active' THEN 0 ELSE 1 END,
      observation.latest_noted_at DESC, learning.id ASC
    LIMIT ?
  `).all(...parameters, request.limit) as LearningTableRow[];

  const evidenceStatement = deps.database.raw.prepare(`
    SELECT evidence.id, evidence.learning_id, evidence.person_id,
      person.display_name AS person_name, evidence.activity_id,
      evidence.quote, evidence.noted_at
    FROM learning_evidence AS evidence
    LEFT JOIN persons AS person ON person.id = evidence.person_id
    WHERE evidence.learning_id = ?
    ORDER BY evidence.noted_at ASC, evidence.id ASC
  `);

  const rows: LearningRow[] = learningRows.map((learning) => {
    const evidence = evidenceStatement.all(learning.id) as EvidenceTableRow[];
    return {
      learningId: learning.id,
      category: learning.category,
      statement: learning.statement,
      status: learning.status,
      statusReason: learning.status_reason,
      confidence: learning.confidence,
      sampleSize: evidence.length,
      firstObservedAt: evidence[0]!.noted_at,
      latestObservedAt: evidence[evidence.length - 1]!.noted_at,
      evidence: evidence.map((item) => ({
        id: item.id,
        personId: item.person_id,
        personName: item.person_name,
        activityId: item.activity_id,
        quote: item.quote,
        notedAt: item.noted_at,
      })),
      contradictionOf: learning.contradiction_of,
      createdAt: learning.created_at,
      version: learning.version,
    };
  });

  const totalActiveCount = (deps.database.raw.prepare(
    "SELECT COUNT(*) AS count FROM learnings WHERE status = 'active'",
  ).get() as { count: number }).count;

  return learningsListResponseSchema.parse({
    rows,
    totalActiveCount,
    revision: currentRevision(deps.database),
  });
}

export function captureLearning(
  deps: LearningsDomainDeps,
  input: CaptureLearningRequest,
): MutationReceipt {
  const request = captureLearningRequestSchema.parse(input);
  const now = deps.clock.now();
  const transaction = deps.database.raw.transaction(() => {
    const learningId = deps.ids.next();
    if (request.contradictionOf !== null) {
      const target = deps.database.raw.prepare(
        'SELECT id, status, version FROM learnings WHERE id = ?',
      ).get(request.contradictionOf) as {
        id: string; status: string; version: number;
      } | undefined;
      if (target === undefined || target.status !== 'active') {
        throw new LearningsDomainError(
          'CONTRADICTION_TARGET_INVALID',
          'A contradiction must reference an existing active learning.',
        );
      }
      deps.database.raw.prepare(`
        UPDATE learnings
        SET status = 'contradicted', status_reason = ?,
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(`Contradicted by ${learningId}`, now, target.id, target.version);
    }
    deps.database.raw.prepare(`
      INSERT INTO learnings (
        id, category, statement, status, status_reason, confidence,
        contradiction_of, version, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', NULL, ?, ?, 1, ?, ?)
    `).run(
      learningId,
      request.category,
      request.statement,
      request.confidence,
      request.contradictionOf,
      now,
      now,
    );
    for (const evidence of request.evidence) {
      insertEvidenceRow(deps, learningId, evidence, now);
    }
    return receipt(
      deps,
      request.evidence.flatMap(
        (evidence) => (evidence.personId === null ? [] : [evidence.personId]),
      ),
    );
  });
  return transaction.immediate();
}

export function addLearningEvidence(
  deps: LearningsDomainDeps,
  input: AddEvidenceRequest,
): MutationReceipt {
  const request = addEvidenceRequestSchema.parse(input);
  const now = deps.clock.now();
  const transaction = deps.database.raw.transaction(() => {
    const learning = readLearningForUpdate(
      deps, request.learningId, request.expectedVersion,
    );
    insertEvidenceRow(deps, learning.id, request.evidence, now);
    const changed = deps.database.raw.prepare(`
      UPDATE learnings SET version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(now, learning.id, request.expectedVersion);
    if (changed.changes !== 1) {
      throw new LearningsDomainError(
        'LEARNING_VERSION_CONFLICT',
        'The learning changed concurrently. Reload and retry.',
      );
    }
    return receipt(
      deps,
      request.evidence.personId === null ? [] : [request.evidence.personId],
    );
  });
  return transaction.immediate();
}

export function updateLearningStatus(
  deps: LearningsDomainDeps,
  input: UpdateLearningStatusRequest,
): MutationReceipt {
  const request = updateLearningStatusRequestSchema.parse(input);
  const now = deps.clock.now();
  const transaction = deps.database.raw.transaction(() => {
    const learning = readLearningForUpdate(
      deps, request.learningId, request.expectedVersion,
    );
    if (learning.status === request.status) {
      throw new LearningsDomainError(
        'LEARNING_STATUS_INVALID',
        `The learning is already ${request.status}.`,
      );
    }
    const statusReason = request.status === 'contradicted' ? request.reason : null;
    const changed = deps.database.raw.prepare(`
      UPDATE learnings
      SET status = ?, status_reason = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(request.status, statusReason, now, learning.id, request.expectedVersion);
    if (changed.changes !== 1) {
      throw new LearningsDomainError(
        'LEARNING_VERSION_CONFLICT',
        'The learning changed concurrently. Reload and retry.',
      );
    }
    return receipt(deps, []);
  });
  return transaction.immediate();
}
