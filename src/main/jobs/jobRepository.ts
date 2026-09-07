import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AppDatabase } from '../db/database';
import type { DomainUnitOfWork } from '../domain/support/domainUnitOfWork';
import { PRIORITY_PROJECTION_REBUILD_JOB_TYPE } from '../domain/startup/domainStartupTypes';
import type { EnqueueJobInput, JobRecord, JobState } from './jobTypes';

export type { EnqueueJobInput, JobRecord, JobState } from './jobTypes';

export type DiscoveryJobType = 'discovery_assessment' | typeof PRIORITY_PROJECTION_REBUILD_JOB_TYPE;
const discoveryJobTypeSchema = z.enum(['discovery_assessment', PRIORITY_PROJECTION_REBUILD_JOB_TYPE]);
const queryLimitSchema = z.number().int().min(1).max(50);
const retryableDiscoverySql = `state = 'failed' AND retry_count < 3
  AND error_code IN ('discovery_transient', 'interrupted_by_restart', 'research_timeout', 'research_failed')`;
const discoveryDueSql = `CASE WHEN state IN ('queued', 'running') THEN 0
  ELSE unixepoch(updated_at, 'subsec') * 1000 + CASE retry_count WHEN 0 THEN 1000 WHEN 1 THEN 5000 ELSE 30000 END END`;
const diagnosticStatusSchema = z.object({ kind: z.literal('discovery_diagnostic_status_v1'),
  status: z.enum(['resolved', 'unresolved']) }).strict();
const diagnosticIdSchema = z.string().min(1).refine(value => value.trim() === value);
const resolvedDiagnosticJson = JSON.stringify(diagnosticStatusSchema.parse({ kind: 'discovery_diagnostic_status_v1', status: 'resolved' }));
// Only diagnostic failures with canonical command ownership can carry this metadata.
// The same predicate protects writes and status filtering before LIMIT.
const ownedDiagnosticSql = `error_code IN ('invalid_evidence', 'evidence_too_large') AND CASE WHEN json_valid(payload_json) THEN
  json_type(payload_json, '$.formatVersion') = 'integer' AND json_extract(payload_json, '$.formatVersion') = 1
  AND json_type(payload_json, '$.prospectId') = 'text'
  AND length(trim(json_extract(payload_json, '$.prospectId'))) > 0
  AND trim(json_extract(payload_json, '$.prospectId')) = json_extract(payload_json, '$.prospectId')
  AND ((type = 'discovery_assessment' AND json_type(payload_json, '$.personId') = 'text'
    AND length(trim(json_extract(payload_json, '$.personId'))) > 0
    AND trim(json_extract(payload_json, '$.personId')) = json_extract(payload_json, '$.personId'))
    OR (type = '${PRIORITY_PROJECTION_REBUILD_JOB_TYPE}' AND json_type(payload_json, '$.jobId') = 'text'
      AND json_extract(payload_json, '$.jobId') = id))
  ELSE 0 END`;

const jobStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const jobIdSchema = z.string().min(1);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const errorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
const enqueueJobInputSchema = z.object({
  id: jobIdSchema.optional(),
  type: z.string().min(1),
  idempotencyKey: z.string().trim().min(1).optional(),
  payload: z.unknown(),
  progressTotal: nonnegativeIntegerSchema.nullable().optional(),
  at: z.string().optional(),
});
const utcIsoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => {
    const timestamp = new Date(value);
    return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
  }, {
    message: 'Timestamp must use canonical UTC ISO format.',
  });
const storedJsonSchema = z.string().transform((value, context) => {
  try {
    return { value: JSON.parse(value) as unknown };
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stored JSON is malformed.',
    });
    return z.NEVER;
  }
});

const storedJobRowSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    idempotency_key: z.string().min(1).nullable(),
    state: jobStateSchema,
    progress_current: nonnegativeIntegerSchema,
    progress_total: nonnegativeIntegerSchema.nullable(),
    retry_count: nonnegativeIntegerSchema,
    payload_json: storedJsonSchema,
    result_json: storedJsonSchema.nullable(),
    error_code: z.string().min(1).nullable(),
    error_message: z.string().min(1).nullable(),
    created_at: utcIsoTimestampSchema,
    started_at: utcIsoTimestampSchema.nullable(),
    finished_at: utcIsoTimestampSchema.nullable(),
    updated_at: utcIsoTimestampSchema,
  })
  .superRefine((row, context) => {
    if (row.progress_total !== null && row.progress_current > row.progress_total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Job progress cannot exceed its total.',
        path: ['progress_current'],
      });
    }

    if ((row.error_code === null) !== (row.error_message === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Job errors require both a code and a message.',
        path: ['error_code'],
      });
    }

    switch (row.state) {
      case 'queued':
        addLifecycleIssues(context, row, {
          resultMustBeNull: true,
          errorMustBeNull: true,
          startedAtMustBeNull: true,
          finishedAtMustBeNull: true,
        });
        break;
      case 'running':
        addLifecycleIssues(context, row, {
          resultMustBeNull: true,
          errorMustBeNull: true,
          startedAtMustBePresent: true,
          finishedAtMustBeNull: true,
        });
        break;
      case 'succeeded':
        addLifecycleIssues(context, row, {
          resultMustBePresent: true,
          errorMustBeNull: true,
          startedAtMustBePresent: true,
          finishedAtMustBePresent: true,
        });
        break;
      case 'failed':
        addLifecycleIssues(context, row, {
          resultMustBeNull: row.result_json === null,
          errorMustBePresent: true,
          startedAtMustBePresent: true,
          finishedAtMustBePresent: true,
        });
        if (row.result_json !== null) {
          const identity = z.object({ formatVersion: z.literal(1), prospectId: diagnosticIdSchema,
            personId: diagnosticIdSchema.optional(), jobId: diagnosticIdSchema.optional() }).safeParse(row.payload_json.value);
          if (!diagnosticStatusSchema.safeParse(row.result_json.value).success
            || !['invalid_evidence', 'evidence_too_large'].includes(row.error_code ?? '') || !identity.success
            || !(row.type === 'discovery_assessment' && identity.data.personId
              || row.type === PRIORITY_PROJECTION_REBUILD_JOB_TYPE && identity.data.jobId === row.id)) {
            context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid diagnostic resolution metadata.', path: ['result_json'] });
          }
        }
        break;
      case 'cancelled':
        addLifecycleIssues(context, row, {
          resultMustBeNull: true,
          errorMustBeNull: true,
          startedAtMustBeNull: true,
          finishedAtMustBePresent: true,
        });
        break;
    }

  });

type StoredJobRow = z.infer<typeof storedJobRowSchema>;

const returnedJobColumns = `
  id,
  type,
  idempotency_key,
  state,
  progress_current,
  progress_total,
  retry_count,
  payload_json,
  result_json,
  error_code,
  error_message,
  created_at,
  started_at,
  finished_at,
  updated_at
`;

