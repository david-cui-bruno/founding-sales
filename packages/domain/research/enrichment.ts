import { recordEvidence } from '../crm/evidence.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordFunnelFact } from '../funnel/facts.ts';
import { firmIsResearchable, firmIsSuppressed } from './firmState.ts';
import { validateFactSelections, type AdmittedFact, type FactSource } from './facts.ts';
import type { ProviderOutcome } from './providers.ts';
import { judgeFirm, type JudgmentContact } from './judgments.ts';
import { parsePageText } from './pageText.ts';
import { claimResearchClearance, RESEARCH_FIRM_MAX_RESERVATIONS } from './ceilings.ts';
import { recordProviderCall, workspaceBusinessZone } from './ledger.ts';
import {
  listAttempts,
  markCalling,
  readAttempt,
  reserveAttempt,
  settleAttempt,
  subjectSettledCents,
  type ReservationRow,
} from './reservations.ts';
import { MAX_BUDGET_DROPS, withoutTrailingBlocks } from './extractionPrompt.ts';
import { admitCall, type ReservationSnapshot } from './pricing.ts';
import { researchUrlsForFirm } from './sourcePolicy.ts';
import { readResearchSettings } from './settings.ts';
import {
  completeRun,
  failRun,
  lockRun,
  openRun,
  readRunForRevision,
  recordRefusedRun,
  refuseRun,
  type RunExtraction,
} from './runs.ts';
import type { ExtractionProvider, PageFetchProvider } from './providers.ts';
import {
  COMPANY_PAGE_PROVIDER,
  EXTRACTION_PROVIDER,
  accept,
  refuse,
  type ResearchResult,
  type ResearchTrigger,
} from './types.ts';

/**
 * One run of one firm, at one revision.
 *
 * The order of the steps is the order of what each one costs to get wrong:
 *
 *   1. **Is this firm researchable at all** — active, not merged, not suppressed.
 *      Asked before any clearance, because a refusal here should not spend a unit of
 *      the day's budget.
 *   2. **Open the run.** The insert is the idempotency: a second claim of the same
 *      job finds `research_runs_one_per_revision` refuses it, and reports
 *      `already_recorded` without reading a single page.
 *   3. **Claim the clearance.** Consumed, and checked against the reviewed worst case
 *      rather than the invoice, which does not exist yet.
 *   4. **Fetch, record, extract, judge** — and each of those writes something even
 *      when the next one fails, because a page the firm published is worth keeping
 *      whatever the model later says about it.
 *
 * ## What this never does
 *
 * It creates no contact, no route and no opportunity, and it initiates no outreach.
 * `firm_facts`, `firm_judgments`, `evidence_items`, `research_runs` and
 * `provider_ledger` are the only tables it writes, and none of them can hold a
 * message, a ticket or an enrollment. Invariant 8 is a property of the write set.
 *
 * ## Without an extraction port
 *
 * The run records the evidence, sets fit, problem evidence and timing to `unknown`,
 * derives reachability from the firm's routes and its suppression, and completes.
 * That is the state of a worker with no API key: a smaller answer, not a failure, and
 * the same shape `classify.reply` chose for the same reason.
 *
 * Chunk 2 asks *first* and marks nothing: the reservation goes straight back to the
 * budget. Marking `calling` on a deployment that cannot call is a claim about a call
 * that cannot happen, and a worker that then disappeared left the sweep to estimate the
 * full price of it.
 *
 * ## A firm with nothing to read
 *
 * No website and no added link is `no_sources`. It is a refusal rather than a
 * completion, because "we looked and there was nothing" and "there was nowhere to
 * look" are different things to see in a runs list.
 *
 * ## Three committed steps, because the middle of a run spends money
 *
 * `research.firm` is a **chunked** handler (`docs/greenfield/jobs.md`), and this file is
 * the three parts:
 *
 *   1. `beginFirmResearch` — the firm is researchable, the run row is opened, the day's
 *      count is consumed, and the clearance's worst case is **reserved** as a
 *      `provider_reservations` row in state `reserved`, carrying the model, the token
 *      bounds and the cents it was priced at. No provider has been touched. The runner
 *      commits this together with the cursor.
 *   2. `ensureResearchCalling` — that reservation moves to `calling` and **nothing else
 *      is written**. This step exists only to make "a call may now have happened"
 *      durable before it can have, because a marker sharing a transaction with work can
 *      be rolled back by that work's failure, and then the call that followed it has no
 *      record at all. A deployment with no extraction port marks nothing and releases
 *      the cents here.
 *   3. `finishFirmResearch` — fetch, count, call, record, judge, and settle the
 *      reservation by its id. The runner commits this as the job's completion.
 *
 * The split is the whole point. Before it, the paid call happened inside the single
 * transaction that also held the run row, the ledger row and the consumed counter — so
 * a lease reclaimed during the extraction, or any database error after the call, rolled
 * back every trace of a call that had already been billed, and the retry spent the money
 * again against a budget that had never heard of the first attempt. Now a rollback of
 * chunk 3 leaves chunks 1 and 2 standing: the run exists, the count is spent, and the
 * reservation still says `calling` — which is the durable "nobody knows" the next claim
 * settles as an estimate before opening its own. The month is over-counted by a few
 * cents until the run is finalised, and over-counting is the direction in which nothing
 * can be lost.
 *
 * If chunk 3's own SQL fails, the reservation stands and the row stays `running`;
 * `finaliseAbandonedRuns` closes it half an hour later as `lease_lost` — once the run's
 * job has no live lease — and keeps a `calling` reservation as the recorded cost,
 * because nobody can know whether the call was made.
 *
 * `runFirmResearch` runs all three in sequence. It is what a direct caller and most
 * tests want — one call, one answer — and it is *not* what the handler uses, because
 * three steps in one transaction is exactly the arrangement the split exists to end.
 *
 * ## Once the clearance is consumed, nothing in this function throws
 *
 * This is the rule the whole file is arranged around, and it is about money.
 *
 * The runner wraps one job in one transaction. `claimResearchClearance` consumes a
 * unit of the day's count and the run's paid calls happen inside that transaction, so a
 * throw anywhere after it rolls back the run row, the evidence, the ledger cents **and
 * the consumed count** — while the money stays spent at the provider. The retry ladder
 * then makes the same paid calls again against a budget that has no record of the first
 * attempt. Three attempts, three invoices, one visible cent.
 *
 * So every outcome is committed. A provider that returns a failure and a provider that
 * throws both become a `failed` run with the cents actually spent on it and a ledger
 * row that counts the failure, and the caller reports a refusal that **completes** the
 * job. Retrying is the sweep's business, as a new revision with a new clearance —
 * which is a retry the budget can see.
 *
 * A database error is the one thing that still aborts, and it is the one case where
 * aborting is right: the accounting is written in the same transaction as the work, so
 * a transaction that cannot commit has no accounting to lose.
 */

