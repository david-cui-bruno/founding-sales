import { describe, expect, it } from 'vitest';
import { readRepositoryFile } from './support/coverage.ts';

/**
 * `CanaryCompletionAgeSeconds` is the newest canary run's scheduler-to-worker latency,
 * and every reader of it says the same number (g41).
 *
 * The evidence is the first production smoke, 23 September 2026: `FAIL canary
 * (age=359.441672s limit=300s)` against a production that was completing its canaries
 * within seconds. The metric was `extract(epoch FROM now() - max(completed_at))` —
 * seconds since the newest *completion* — while the canary is inserted once per
 * workspace per **quarter hour**, so sampled every minute it sawtoothed 59, 119, …,
 * 419, 59 and sat above the five-minute threshold for about ten minutes in every
 * fifteen. The smoke failed most of the time and `fss-prod-canary-stale` flapped
 * OK→ALARM→OK three times in the first hour (`docs/greenfield/release.md` 8.0r).
 *
 * The query now reads the gap 13.3's sentence actually describes: `completed_at -
 * inserted_at` once the worker has written it, `now() - inserted_at` while it has not,
 * worst over the newest run of each workspace.
 *
 * ## The vacuous-pass trap, named
 *
 * Two of them.
 *
 * Asserting only that the query *mentions* `inserted_at` would pass against a query
 * that still subtracted `max(completed_at)` from `now()` and merely ordered by the
 * insert — which is the sawtooth again, with a column name added. Closed by asserting
 * the reverted shape is **absent** as well as the latency expression present.
 *
 * And asserting the text alone would pass against a threshold that had been raised to
 * 900 to make the flapping stop, which would have left the system with an alarm that
 * cannot fire within a quarter of an hour of the worker dying. Closed by reading the
 * three numbers that have to agree — the smoke's constant, the Terraform default and
 * the alarm's period times its evaluation periods.
 *
 * The *behaviour* is proved against a real PostgreSQL in
 * `packages/domain/test/jobs/observability.test.ts`: a run completed twenty minutes ago
 * with a three-second latency reads 3 rather than 1200, an uncompleted run inserted 400
 * seconds ago reads at least 400, a stale workspace beats a healthy newer one, and no
 * row reads null. This file is the map from that behaviour to the alarm and the smoke
 * that depend on it.
 */

const CANARY = readRepositoryFile('packages/domain/jobs/canary.ts');
const SMOKE = readRepositoryFile('scripts/productionSmoke.mjs');
const ALERTS = readRepositoryFile('infra/modules/alerts/main.tf');
const ALERT_VARIABLES = readRepositoryFile('infra/modules/alerts/variables.tf');

/**
 * The body of `canaryCompletionAgeSeconds`, without its doc comment.
 *
 * The assertions below are about the SQL, and some of them are about text that must
 * *not* appear. Run against the whole file they would read the comment explaining why
 * the rejected shape was rejected, which is the opposite of what they mean.
 */
const READER = ((): string => {
  const start = CANARY.indexOf('export async function canaryCompletionAgeSeconds');
  if (start < 0) return '';
  const end = CANARY.indexOf('\n}', start);
  return end < 0 ? CANARY.slice(start) : CANARY.slice(start, end);
})();

describe('g41: the canary age is the newest run’s latency', () => {
  it('still exports the reader the metric loop and the diagnostics call', () => {
    // Everything below reads the function body rather than the file, so an export that
    // was renamed away would make those assertions vacuous rather than red.
    expect(READER).not.toBe('');
    expect(READER).toContain('db.query<{ age_seconds: string | null }>');
  });

  it('measures insert-to-completion rather than the time since the last completion', () => {
    // `completed_at - inserted_at` when completed, `now() - inserted_at` when not, in
    // one expression. This is the whole of the metric's meaning.
    expect(READER).toContain('coalesce(completed_at, now()) - inserted_at');
    // And the shape it replaced must not come back. `now() - max(completed_at)` is the
    // sawtooth: it says nothing about whether the newest run was ever picked up, only
    // how long it has been since some run was.
    expect(READER).not.toContain('now() - max(completed_at)');
  });

  it('takes the worst of the workspaces’ newest runs, not one row across all of them', () => {
    // The canary is per workspace (`apps/worker/src/scheduler/sources.ts`). One row
    // taken across every workspace would let a workspace whose canary completes
    // normally hide one whose canary never completes, which is the failure the metric
    // exists to notice.
    expect(READER).toContain('DISTINCT ON (workspace_id)');
    expect(READER).toContain('ORDER BY workspace_id, inserted_at DESC');
    expect(READER).toContain('SELECT max(extract(epoch FROM');
    expect(READER).not.toContain('LIMIT 1');
  });

  it('is still null when no canary run exists, which is what the breaching alarm reads', () => {
    // g39's finding: a freshly migrated database has no workspace, so the scheduler
    // inserts no canary and there is no datapoint at all. `treat_missing_data =
    // "breaching"` is what makes that visible rather than quiet, and the function has
    // to keep returning null rather than inventing a zero.
    expect(READER).toContain('return value === null || value === undefined ? null : Number(value);');
    const block = ALERTS.slice(ALERTS.indexOf('canary_stale = {'));
    expect(block.slice(0, block.indexOf('}'))).toContain('treat_missing_data  = "breaching"');
  });

  it('is the same five minutes in the smoke and in the alarm', () => {
    // 13.3: "canary not completed within five minutes", read as five minutes of
    // latency on the newest run. The smoke and the alarm compare the same metric with
    // the same number, and a fix that raised the threshold instead of fixing the query
    // would show up here.
    expect(SMOKE).toContain('export const CANARY_MAXIMUM_AGE_SECONDS = 300;');
    const variable = ALERT_VARIABLES.slice(ALERT_VARIABLES.indexOf('variable "canary_stale_seconds" {'));
    expect(variable.slice(0, variable.indexOf('\n}'))).toContain('default     = 300');
    const block = ALERTS.slice(ALERTS.indexOf('canary_stale = {'));
    const alarm = block.slice(0, block.indexOf('}'));
    expect(alarm).toContain('metric_name         = "CanaryCompletionAgeSeconds"');
    expect(alarm).toContain('threshold           = var.canary_stale_seconds');
    // Two 60-second periods: a worker that stops is over the threshold five minutes
    // later and in ALARM about two minutes after that.
    expect(alarm).toContain('period              = 60');
    expect(alarm).toContain('evaluation_periods  = 2');
  });
});
