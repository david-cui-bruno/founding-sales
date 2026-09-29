import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { JudgmentValue } from './judgments.ts';

/**
 * The call brief: what a person reads in the two seconds before the phone rings.
 *
 * Assembled, not stored. Only the two generated lines live in a column
 * (`research_runs.brief`); everything else here is read from `firm_facts`,
 * `firm_judgments` and `contacts` at the moment the card is built, so a brief can
 * never be staler than the facts behind it.
 *
 * ## The firm's own words, and an AI interpretation, are different things
 *
 * The design record: the brief "distinguishes a firm's own words (a quote with a
 * source) from an AI interpretation (labelled generated)". So the shape does the
 * distinguishing rather than a convention:
 *
 *   * `whyFit` and `whatChanged` are **quotes**. Each carries the source it came from
 *     and the date it was retrieved, and each is the whole text of a block the firm
 *     published — `validateFactSelections` is what makes that true.
 *   * `questions` and `opening` are **written by a model**. They are the only text
 *     here nobody at the firm said, and `generated` is true whenever either is
 *     present, which is what the desktop labels "AI suggestion".
 *
 * A brief with no generated part is still a brief: quotes, judgments and a likely
 * person, with `generated: false`. That is what a run without an extraction provider
 * produces, and it is a smaller answer rather than a failure.
 *
 * ## And a page on somebody else's host is not the firm's own words
 *
 * A link a person adds is fetched and quoted through the same path as the firm's own
 * site, so without saying otherwise the brief would present a trade article's sentence
 * as something the firm said. Every quote therefore carries `firstParty`, and a
 * third-party quote carries an `attribution` — "per news.test" — which the desktop
 * renders beside it. `judgments.ts` is the other half of the same rule: a third-party
 * fact never decides fit or reachability.
 *
 * ## Some facts have no quote, on purpose
 *
 * `named_role`, `phone_listed` and `role` store none (`PERSON_FACT_KEYS`), because the
 * block they name is a block naming a person and a contact's deletion could not reach
 * it here. They still count towards a judgment and they are never rendered as a quote;
 * `pick` skips them rather than printing an empty line.
 */

export interface BriefQuote {
  readonly quote: string;
  readonly sourceReference: string;
  readonly retrievedAt: string;
  /** False for a link a person added on another host. */
  readonly firstParty: boolean;
  /** `per <host>` for a third-party quote, and null for the firm's own words. */
  readonly attribution: string | null;
}

export interface BriefPerson {
  readonly contactId: string;
  readonly name: string;
  readonly title: string | null;
}

export interface CallBrief {
  /** Up to three quotes, newest first. Why this firm is worth a call. */
  readonly whyFit: readonly BriefQuote[];
  /** Up to two quotes. What the firm says has changed. */
  readonly whatChanged: readonly BriefQuote[];
  readonly likelyPerson: BriefPerson | null;
  /** Generated. Two of them, or none. */
  readonly questions: readonly [string, string] | null;
  /** Generated. One line. */
  readonly opening: string | null;
  readonly generated: boolean;
  readonly judgments: {
    readonly fit: JudgmentValue;
    readonly problemEvidence: JudgmentValue;
    readonly timing: JudgmentValue;
    readonly reachability: JudgmentValue;
  };
  readonly judgedAt: string;
  readonly revision: number;
  /** Every distinct source behind the quotes above, so a reader can open them all. */
  readonly sources: readonly { readonly sourceReference: string; readonly retrievedAt: string }[];
  /**
   * How many runs have failed since the last one that completed, and whether the sweep
   * has given up.
   *
   * A provider failure completes its job rather than throwing, so the retry is the
   * sweep's — one a business day, three times (`MAX_CONSECUTIVE_FAILED_RUNS`). Without
   * this the firm page would show a stale brief and no hint that the last three
   * attempts to refresh it failed, which is the worst of the two silences.
   */
  readonly failedTries: number;
}

export const MAX_WHY_FIT_QUOTES = 3;
export const MAX_WHAT_CHANGED_QUOTES = 2;

/**
 * Which facts answer "why this firm", in the order they are offered.
 *
 * `target_fit` first because it is the firm saying it is the kind of firm we sell to,
 * and nothing else on the page beats that.
 */
const WHY_FIT_KEYS = [
  'target_fit',
  'maintenance_workflow',
  'portfolio_description',
  'portfolio_size',
  'residential_scope',
  'software_evidence',
  'operating_footprint',
  'ownership',
] as const;

const WHAT_CHANGED_KEYS = ['recent_change', 'hiring_maintenance'] as const;