export interface RunFirmResearchInput {
  readonly firmId: string;
  readonly revision: number;
  readonly trigger: ResearchTrigger;
  readonly requestedByUserId?: string | undefined;
  /** Database time. One run dates every write it makes identically. */
  readonly at: string;
  readonly pageFetch: PageFetchProvider;
  /** Absent when the deployment has no model key. The run is smaller, not failed. */
  readonly extraction?: ExtractionProvider | undefined;
}

export interface ResearchRunReport {
  readonly runId: string;
  readonly firmId: string;
  readonly revision: number;
  readonly outcome: 'completed' | 'already_recorded';
  readonly pagesFetched: number;
  readonly evidenceRecorded: number;
  readonly factsRecorded: number;
  readonly factsRefused: number;
  readonly costCents: number;
  readonly callFirst: boolean;
  /** True when `call_first` was not true for this firm before this run. */
  readonly callFirstBecameTrue: boolean;
  readonly skipped: Readonly<Record<string, number>>;
}

const replayed = (firmId: string, revision: number): ResearchRunReport => ({
  runId: '',
  firmId,
  revision,
  outcome: 'already_recorded',
  pagesFetched: 0,
  evidenceRecorded: 0,
  factsRecorded: 0,
  factsRefused: 0,
  costCents: 0,
  callFirst: false,
  callFirstBecameTrue: false,
  skipped: {},
});

/** The step a run has reached. The handler's cursor carries it; the rows decide it. */
export type ResearchStep =
  /** The run row and its clearance exist; no reservation has been marked calling. */
  | 'reserved'
  /** This reservation is marked `calling`: a call may be made, exactly once, in this claim. */
  | 'calling'
  /**
   * There is no extraction port, so no call was marked and the cents have gone back.
   * Chunk 3 records the pages and judges from the firm's routes.
   */
  | 'uncalled';

export interface ResearchCursor {
  readonly runId: string;
  /** Which `provider_reservations` row of this run the cursor is about. 1, 2 or 3. */
  readonly attempt: number;
  readonly step: ResearchStep;
  /**
   * The **fencing token of the claim that wrote this cursor**, and the reason a retry
   * cannot call against somebody else's authorization.
   *
   * Not the job attempt: `requeueDeadJob` sets `attempt_count` back to zero, so two
   * different claims can both be attempt 1, and the second would have read the first's
   * `calling` reservation as its own and called a second time against it. The fencing
   * token is incremented by every claim and never reset.
   */
  readonly fencing: string;
}

export type ResearchStart =
  /** Chunk 2 has work to do. */
  | { readonly kind: 'reserved'; readonly runId: string }
  /** The revision was already recorded by an earlier claim. Nothing more to do. */
  | { readonly kind: 'done'; readonly report: ResearchRunReport };

export interface BeginResearchInput {
  readonly firmId: string;
  readonly revision: number;
  readonly trigger: ResearchTrigger;
  readonly requestedByUserId?: string | undefined;
  /** Database time. One run dates every write it makes identically. */
  readonly at: string;
}

/**
 * Chunk 1: everything that must be committed **before** a provider is touched.
 *
 * Nothing here opens a socket. What it does is make the run's existence and its
 * consumed unit of the day's count durable, so that whatever happens to the worker
 * next, the budget already knows this run was authorized. The reservation row is
 * written here too, in state `reserved` — authorized, nothing called.
 */