export class InvalidJobTransitionError extends Error {
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Job ${jobId} is not in a state that permits this transition.`);
    this.name = 'InvalidJobTransitionError';
    this.jobId = jobId;
  }
}

export class JobRepository {
  constructor(private readonly database: AppDatabase) {}

  enqueue(input: EnqueueJobInput): JobRecord {
    const parsedInput = enqueueJobInputSchema.parse(input);
    const id = jobIdSchema.parse(parsedInput.id ?? randomUUID());
    const progressTotal = parseProgressTotal(parsedInput.progressTotal ?? null);
    const timestamp = parsedInput.at ?? new Date().toISOString();
    const payloadJson = serializeJson(parsedInput.payload, 'payload');
    const idempotencyKey = parsedInput.idempotencyKey ?? null;

    const row = this.database.raw
      .prepare(
        `INSERT INTO jobs (
          id, type, idempotency_key, state, progress_current, progress_total, retry_count, payload_json,
          result_json, error_code, error_message, created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 0, ?, 0, ?, NULL, NULL, NULL, ?, NULL, NULL, ?)
        ON CONFLICT(type, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
        RETURNING ${returnedJobColumns}`,
      )
      .get(
        id,
        parsedInput.type,
        idempotencyKey,
        progressTotal,
        payloadJson,
        timestamp,
        timestamp,
      );

    if (row === undefined) {
      if (idempotencyKey === null) {
        throw new Error('Unkeyed job insertion did not return a row.');
      }
      const canonical = this.database.raw.prepare(
        `SELECT ${returnedJobColumns}
         FROM jobs
         WHERE type = ? AND idempotency_key = ?`,
      ).get(parsedInput.type, idempotencyKey);
      if (canonical === undefined) {
        throw new Error('Canonical idempotent job is missing.');
      }
      return parseStoredJobRow(canonical);
    }

    return parseStoredJobRow(row);
  }

  start(id: string, at?: string): JobRecord {
    const timestamp = utcIsoTimestampSchema.parse(at ?? new Date().toISOString());

    return this.updateAndRead(
      `UPDATE jobs
       SET state = 'running', started_at = ?, updated_at = ?
       WHERE id = ? AND state = 'queued'
       RETURNING ${returnedJobColumns}`,
      [timestamp, timestamp, id],
      id,
    );
  }

  reportProgress(id: string, current: number, total?: number | null): JobRecord {
    const progressCurrent = parseProgressCurrent(current);
    const hasNewTotal = total !== undefined;
    const progressTotal = hasNewTotal ? parseProgressTotal(total) : null;

    if (progressTotal !== null && progressCurrent > progressTotal) {
      throw new RangeError('Job progress cannot exceed its total.');
    }

    const timestamp = new Date().toISOString();

    return this.updateAndRead(
      `UPDATE jobs
       SET progress_current = ?,
           progress_total = CASE WHEN ? THEN ? ELSE progress_total END,
           updated_at = ?
       WHERE id = ?
         AND state = 'running'
         AND (
           (CASE WHEN ? THEN ? ELSE progress_total END) IS NULL
           OR ? <= (CASE WHEN ? THEN ? ELSE progress_total END)
         )
       RETURNING ${returnedJobColumns}`,
      [
        progressCurrent,
        hasNewTotal ? 1 : 0,
        progressTotal,
        timestamp,
        id,
        hasNewTotal ? 1 : 0,
        progressTotal,
        progressCurrent,
        hasNewTotal ? 1 : 0,
        progressTotal,
      ],
      id,
    );
  }

  succeed(id: string, result: unknown, at?: string): JobRecord {
    const timestamp = utcIsoTimestampSchema.parse(at ?? new Date().toISOString());
    const resultJson = serializeJson(result, 'result');

    return this.updateAndRead(
      `UPDATE jobs
       SET state = 'succeeded', result_json = ?, error_code = NULL, error_message = NULL,
           finished_at = ?, updated_at = ?
       WHERE id = ? AND state = 'running'
       RETURNING ${returnedJobColumns}`,
      [resultJson, timestamp, timestamp, id],
      id,
    );
  }

  fail(id: string, error: { code: string; message: string }, at?: string): JobRecord {
    const parsedError = errorSchema.parse(error);
    const timestamp = utcIsoTimestampSchema.parse(at ?? new Date().toISOString());

    return this.updateAndRead(
      `UPDATE jobs
       SET state = 'failed', error_code = ?, error_message = ?, result_json = NULL,
           finished_at = ?, updated_at = ?
       WHERE id = ? AND state = 'running'
       RETURNING ${returnedJobColumns}`,
      [parsedError.code, parsedError.message, timestamp, timestamp, id],
      id,
    );
  }

  cancel(id: string): JobRecord {
    const timestamp = new Date().toISOString();

    return this.updateAndRead(
      `UPDATE jobs
       SET state = 'cancelled', result_json = NULL, error_code = NULL, error_message = NULL,
           finished_at = ?, updated_at = ?
       WHERE id = ? AND state = 'queued'
       RETURNING ${returnedJobColumns}`,
      [timestamp, timestamp, id],
      id,
    );
  }

  get(id: string): JobRecord | null {
    const row = this.database.raw
      .prepare(`SELECT ${returnedJobColumns} FROM jobs WHERE id = ?`)
      .get(id);

    return row === undefined ? null : parseStoredJobRow(row);
  }

  listActive(): JobRecord[] {
    const rows = this.database.raw
      .prepare(
        `SELECT ${returnedJobColumns}
         FROM jobs
         WHERE state IN ('queued', 'running')
         ORDER BY created_at ASC, id ASC`,
      )
      .all();

    return rows.map(parseStoredJobRow);
  }

  /** Evidence revalidation, not a job success or retry. Original error, payload and lifecycle stay intact. */
  reconcileDiscoveryDiagnostics(input: { personId: string; prospectId: string; scope: 'assessment' | 'priority';
    proof: 'invalid' | 'valid_evidence' | 'current_result' },
    unitOfWork: DomainUnitOfWork): void {
    if (unitOfWork.database.raw !== this.database.raw) throw new Error('DISCOVERY_DIAGNOSTIC_DATABASE_MISMATCH');
    unitOfWork.assertWriteScope();
    const parsed = z.object({ personId: diagnosticIdSchema, prospectId: diagnosticIdSchema,
      scope: z.enum(['assessment', 'priority']), proof: z.enum(['invalid', 'valid_evidence', 'current_result']) }).strict().parse(input);
    const resolved = parsed.proof !== 'invalid';
    const metadata = JSON.stringify(diagnosticStatusSchema.parse({ kind: 'discovery_diagnostic_status_v1',
      status: resolved ? 'resolved' : 'unresolved' }));
    const scope = parsed.scope === 'assessment'
      ? `type = 'discovery_assessment' AND json_extract(payload_json, '$.kind') IS NULL`
      : `(type = '${PRIORITY_PROJECTION_REBUILD_JOB_TYPE}' OR json_extract(payload_json, '$.kind') = 'priority_diagnostic')`;
    const rows = this.database.raw.prepare(`SELECT ${returnedJobColumns} FROM jobs
      WHERE state = 'failed' AND (${ownedDiagnosticSql}) AND (${scope})
      AND json_extract(payload_json, '$.prospectId') = ?
      AND (type = '${PRIORITY_PROJECTION_REBUILD_JOB_TYPE}' OR json_extract(payload_json, '$.personId') = ?)
      AND EXISTS (SELECT 1 FROM prospects p JOIN persons n ON n.id = p.person_id WHERE p.id = ? AND n.id = ?)
      AND (? OR (type = 'discovery_assessment' AND json_extract(payload_json, '$.diagnostic') IN ('invalid_evidence', 'evidence_too_large')
        AND ((json_extract(payload_json, '$.kind') = 'priority_diagnostic' AND json_extract(payload_json, '$.diagnostic') = 'invalid_evidence')
          OR (json_extract(payload_json, '$.kind') IS NULL AND json_extract(payload_json, '$.fingerprint') IS NULL
            AND json_extract(payload_json, '$.salesCycleId') IS NULL))))
      AND result_json IS NOT ? AND (? OR result_json IS NOT NULL)
      ORDER BY created_at, id LIMIT 50`).all(parsed.prospectId, parsed.personId, parsed.prospectId, parsed.personId,
      parsed.proof !== 'valid_evidence' ? 1 : 0, metadata, resolved ? 1 : 0);
    for (const row of rows) {
      const job = parseStoredJobRow(row);
      this.database.raw.prepare("UPDATE jobs SET result_json = ? WHERE id = ? AND state = 'failed'").run(metadata, job.id);
    }
  }

  listUnresolvedDiscoveryFailures(limit: number): JobRecord[] {
    return this.database.raw.prepare(`SELECT ${returnedJobColumns} FROM jobs
      WHERE type IN ('discovery_assessment', '${PRIORITY_PROJECTION_REBUILD_JOB_TYPE}') AND state = 'failed'
      AND NOT (result_json IS ? AND coalesce((${ownedDiagnosticSql}), 0))
      ORDER BY created_at, id LIMIT ?`).all(resolvedDiagnosticJson, queryLimitSchema.parse(limit)).map(parseStoredJobRow);
  }

  listByTypeState(type: DiscoveryJobType, state: JobState, limit: number): JobRecord[] {
    const rows = this.database.raw.prepare(`SELECT ${returnedJobColumns} FROM jobs
      WHERE type = ? AND state = ? ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all(discoveryJobTypeSchema.parse(type), jobStateSchema.parse(state), queryLimitSchema.parse(limit));
    return rows.map(parseStoredJobRow);
  }

