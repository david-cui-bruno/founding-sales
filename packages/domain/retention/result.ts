/**
 * The outcome shape every retention command answers with. The refusal codes are a
 * closed union per command, and `commandResultOf` in `apps/api/src/routes/retentionSupport.ts`
 * widens it to the route's `CommandResult`.
 */

export type RetentionResult<T, Reason extends string> =
  | { readonly ok: true; readonly value: T; readonly reason?: undefined }
  | { readonly ok: false; readonly value?: undefined; readonly reason: Reason };

export function accept<T, Reason extends string>(value: T): RetentionResult<T, Reason> {
  return { ok: true, value };
}

export function refuse<T, Reason extends string>(reason: Reason): RetentionResult<T, Reason> {
  return { ok: false, reason };
}

/** Database time, read from the database (docs/decisions/g4-database-time-is-a-parameter.md). */
export async function databaseNow(db: { query: (text: string) => Promise<{ rows: unknown[] }> }): Promise<string> {
  const { rows } = (await db.query('SELECT now() AS now')) as { rows: readonly { now: Date }[] };
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('the database did not answer with its own time');
  return now.toISOString();
}