export async function beginFirmResearch(
  context: RepositoryContext,
  input: BeginResearchInput,
): Promise<ResearchResult<ResearchStart>> {
  if (!Number.isInteger(input.revision) || input.revision < 1) return refuse('invalid_input');
  const opening = {
    firmId: input.firmId,
    revision: input.revision,
    trigger: input.trigger,
    requestedByUserId: input.requestedByUserId ?? null,
    at: input.at,
  };

  const firm = await firmIsResearchable(context, input.firmId);
  if (!firm.ok) {
    await recordRefusedRun(context, { ...opening, refusalCode: firm.reason });
    return firm;
  }

  const runId = await openRun(context, opening);
  if (runId === null) return accept({ kind: 'done', report: replayed(input.firmId, input.revision) });

  const clearance = await claimResearchClearance(context, {
    firmId: input.firmId,
    at: input.at,
    attemptKind: 'first',
  });
  if (!clearance.ok) {
    await refuseRun(context, { runId, at: input.at, refusalCode: clearance.reason });
    return refuse(clearance.reason);
  }

  // The number both money checks were just made against, held as a row of its own. From
  // here on `readSpend` counts this run on this date, so a second run started in the
  // same minute is cleared against a budget that already includes it.
  await reserveAttempt(context, {
    providerKey: EXTRACTION_PROVIDER,
    subjectKind: 'research_run',
    subjectId: runId,
    attempt: 1,
    at: input.at,
    businessTimeZone: clearance.value.businessTimeZone,
    cents: clearance.value.worstCaseCents,
    modelName: clearance.value.modelName,
    maxInputTokens: clearance.value.maxInputTokens,
    maxOutputTokens: clearance.value.maxOutputTokens,
  });

  return accept({ kind: 'reserved', runId });
}

// The bound on a firm's paid attempts in a day lives with the ceilings, because it is
// enforced by the one clearance every reservation passes through. Re-exported here
// because the handler composes the run from this file.
export { RESEARCH_FIRM_MAX_RESERVATIONS };

export type CallPermission =
  /** This claim may make exactly one call, against `reservationId`. */
  | { readonly kind: 'calling'; readonly attempt: number; readonly reservationId: string; readonly cents: number }
  /**
   * This deployment has no extraction port, so there is no call to mark and the cents
   * are handed back here. Chunk 3 still runs: it records the pages as evidence and
   * judges from the firm's routes.
   */
  | { readonly kind: 'unconfigured'; readonly attempt: number }
  /** The run has been closed here, or was closed already. Nothing further to do. */
  | { readonly kind: 'closed' };

/**
 * Chunk 2: make "a call may now have happened" durable, and nothing else.
 *
 * This is the whole of the middle chunk, and it writes one column on one row on
 * purpose. A marker that shared a transaction with work could be rolled back by that
 * work's failure — and then the call which followed it would have no record at all,
 * which is the exact hole the three-chunk shape closes.
 *
 * ## The ambiguity, and how it is resolved
 *
 * A reservation found still `calling` means one of two things: this claim marked it and
 * is about to call, or a previous claim called and died before it could record
 * anything. The handler keeps those apart with the **fencing token** in its cursor: a
 * cursor written by this claim goes straight to chunk 3, so anything that reaches *this*
 * function and is `calling` was marked by somebody else. It is ambiguous, it is settled
 * `estimated` — the call may well have been billed — and a fresh reservation is opened
 * for this claim.
 *
 * A `reserved` row is never ambiguous: `reserved` is precisely the state in which no
 * call can have been made, so whoever finds it may mark it and use it.
 *
 * `maxReservations` bounds the whole run: three rows, and the fourth claim closes the
 * run instead of reserving — including after an admin requeue, which resets the job's
 * attempt counter but cannot remove a reservation.
 */