interface FactRow {
  readonly id: string;
  readonly key: string;
  readonly quote: string | null;
  readonly first_party: boolean;
  readonly source_reference: string;
  readonly retrieved_at: Date;
  readonly confidence: string | null;
  readonly [column: string]: unknown;
}

interface JudgmentRow {
  readonly run_id: string;
  readonly fit: JudgmentValue;
  readonly problem_evidence: JudgmentValue;
  readonly timing: JudgmentValue;
  readonly reachability: JudgmentValue;
  readonly reasons: Readonly<Record<string, string>>;
  readonly call_first: boolean;
  readonly likely_contact_id: string | null;
  readonly judged_at: Date;
  readonly [column: string]: unknown;
}

export interface FirmFactDto {
  readonly id: string;
  readonly key: string;
  /** Null for a `PERSON_FACT_KEYS` key: the block is referenced, never copied. */
  readonly quote: string | null;
  /** False for a page on a host that is not the firm's own. */
  readonly firstParty: boolean;
  readonly sourceReference: string;
  readonly retrievedAt: string;
  readonly confidence: number | null;
}

export interface FirmJudgmentsDto {
  readonly fit: JudgmentValue;
  readonly problemEvidence: JudgmentValue;
  readonly timing: JudgmentValue;
  readonly reachability: JudgmentValue;
  readonly reasons: Readonly<Record<string, string>>;
  readonly callFirst: boolean;
  readonly likelyContactId: string | null;
  readonly judgedAt: string;
  readonly runId: string;
}

/**
 * Every fact on a firm, newest retrieval first.
 *
 * The source is joined from `evidence_items` rather than copied onto the fact: the
 * evidence row *is* the provenance, and a second copy of the URL would be a second
 * thing to keep true when a merge moves the row.
 */
export async function listFirmFacts(
  context: RepositoryContext,
  firmId: string,
): Promise<readonly FirmFactDto[]> {
  const { rows } = await context.db.query<FactRow>(
    `SELECT f.id, f.key, f.quote, f.first_party, e.source_reference, f.retrieved_at, f.confidence
       FROM firm_facts f
       JOIN evidence_items e ON e.workspace_id = f.workspace_id AND e.id = f.evidence_id
      WHERE f.workspace_id = $1 AND f.firm_id = $2
      ORDER BY f.retrieved_at DESC, f.key, f.id`,
    [context.scope.workspaceId, firmId],
  );
  return rows.map(row => ({
    id: row.id,
    key: row.key,
    quote: row.quote,
    firstParty: row.first_party,
    sourceReference: row.source_reference,
    retrievedAt: row.retrieved_at.toISOString(),
    confidence: row.confidence === null ? null : Number(row.confidence),
  }));
}

/** The firm's current judgment, or null when no run has completed. */
export async function readFirmJudgments(
  context: RepositoryContext,
  firmId: string,
): Promise<FirmJudgmentsDto | null> {
  const { rows } = await context.db.query<JudgmentRow>(
    `SELECT run_id, fit, problem_evidence, timing, reachability, reasons, call_first,
            likely_contact_id, judged_at
       FROM firm_judgments
      WHERE workspace_id = $1 AND firm_id = $2`,
    [context.scope.workspaceId, firmId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    fit: row.fit,
    problemEvidence: row.problem_evidence,
    timing: row.timing,
    reachability: row.reachability,
    reasons: row.reasons,
    callFirst: row.call_first,
    likelyContactId: row.likely_contact_id,
    judgedAt: row.judged_at.toISOString(),
    runId: row.run_id,
  };
}

/** `per <host>` for a page that is not the firm's own, and null for one that is. */
export function attributionOf(fact: { readonly firstParty: boolean; readonly sourceReference: string }): string | null {
  if (fact.firstParty) return null;
  try {
    return `per ${new URL(fact.sourceReference).hostname.replace(/^www\./u, '')}`;
  } catch {
    // A reference that will not parse is still not the firm's own words.
    return 'per another source';
  }
}

function pick(
  facts: readonly FirmFactDto[],
  keys: readonly string[],
  limit: number,
): readonly BriefQuote[] {
  const chosen: BriefQuote[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const fact of facts) {
      // A person key holds no quote. It counted towards a judgment and it is not
      // rendered, which is the whole arrangement `PERSON_FACT_KEYS` describes.
      if (fact.key !== key || fact.quote === null || seen.has(fact.quote)) continue;
      seen.add(fact.quote);
      chosen.push({
        quote: fact.quote,
        sourceReference: fact.sourceReference,
        retrievedAt: fact.retrievedAt,
        firstParty: fact.firstParty,
        attribution: attributionOf(fact),
      });
      if (chosen.length >= limit) return chosen;
    }
  }
  return chosen;
}

