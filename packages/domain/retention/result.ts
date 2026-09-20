/**
 * The outcome shape every command in this lane answers with.
 *
 * Deliberately the same two-field shape `apps/api/src/routes/dialSupport.ts` types
 * its `LaneResult` as, so a route is `runPolicyCommand(deps, schema, kind, work)` and
 * nothing in between has to translate. The refusal codes are a closed union per
 * command rather than one lane-wide set, because "the reasons a deletion can be
 * refused" and "the reasons a departure can be refused" are different questions and
 * a caller should not have to handle the other one's answers.
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