export async function ensureResearchCalling(
  context: RepositoryContext,
  input: {
    readonly runId: string;
    readonly at: string;
    /** Reservations this run may ever hold. `RESEARCH_FIRM_MAX_RESERVATIONS`. */
    readonly maxReservations: number;
    /**
     * Whether this deployment has an extraction port at all.
     *
     * False means no call can happen, so marking a reservation `calling` would be a
     * claim about a call that cannot be made — and if the worker then disappeared,
     * finalisation would estimate the full cost of it. The cents are released here
     * instead. See `CallPermission`.
     */
    readonly hasExtraction: boolean;
  },
): Promise<CallPermission> {
  const subject = { subjectKind: 'research_run' as const, subjectId: input.runId };

  // The run row, locked for the rest of this transaction. Chunk 2, chunk 3 and the
  // abandoned-run sweep all begin here, so exactly one of them is deciding about this
  // run's money at a time: without the lock the sweep could read a reservation as
  // `reserved`, this chunk could mark it `calling`, and the sweep's later write could
  // release the cents under the call chunk 3 was about to make.
  //
  // The state is then re-read under the lock. A terminal run is never called against
  // again, and never closed again — a stale cursor (an admin requeue of a job whose run
  // the sweep already finalised, a duplicate claim of a replayed revision) would
  // otherwise reserve a fresh attempt against a finished run and call the model for it.
  const run = await lockRun(context, input.runId);
  if (run === null || run.outcome !== 'running') return { kind: 'closed' };

  const rows = await listAttempts(context, subject);
  const reserved = rows.find(row => row.state === 'reserved');

  if (!input.hasExtraction) {
    // No port, so nothing is marked. A `reserved` row goes back to the budget, because
    // no call happened and none can; a `calling` row from an earlier claim is still
    // ambiguous — that claim may have run on a deployment that had a key — and is
    // charged as an estimate exactly as it would be below.
    for (const row of rows) {
      if (row.state === 'reserved') {
        await settleAttempt(context, { reservationId: row.id, at: input.at, outcome: { kind: 'released' } });
      } else if (row.state === 'calling') {
        await settleAttempt(context, { reservationId: row.id, at: input.at, outcome: { kind: 'estimated' } });
      }
    }
    return { kind: 'unconfigured', attempt: reserved?.attempt ?? rows[0]?.attempt ?? 1 };
  }

  if (reserved !== undefined) {
    await markCalling(context, reserved.id);
    return { kind: 'calling', attempt: reserved.attempt, reservationId: reserved.id, cents: reserved.cents };
  }

  // Everything still open is somebody else's marked call: ambiguous, and charged.
  for (const row of rows) {
    if (row.state !== 'calling') continue;
    await settleAttempt(context, { reservationId: row.id, at: input.at, outcome: { kind: 'estimated' } });
  }

  const limit = Math.max(1, Math.trunc(input.maxReservations));
  if (rows.length >= limit) {
    // Three reservations is the most one firm can cost in a day, and this is where that
    // is true rather than hoped: the run is closed here instead of reserving a fourth.
    await failRun(context, {
      runId: input.runId,
      at: input.at,
      refusalCode: 'provider_failure',
      costCents: await subjectSettledCents(context, subject),
      costEstimated: true,
      extraction: 'failed',
    });
    return { kind: 'closed' };
  }

  // A retry is a new authorization and goes through the same clearance attempt 1 did:
  // the firm's three rows a day, today's cents, the month's cents. It used to be an
  // unchecked insert, which is how sixteen runs at 48 of 50 cents bought a
  // fifty-first — and how two revisions of one firm in one day bought six calls.
  const attempt = rows.reduce((highest, row) => Math.max(highest, row.attempt), 0) + 1;
  const clearance = await claimResearchClearance(context, {
    firmId: run.firmId,
    at: input.at,
    attemptKind: 'retry',
  });
  if (!clearance.ok) {
    // Refused, not failed: no ceiling was broken and nothing went wrong. The run closes
    // with the ceiling that bound it, the settled attempts stay settled, and nothing new
    // is opened.
    await refuseRun(context, {
      runId: input.runId,
      at: input.at,
      refusalCode: clearance.reason,
      costCents: await subjectSettledCents(context, subject),
      costEstimated: true,
    });
    return { kind: 'closed' };
  }
  const fresh = await reserveAttempt(context, {
    providerKey: EXTRACTION_PROVIDER,
    subjectKind: 'research_run',
    subjectId: input.runId,
    attempt,
    at: input.at,
    businessTimeZone: clearance.value.businessTimeZone,
    cents: clearance.value.worstCaseCents,
    modelName: clearance.value.modelName,
    maxInputTokens: clearance.value.maxInputTokens,
    maxOutputTokens: clearance.value.maxOutputTokens,
  });
  await markCalling(context, fresh.id);
  return { kind: 'calling', attempt, reservationId: fresh.id, cents: fresh.cents };
}

export interface FinishResearchInput {
  readonly runId: string;
  readonly firmId: string;
  readonly revision: number;
  readonly at: string;
  /** The job attempt whose reservation this chunk spends and settles. */
  readonly attempt: number;
  /** From chunk 2. False means record the run but make no call. */
  readonly mayCall: boolean;
  readonly pageFetch: PageFetchProvider;
  /** Absent when the deployment has no model key. The run is smaller, not failed. */
  readonly extraction?: ExtractionProvider | undefined;
}

/**
 * Chunk 3: the calls, the evidence, the judgment, and the reservation settled by id.
 *
 * Every exit closes the run row and settles this attempt's reservation — released when
 * no call was made, `settled` when a figure came back, `estimated` when none did. The
 * one exit that does neither is a database error, which rolls this chunk back and leaves
 * the reservation `calling` for the next claim to resolve.
 */
