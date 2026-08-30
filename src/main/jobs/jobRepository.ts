import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AppDatabase } from '../db/database';
import type { EnqueueJobInput, JobRecord } from './jobTypes';

export type { EnqueueJobInput, JobRecord, JobState } from './jobTypes';

const jobStateSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const errorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

const storedJobRowSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    state: jobStateSchema,
    progress_current: nonnegativeIntegerSchema,
    progress_total: nonnegativeIntegerSchema.nullable(),
    retry_count: nonnegativeIntegerSchema,
    payload_json: z.string(),
    result_json: z.string().nullable(),
    error_code: z.string().min(1).nullable(),
    error_message: z.string().min(1).nullable(),
    created_at: z.string().datetime({ offset: true }),
    started_at: z.string().datetime({ offset: true }).nullable(),
    finished_at: z.string().datetime({ offset: true }).nullable(),
    updated_at: z.string().datetime({ offset: true }),
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
    const id = input.id ?? randomUUID();
    const type = z.string().min(1).parse(input.type);
    const progressTotal = parseProgressTotal(input.progressTotal ?? null);
    const timestamp = new Date().toISOString();
    const payloadJson = serializeJson(input.payload, 'payload');

    const row = this.database.raw
      .prepare(
        `INSERT INTO jobs (
          id, type, state, progress_current, progress_total, retry_count, payload_json,
          result_json, error_code, error_message, created_at, started_at, finished_at, updated_at
        ) VALUES (?, ?, 'queued', 0, ?, 0, ?, NULL, NULL, NULL, ?, NULL, NULL, ?)
        RETURNING ${returnedJobColumns}`,
      )
      .get(id, type, progressTotal, payloadJson, timestamp, timestamp);

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
    payload: JSON.parse(row.payload_json),
    result: row.result_json === null ? null : JSON.parse(row.result_json),
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
