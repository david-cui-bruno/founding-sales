import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AppDatabase } from '../db/database';
import type { EnqueueJobInput, JobRecord } from './jobTypes';

export type { EnqueueJobInput, JobRecord, JobState } from './jobTypes';

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
  payload: z.unknown(),
  progressTotal: nonnegativeIntegerSchema.nullable().optional(),
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
          resultMustBeNull: true,
          errorMustBePresent: true,
          startedAtMustBePresent: true,
          finishedAtMustBePresent: true,
        });
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

export interface JobRepository {
  enqueue(input: EnqueueJobInput): JobRecord;
  start(id: string): JobRecord;
  reportProgress(id: string, current: number, total?: number | null): JobRecord;
  succeed(id: string, result: unknown): JobRecord;
  fail(id: string, error: { code: string; message: string }): JobRecord;
  cancel(id: string): JobRecord;
  get(id: string): JobRecord | null;
  listActive(): JobRecord[];
  recoverInterruptedJobs(): number;
}

export class JobRepository {
  constructor(private readonly database: AppDatabase) {}

  enqueue(input: EnqueueJobInput): JobRecord {
    const parsedInput = enqueueJobInputSchema.parse(input);
    const id = jobIdSchema.parse(parsedInput.id ?? randomUUID());
    const progressTotal = parseProgressTotal(parsedInput.progressTotal ?? null);
    const timestamp = new Date().toISOString();
    const payloadJson = serializeJson(parsedInput.payload, 'payload');

    const row = this.database.raw
      .prepare(
        `INSERT INTO jobs (
          id, type, state, progress_current, progress_total, retry_count, payload_json,
          result_json, error_code, error_message, created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, 'queued', 0, ?, 0, ?, NULL, NULL, NULL, ?, NULL, NULL, ?)
        RETURNING ${returnedJobColumns}`,
      )
      .get(id, parsedInput.type, progressTotal, payloadJson, timestamp, timestamp);

    return parseStoredJobRow(row);
  }

  start(id: string): JobRecord {
    const timestamp = new Date().toISOString();

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

  succeed(id: string, result: unknown): JobRecord {
    const timestamp = new Date().toISOString();
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

  fail(id: string, error: { code: string; message: string }): JobRecord {
    const parsedError = errorSchema.parse(error);
    const timestamp = new Date().toISOString();

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

  recoverInterruptedJobs(): number {
    const timestamp = new Date().toISOString();
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