export async function finishFirmResearch(
  context: RepositoryContext,
  input: FinishResearchInput,
): Promise<ResearchResult<ResearchRunReport>> {
  const { runId } = input;
  const subject = { subjectKind: 'research_run' as const, subjectId: runId };

  // First, before anything: the run row's lock, and then its state. A run that is not
  // `running` is finished, and a stale cursor pointing at one must not fetch a page,
  // call a model or reopen a decision. The lock is held for the whole of this chunk —
  // the provider call included — so the sweep cannot close this run or release its
  // reservation while the call is in flight. See `lockRun`.
  const run = await lockRun(context, runId);
  if (run === null) return refuse('invalid_input');
  if (run.outcome !== 'running') return accept(replayed(input.firmId, input.revision));

  const settings = await readResearchSettings(context);
  const businessTimeZone = await workspaceBusinessZone(context);
  // This attempt's reservation, read rather than carried: the cursor names the attempt
  // and the row is the authority on its state. A call is permitted only against a row
  // that is actually `calling`, so a cursor that says otherwise cannot buy one.
  const reservation: ReservationRow | null = await readAttempt(context, { ...subject, attempt: input.attempt });
  const mayCall = input.mayCall && reservation !== null && reservation.state === 'calling';

  /**
   * Hand this attempt's cents back, for a run that asked the provider nothing.
   *
   * `released_not_called` rather than `released`, because this is the one caller that
   * may release a row already marked `calling`: chunk 2 of this same claim marked it,
   * this chunk holds the run's lock, and it knows first-hand that it did not call. No
   * reader from outside — the sweep above all — may make that claim.
   */
  const release = async (): Promise<void> => {
    if (reservation === null) return;
    await settleAttempt(context, {
      reservationId: reservation.id,
      at: input.at,
      outcome: { kind: 'released_not_called' },
    });
  };
  /**
   * What this chunk reports when its close affected no row: the run is already
   * terminal, closed by the sweep or by another claim.
   *
   * Every close below carries `WHERE outcome = 'running'` (`completeRun`, `refuseRun`,
   * `failRun` all return false when it matched nothing), because an unconditional update
   * would overwrite the sweep's `lease_lost` outcome and its estimated cents with a
   * cheaper story. This attempt's reservation has already been settled or released by
   * the time any of them is reached, so there is nothing left to do but say so and let
   * the job complete.
   */
  const closedElsewhere = (): ResearchResult<ResearchRunReport> => accept(replayed(input.firmId, input.revision));
  /** Everything this run has been recorded as costing, across every attempt. */
  const totalCost = async (): Promise<{ readonly cents: number; readonly estimated: boolean }> => {
    const rows = await listAttempts(context, subject);
    return {
      cents: rows.reduce((total, row) => total + row.settledCents, 0),
      estimated: rows.some(row => row.state === 'estimated'),
    };
  };

  // Asked again, because a suppression or a merge may have landed between the chunks,
  // and a firm that has asked to be left alone is left alone from the moment it asks.
  const firm = await firmIsResearchable(context, input.firmId);
  if (!firm.ok) {
    await release();
    const cost = await totalCost();
    const closed = await refuseRun(context, {
      runId,
      at: input.at,
      refusalCode: firm.reason,
      costCents: cost.cents,
      costEstimated: cost.estimated,
    });
    if (!closed) return closedElsewhere();
    return firm;
  }

  const links = await readFirmLinks(context, input.firmId);
  const urls = researchUrlsForFirm({
    firmWebsite: firm.value.website,
    links,
    maxPagesPerFirm: settings.maxPagesPerFirm,
  });
  if (urls.length === 0) {
    await release();
    const cost = await totalCost();
    const closed = await refuseRun(context, {
      runId,
      at: input.at,
      refusalCode: 'no_sources',
      costCents: cost.cents,
      costEstimated: cost.estimated,
    });
    if (!closed) return closedElsewhere();
    return refuse('no_sources');
  }

  // A provider that throws is a provider that failed, and a failure after a consumed
  // clearance is a committed `failed` run rather than a rollback. `providerAttempt`
  // is the only place either of them is turned into a value.
  const fetched = await providerAttempt(async () =>
    await input.pageFetch.fetchPages({
      urls,
      firmWebsite: firm.value.website,
      links,
      maxPagesPerFirm: settings.maxPagesPerFirm,
      maxBytes: settings.maxPageBytes,
    }),
  );
  // The fetch is free, so its ledger row is a count and a failure code rather than
  // money. It is recorded anyway: "what refused research today" is the question the
  // ledger exists to answer, and a fetch that fails every morning is the answer.
  await recordProviderCall(context, {
    providerKey: input.pageFetch.providerKey,
    at: input.at,
    businessTimeZone,
    costCents: fetched.costCents,
    ...(fetched.ok ? {} : { failureCode: fetched.failureCode }),
  });
  if (!fetched.ok) {
    // No model call was made, so this attempt's cents go back.
    await release();
    const cost = await totalCost();
    const closed = await failRun(context, {
      runId,
      at: input.at,
      refusalCode: 'provider_failure',
      costCents: cost.cents,
      costEstimated: cost.estimated,
    });
    if (!closed) return closedElsewhere();
    return refuse('provider_failure');
  }

  const skipped: Record<string, number> = { ...fetched.value.skipped };
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  let evidenceRecorded = 0;
  const sources: FactSource[] = [];
  const evidenceByReference = new Map<string, { readonly id: string; readonly retrievedAt: string }>();

  for (const page of fetched.value.pages) {
    const parsed = parsePageText(page.body, page.contentType);
    if (parsed.blocks.length === 0) {
      bump(parsed.truncated ? 'page_over_bound' : 'page_unreadable');
      continue;
    }
    // Idempotent on the content hash, so a page unchanged since the last run is the
    // same row: `recordEvidence` returns the existing one rather than failing, and a
    // fact recorded against it this revision points at the evidence that carries it.
    const evidence = await recordEvidence(context, {
      firmId: input.firmId,
      provider: COMPANY_PAGE_PROVIDER,
      sourceReference: page.url,
      contentHash: page.contentHash,
      retrievedAt: new Date(page.retrievedAt),
      detail: { kind: 'company_page', blocks: parsed.blocks.length, truncated: parsed.truncated },
    });
    if (!evidence.ok) {
      bump(`evidence_${evidence.reason}`);
      continue;
    }
    evidenceRecorded += 1;
    sources.push({ sourceReference: page.url, blocks: parsed.blocks, firstParty: page.firstParty });
    evidenceByReference.set(page.url, { id: evidence.value.id, retrievedAt: page.retrievedAt });
  }

  let facts: readonly AdmittedFact[] = [];
  let factsRefused = 0;
  let modelName: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let generated: { readonly questions: readonly [string, string]; readonly opening: string } | null = null;
  // Why the model was or was not used, recorded so the sweep can tell the difference
  // between "there was no key" and "there was nothing to read".
  let extractionOutcome: RunExtraction =
    sources.length === 0 ? 'no_pages' : input.extraction === undefined || !mayCall ? 'unconfigured' : 'used';

  if (input.extraction !== undefined && mayCall && reservation !== null && sources.length > 0) {
    const extraction = input.extraction;
    // The exact count, from the provider, of the request this would send, admitted
    // against **the reservation** and nothing else.
    //
    // Two numbers used to decide this and neither was the money: a characters-per-token
    // bound recomputed from the settings *now*, and the settings' current token limit.
    // Raising `max_pages_per_firm` between chunk 1 and chunk 3 therefore admitted a
    // request larger than the cents being held for it. The snapshot on the row is what
    // was priced — model, input bound, output bound, cents — so it is what admits the
    // call. The count itself is the provider's own, because a ratio is the right way to
    // decide what to *hold* and the wrong way to decide what to *send*: dense scripts
    // tokenize several times worse than 2.5 characters a token.
    const snapshot: ReservationSnapshot = {
      modelName: reservation.modelName,
      maxInputTokens: reservation.maxInputTokens,
      maxOutputTokens: reservation.maxOutputTokens,
      cents: reservation.cents,
    };
    let offered: readonly FactSource[] = sources;
    let counted: number | null = null;
    let countFailed = false;
    for (let drop = 0; drop <= MAX_BUDGET_DROPS; drop += 1) {
      let count: number;
      try {
        count = await extraction.countInputTokens({
          sources: offered.map(source => ({ sourceReference: source.sourceReference, blocks: source.blocks })),
          firmName: firm.value.name,
          modelName: snapshot.modelName,
          maxOutputTokens: snapshot.maxOutputTokens,
        });
      } catch {
        countFailed = true;
        break;
      }
      const admission = admitCall(snapshot, count);
      if (admission.kind === 'call') {
        counted = admission.inputTokens;
        break;
      }
      // A snapshot naming a model nobody priced cannot be made to fit by sending less
      // of it: there is no price to compare with at all, so the loop stops.
      if (admission.reason === 'unpriced') break;
      if (drop === MAX_BUDGET_DROPS) break;
      const trimmed = withoutTrailingBlocks(offered);
      if (trimmed === offered || trimmed.length === 0) break;
      offered = trimmed as readonly FactSource[];
    }

    if (countFailed) {
      // A count that cannot be taken is a call that is not made: the alternative is
      // spending against a number nobody has.
      await release();
      const cost = await totalCost();
      bump('extraction_count_failed');
      const closed = await failRun(context, {
        runId,
        at: input.at,
        refusalCode: 'provider_failure',
        costCents: cost.cents,
        costEstimated: cost.estimated,
        extraction: 'failed',
      });
      if (!closed) return closedElsewhere();
      return refuse('provider_failure');
    }

    if (counted === null) {
      // It still does not fit. Not a failure and not a cost: the pages are recorded as
      // evidence, the judgments come from the firm's routes and its suppression, and the
      // run says `over_budget` so a person can raise the ceiling or narrow the pages.
      await release();
      bump('extraction_over_budget');
      extractionOutcome = 'over_budget';
    } else {
      const answer = await providerAttempt(async () =>
        await extraction.extract({
          sources: offered.map(source => ({ sourceReference: source.sourceReference, blocks: source.blocks })),
          firmName: firm.value.name,
          // The snapshot's model and output bound, never the settings': these are the
          // two numbers the cents were computed from.
          modelName: snapshot.modelName,
          maxOutputTokens: snapshot.maxOutputTokens,
        }),
      );
      // Settled by id, exactly once. `estimated` when nobody said what it cost — a
      // throw, or a response with no usage — because zero is certainly wrong about a
      // call that may have been billed.
      const estimated = answer.costEstimated === true;
      if (reservation !== null) {
        await settleAttempt(context, {
          reservationId: reservation.id,
          at: input.at,
          outcome: estimated ? { kind: 'estimated' } : { kind: 'settled', cents: answer.costCents },
        });
      }
      await recordProviderCall(context, {
        providerKey: extraction.providerKey,
        at: input.at,
        businessTimeZone,
        // The cents are on the reservation, which is what adds them to the ledger's
        // total; this call records that a call happened and whether it failed.
        costCents: 0,
        ...(answer.ok ? {} : { failureCode: answer.failureCode }),
      });
      if (answer.ok) {
        const validation = validateFactSelections(answer.value.selections, offered);
        facts = validation.facts;
        factsRefused = validation.refused.length;
        for (const entry of validation.refused) bump(`fact_${entry.refusal}`);
        modelName = answer.value.modelName;
        inputTokens = answer.value.inputTokens;
        outputTokens = answer.value.outputTokens;
        if (answer.value.questions !== null && answer.value.opening !== null) {
          generated = { questions: answer.value.questions, opening: answer.value.opening };
        }
      } else {
        // Observed, and never a reason to discard the pages this run already recorded.
        // The sweep retries tomorrow as a new revision; the evidence stays.
        bump(`extraction_${answer.failureCode}`);
        const cost = await totalCost();
        const closed = await failRun(context, {
          runId,
          at: input.at,
          refusalCode: 'provider_failure',
          costCents: cost.cents,
          costEstimated: cost.estimated,
          extraction: 'failed',
        });
        if (!closed) return closedElsewhere();
        return refuse('provider_failure');
      }
    }
  } else {
    // Nothing was asked of the model, so this attempt's cents come back.
    await release();
    // A claim that may not call, on a run that had pages and a model port, is the
    // requeue case: the attempt's call was already settled, so the run is recorded
    // without one and says the extraction failed rather than that none was configured.
    if (!mayCall && sources.length > 0 && input.extraction !== undefined) extractionOutcome = 'failed';
  }

  const recorded = await insertFacts(context, {
    firmId: input.firmId,
    runId,
    facts,
    evidenceByReference,
  });

  const judgments = judgeFirm({
    facts: recorded,
    hasPhoneRoute: await firmHasPhoneRoute(context, input.firmId),
    suppressed: await firmIsSuppressed(context, input.firmId),
    contacts: await listFirmContacts(context, input.firmId),
    // Read from memory and never stored: a person key holds no quote, and what comes
    // out of the match is a contact id.
    roleBlocks: roleBlockTexts(recorded, sources),
  });
  const wasCallFirst = await currentCallFirst(context, input.firmId);
  await upsertJudgments(context, { firmId: input.firmId, runId, at: input.at, judgments });

  // The funnel, inside the chunk's transaction (lane J-facts,
  // `docs/greenfield/funnel.md`). `{firm}:{revision}` is the run's identity, so a
  // handler claimed twice — which cannot get this far, because the run row is already
  // there — and a replay both produce one fact rather than a unique violation that
  // would abort this transaction. The detail carries only the two judgments a funnel
  // reader needs; `recordFunnelFact` refuses anything that is not a flat coded value.
  await recordFunnelFact(context, {
    kind: 'firm.researched',
    source: 'research',
    dedupeKey: `${input.firmId}:${String(input.revision)}`,
    firmId: input.firmId,
    detail: { revision: input.revision, fit: judgments.fit, reachability: judgments.reachability },
  });
  // And the moment a firm joins the call-first queue. Keyed by the firm alone, so the
  // fact is "this firm became callable", recorded once however many later runs agree —
  // which is what a funnel counts, rather than how often research ran.
  if (judgments.callFirst && !wasCallFirst) {
    await recordFunnelFact(context, {
      kind: 'firm.queued_for_call',
      source: 'research',
      dedupeKey: input.firmId,
      firmId: input.firmId,
    });
  }

  const cost = await totalCost();
  const closed = await completeRun(context, {
    runId,
    at: input.at,
    pagesFetched: fetched.value.pages.length,
    factsRecorded: recorded.length,
    modelName,
    inputTokens,
    outputTokens,
    costCents: cost.cents,
    costEstimated: cost.estimated,
    extraction: extractionOutcome,
    brief: generated === null ? null : { ...generated, generated: true },
  });
  if (!closed) return closedElsewhere();

  return accept({
    runId,
    firmId: input.firmId,
    revision: input.revision,
    outcome: 'completed',
    pagesFetched: fetched.value.pages.length,
    evidenceRecorded,
    factsRecorded: recorded.length,
    factsRefused,
    costCents: cost.cents,
    callFirst: judgments.callFirst,
    callFirstBecameTrue: judgments.callFirst && !wasCallFirst,
    skipped,
  });
}