  retryFailed(id: string, at: string): JobRecord {
    const timestamp = utcIsoTimestampSchema.parse(at);
    return this.updateAndRead(`UPDATE jobs SET state = 'queued', retry_count = retry_count + 1,
      progress_current = 0, result_json = NULL, error_code = NULL, error_message = NULL,
      started_at = NULL, finished_at = NULL, updated_at = ?
      WHERE id = ? AND type IN (?, ?) AND state = 'failed' AND retry_count < 3 RETURNING ${returnedJobColumns}`,
    [timestamp, jobIdSchema.parse(id), 'discovery_assessment', PRIORITY_PROJECTION_REBUILD_JOB_TYPE], id);
  }

  /** Filter BEFORE LIMIT so exhausted/diagnostic failures cannot starve later jobs. */
  listDueDiscovery(at: string, limit: number): JobRecord[] {
    const now = Date.parse(utcIsoTimestampSchema.parse(at));
    return this.database.raw.prepare(`SELECT ${returnedJobColumns} FROM jobs
      WHERE type IN (?, ?) AND (state IN ('queued', 'running') OR (${retryableDiscoverySql}))
      AND ${discoveryDueSql} <= ? ORDER BY created_at ASC, id ASC LIMIT ?`)
      .all('discovery_assessment', PRIORITY_PROJECTION_REBUILD_JOB_TYPE, now, queryLimitSchema.parse(limit)).map(parseStoredJobRow);
  }