/** The two generated lines, read out of `research_runs.brief`. Shape-checked, never trusted. */
export function generatedPartsOf(brief: Readonly<Record<string, unknown>> | null): {
  readonly questions: readonly [string, string] | null;
  readonly opening: string | null;
} {
  const questions = brief?.['questions'];
  const opening = brief?.['opening'];
  const pair =
    Array.isArray(questions) &&
    questions.length === 2 &&
    typeof questions[0] === 'string' &&
    typeof questions[1] === 'string'
      ? ([questions[0], questions[1]] as const)
      : null;
  return {
    questions: pair,
    opening: typeof opening === 'string' && opening.trim() !== '' ? opening : null,
  };
}

export interface BuildBriefInput {
  readonly facts: readonly FirmFactDto[];
  readonly judgments: FirmJudgmentsDto;
  readonly revision: number;
  /** `research_runs.brief` of the run the judgment came from. */
  readonly runBrief: Readonly<Record<string, unknown>> | null;
  readonly likelyPerson: BriefPerson | null;
  /** Failed runs since the last completed one. Zero when the last run completed. */
  readonly failedTries?: number | undefined;
}

/** Pure. Everything it needs is an argument; the reads above are the caller's. */
export function buildCallBrief(input: BuildBriefInput): CallBrief {
  const whyFit = pick(input.facts, WHY_FIT_KEYS, MAX_WHY_FIT_QUOTES);
  const whatChanged = pick(input.facts, WHAT_CHANGED_KEYS, MAX_WHAT_CHANGED_QUOTES);
  const { questions, opening } = generatedPartsOf(input.runBrief);

  const sources = new Map<string, string>();
  for (const quote of [...whyFit, ...whatChanged]) {
    if (!sources.has(quote.sourceReference)) sources.set(quote.sourceReference, quote.retrievedAt);
  }

  return {
    whyFit,
    whatChanged,
    likelyPerson: input.likelyPerson,
    questions,
    opening,
    // True whenever either generated part is present, which is the claim the desktop
    // turns into the words "AI suggestion".
    generated: questions !== null || opening !== null,
    judgments: {
      fit: input.judgments.fit,
      problemEvidence: input.judgments.problemEvidence,
      timing: input.judgments.timing,
      reachability: input.judgments.reachability,
    },
    judgedAt: input.judgments.judgedAt,
    revision: input.revision,
    sources: [...sources].map(([sourceReference, retrievedAt]) => ({ sourceReference, retrievedAt })),
    failedTries: Math.max(0, Math.trunc(input.failedTries ?? 0)),
  };
}

/**
 * How many runs have failed since the last one that completed.
 *
 * The same count the sweep uses to decide whether to try again, read here so the firm
 * page can say "research failed, N tries" instead of showing a brief that is quietly
 * three days out of date.
 */
export async function countFailedTries(context: RepositoryContext, firmId: string): Promise<number> {
  const { rows } = await context.db.query<{ tries: string }>(
    `SELECT count(*)::text AS tries
       FROM research_runs r
      WHERE r.workspace_id = $1 AND r.firm_id = $2 AND r.outcome = 'failed'
        AND r.revision > COALESCE((
          SELECT max(c.revision) FROM research_runs c
           WHERE c.workspace_id = $1 AND c.firm_id = $2 AND c.outcome = 'completed'
        ), 0)`,
    [context.scope.workspaceId, firmId],
  );
  return Number(rows[0]?.tries ?? '0');
}

/**
 * The firm's brief, or null when no run has completed.
 *
 * Null is the honest answer for a firm nobody has researched, and the desktop shows
 * one grey line for it rather than an empty section that looks like a failure.
 */
export async function readCallBrief(
  context: RepositoryContext,
  firmId: string,
): Promise<CallBrief | null> {
  const judgments = await readFirmJudgments(context, firmId);
  if (judgments === null) return null;

  const { rows } = await context.db.query<{ revision: number; brief: Readonly<Record<string, unknown>> | null }>(
    'SELECT revision, brief FROM research_runs WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, judgments.runId],
  );
  const run = rows[0];
  const facts = await listFirmFacts(context, firmId);

  let likelyPerson: BriefPerson | null = null;
  if (judgments.likelyContactId !== null) {
    const contact = await context.db.query<{ id: string; full_name: string; title: string | null }>(
      'SELECT id, full_name, title FROM contacts WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, judgments.likelyContactId],
    );
    const row = contact.rows[0];
    if (row !== undefined) likelyPerson = { contactId: row.id, name: row.full_name, title: row.title };
  }

  return buildCallBrief({
    facts,
    judgments,
    revision: Number(run?.revision ?? 0),
    runBrief: run?.brief ?? null,
    likelyPerson,
    failedTries: await countFailedTries(context, firmId),
  });
}