/**
 * Where a run has got to, from its own rows.
 *
 * What a handler with a missing or malformed cursor asks instead of starting again. The
 * rows are more trustworthy than a cursor for the reason the rows exist: they are the
 * same facts the money is recorded against.
 */
export async function recoverResearchCursor(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly revision: number },
): Promise<{ readonly runId: string; readonly terminal: boolean } | null> {
  const run = await readRunForRevision(context, input);
  if (run === null) return null;
  return { runId: run.id, terminal: run.outcome !== 'running' };
}

/**
 * All three chunks, in sequence.
 *
 * For a direct caller that wants one answer. The **handler does not use this**: running
 * the chunks in one transaction is the arrangement the split exists to end, and a caller
 * here is a caller with no chunk protocol to commit between them.
 */
export async function runFirmResearch(
  context: RepositoryContext,
  input: RunFirmResearchInput,
): Promise<ResearchResult<ResearchRunReport>> {
  const started = await beginFirmResearch(context, input);
  if (!started.ok) return started;
  if (started.value.kind === 'done') return accept(started.value.report);
  const permission = await ensureResearchCalling(context, {
    runId: started.value.runId,
    at: input.at,
    maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS,
    hasExtraction: input.extraction !== undefined,
  });
  if (permission.kind === 'closed') return refuse('provider_failure');
  return await finishFirmResearch(context, {
    runId: started.value.runId,
    firmId: input.firmId,
    revision: input.revision,
    at: input.at,
    attempt: permission.attempt,
    mayCall: permission.kind === 'calling',
    pageFetch: input.pageFetch,
    ...(input.extraction === undefined ? {} : { extraction: input.extraction }),
  });
}