  nextDiscoveryDelay(at: string): number | null {
    const now = Date.parse(utcIsoTimestampSchema.parse(at));
    const row = this.database.raw.prepare(`SELECT min(${discoveryDueSql}) AS due FROM jobs
      WHERE type IN (?, ?) AND (state IN ('queued', 'running') OR (${retryableDiscoverySql}))`)
      .get('discovery_assessment', PRIORITY_PROJECTION_REBUILD_JOB_TYPE) as { due: number | null };
    return row.due === null ? null : Math.max(0, z.number().finite().parse(row.due) - now);
  }

  recoverInterruptedJobs(at?: string): number {
    const timestamp = at ?? new Date().toISOString();
    const result = this.database.raw
      .prepare(
        `UPDATE jobs
         SET state = 'failed', error_code = 'interrupted_by_restart',
             error_message = 'Job interrupted by application restart.',
             result_json = NULL, finished_at = ?, updated_at = ?
         WHERE state = 'running'`,
      )
      .run(timestamp, timestamp);

    return result.changes;
  }

  private updateAndRead(sql: string, parameters: unknown[], jobId: string): JobRecord {
    const row = this.database.raw.prepare(sql).get(...parameters);

    if (row === undefined) {
      throw new InvalidJobTransitionError(jobId);
    }

    return parseStoredJobRow(row);
  }
}

function parseProgressCurrent(value: number): number {
  return nonnegativeIntegerSchema.parse(value);
}

function parseProgressTotal(value: number | null): number | null {
  return nonnegativeIntegerSchema.nullable().parse(value);
}

function serializeJson(value: unknown, field: string): string {
  const serialized = JSON.stringify(value);

  if (serialized === undefined) {
    throw new TypeError(`Job ${field} must be JSON-serializable.`);
  }

  return serialized;
}

function parseStoredJobRow(value: unknown): JobRecord {
  const row = storedJobRowSchema.parse(value) as StoredJobRow;

  return {
    id: row.id,
    type: row.type,
    idempotencyKey: row.idempotency_key,
    state: row.state,
    progressCurrent: row.progress_current,
    progressTotal: row.progress_total,
    retryCount: row.retry_count,
    payload: row.payload_json.value,
    result: row.result_json === null ? null : row.result_json.value,
    error:
      row.error_code === null
        ? null
        : {
            code: row.error_code,
            message: row.error_message as string,
          },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type LifecycleRequirements = {
  resultMustBeNull?: boolean;
  resultMustBePresent?: boolean;
  errorMustBeNull?: boolean;
  errorMustBePresent?: boolean;
  startedAtMustBeNull?: boolean;
  startedAtMustBePresent?: boolean;
  finishedAtMustBeNull?: boolean;
  finishedAtMustBePresent?: boolean;
};

function addLifecycleIssues(
  context: z.RefinementCtx,
  row: StoredJobRow,
  requirements: LifecycleRequirements,
): void {
  const hasError = row.error_code !== null;

  addPresenceIssue(context, row.result_json, 'result_json', requirements.resultMustBeNull, requirements.resultMustBePresent);
  addPresenceIssue(context, hasError ? row.error_code : null, 'error_code', requirements.errorMustBeNull, requirements.errorMustBePresent);
  addPresenceIssue(context, row.started_at, 'started_at', requirements.startedAtMustBeNull, requirements.startedAtMustBePresent);
  addPresenceIssue(context, row.finished_at, 'finished_at', requirements.finishedAtMustBeNull, requirements.finishedAtMustBePresent);
}

function addPresenceIssue(
  context: z.RefinementCtx,
  value: unknown | null,
  field: string,
  mustBeNull: boolean | undefined,
  mustBePresent: boolean | undefined,
): void {
  if ((mustBeNull && value !== null) || (mustBePresent && value === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid lifecycle value for ${field}.`,
      path: [field],
    });
  }
}