/**
 * A provider call as a value, whatever it does.
 *
 * `ProviderOutcome` already covers a provider that reports a failure. This covers the
 * other one — a transport that throws, a JSON parse that throws, an adapter with a bug
 * — because after `claimResearchClearance` a throw does not fail the run, it erases
 * the run's accounting and re-authorizes the spend. `costEstimated` is what stops the
 * zero being read as free: the call may have been billed, and the caller records the
 * run's reservation instead.
 */
async function providerAttempt<T>(call: () => Promise<ProviderOutcome<T>>): Promise<ProviderOutcome<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, failureCode: 'transport_error', costCents: 0, costEstimated: true };
  }
}

/**
 * The published text of the blocks this run's `role` and `named_role` facts named.
 *
 * In memory, from the pages just fetched, for `likelyContactId` alone. The facts
 * themselves carry no quote for those keys, so this is the only place the text exists,
 * and it exists for the length of one function call.
 */
function roleBlockTexts(
  facts: readonly AdmittedFact[],
  sources: readonly FactSource[],
): readonly string[] {
  const texts: string[] = [];
  for (const fact of facts) {
    if (fact.key !== 'role' && fact.key !== 'named_role') continue;
    const source = sources.find(entry => entry.sourceReference === fact.sourceReference);
    const block = source?.blocks.find(entry => entry.id === fact.blockId);
    if (block !== undefined) texts.push(block.text);
  }
  return texts;
}

/** The https links a person added for this firm. */
export async function readFirmLinks(context: RepositoryContext, firmId: string): Promise<readonly string[]> {
  const { rows } = await context.db.query<{ url: string }>(
    'SELECT url FROM firm_links WHERE workspace_id = $1 AND firm_id = $2 ORDER BY added_at, id',
    [context.scope.workspaceId, firmId],
  );
  return rows.map(row => row.url);
}

async function insertFacts(
  context: RepositoryContext,
  input: {
    readonly firmId: string;
    readonly runId: string;
    readonly facts: readonly AdmittedFact[];
    readonly evidenceByReference: ReadonlyMap<string, { readonly id: string; readonly retrievedAt: string }>;
  },
): Promise<readonly (AdmittedFact & { readonly id: string })[]> {
  const recorded: (AdmittedFact & { id: string })[] = [];
  for (const fact of input.facts) {
    const evidence = input.evidenceByReference.get(fact.sourceReference);
    if (evidence === undefined) continue;
    // `ON CONFLICT DO UPDATE` rather than `DO NOTHING`: the same sentence selected for
    // the same key against the same evidence is the same fact, and the run that saw it
    // most recently is the one that should own it, so the runs list stays truthful.
    const { rows } = await context.db.query<{ id: string }>(
      `INSERT INTO firm_facts
         (workspace_id, firm_id, run_id, evidence_id, key, block_id, quote, first_party, retrieved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
       ON CONFLICT ON CONSTRAINT firm_facts_one_per_selection DO UPDATE
          SET run_id = EXCLUDED.run_id, quote = EXCLUDED.quote, first_party = EXCLUDED.first_party,
              retrieved_at = EXCLUDED.retrieved_at
       RETURNING id`,
      [
        context.scope.workspaceId,
        input.firmId,
        input.runId,
        evidence.id,
        fact.key,
        fact.blockId,
        fact.quote,
        fact.firstParty,
        evidence.retrievedAt,
      ],
    );
    const id = rows[0]?.id;
    if (id !== undefined) recorded.push({ ...fact, id });
  }
  return recorded;
}

async function firmHasPhoneRoute(context: RepositoryContext, firmId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ present: boolean }>(
    `SELECT true AS present FROM phone_routes
      WHERE workspace_id = $1 AND firm_id = $2 AND eligibility IN ('usable', 'candidate') LIMIT 1`,
    [context.scope.workspaceId, firmId],
  );
  return rows[0]?.present === true;
}

async function listFirmContacts(context: RepositoryContext, firmId: string): Promise<readonly JudgmentContact[]> {
  const { rows } = await context.db.query<{ id: string; full_name: string; title: string | null }>(
    `SELECT id, full_name, title FROM contacts
      WHERE workspace_id = $1 AND firm_id = $2 AND status = 'active'
      ORDER BY is_primary DESC, created_at`,
    [context.scope.workspaceId, firmId],
  );
  return rows.map(row => ({ contactId: row.id, fullName: row.full_name, title: row.title }));
}

async function currentCallFirst(context: RepositoryContext, firmId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ call_first: boolean }>(
    'SELECT call_first FROM firm_judgments WHERE workspace_id = $1 AND firm_id = $2',
    [context.scope.workspaceId, firmId],
  );
  return rows[0]?.call_first === true;
}

async function upsertJudgments(
  context: RepositoryContext,
  input: {
    readonly firmId: string;
    readonly runId: string;
    readonly at: string;
    readonly judgments: ReturnType<typeof judgeFirm>;
  },
): Promise<void> {
  const { judgments } = input;
  await context.db.query(
    `INSERT INTO firm_judgments
       (workspace_id, firm_id, run_id, fit, problem_evidence, timing, reachability, reasons,
        call_first, likely_contact_id, judged_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::timestamptz)
     ON CONFLICT (workspace_id, firm_id) DO UPDATE
        SET run_id = EXCLUDED.run_id, fit = EXCLUDED.fit, problem_evidence = EXCLUDED.problem_evidence,
            timing = EXCLUDED.timing, reachability = EXCLUDED.reachability, reasons = EXCLUDED.reasons,
            call_first = EXCLUDED.call_first, likely_contact_id = EXCLUDED.likely_contact_id,
            judged_at = EXCLUDED.judged_at`,
    [
      context.scope.workspaceId,
      input.firmId,
      input.runId,
      judgments.fit,
      judgments.problemEvidence,
      judgments.timing,
      judgments.reachability,
      JSON.stringify(judgments.reasons),
      judgments.callFirst,
      judgments.likelyContactId,
      input.at,
    ],
  );
}
