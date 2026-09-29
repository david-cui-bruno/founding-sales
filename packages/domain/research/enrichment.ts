import { recordEvidence } from '../crm/evidence.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordFunnelFact } from '../funnel/facts.ts';
import { firmIsResearchable, firmIsSuppressed } from './firmState.ts';
import { validateFactSelections, type AdmittedFact, type FactSource } from './facts.ts';
import type { ProviderOutcome } from './providers.ts';
import { judgeFirm, type JudgmentContact } from './judgments.ts';
import { parsePageText } from './pageText.ts';
import { claimResearchClearance } from './ceilings.ts';
import { recordProviderCall, releaseProviderReservation, reserveProviderSpend, workspaceBusinessZone } from './ledger.ts';
import { researchUrlsForFirm } from './sourcePolicy.ts';
import { readResearchSettings } from './settings.ts';
import { completeRun, failRun, openRun, recordRefusedRun, refuseRun, type RunExtraction } from './runs.ts';
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
 * ## A firm with nothing to read
 *
 * No website and no added link is `no_sources`. It is a refusal rather than a
 * completion, because "we looked and there was nothing" and "there was nowhere to
 * look" are different things to see in a runs list.
 *
 * ## Two committed steps, because the middle of a run spends money
 *
 * `research.firm` is a **chunked** handler (`docs/greenfield/jobs.md`), and this file is
 * the two halves:
 *
 *   1. `beginFirmResearch` — the firm is researchable, the run row is opened, the day's
 *      count is consumed, and the worst case is **reserved** on the ledger. No provider
 *      has been touched. The runner commits this together with the cursor.
 *   2. `finishFirmResearch` — fetch, extract, record, judge, and turn the reservation
 *      into the actual figure. The runner commits this as the job's completion.
 *
 * The split is the whole point. Before it, the paid call happened inside the single
 * transaction that also held the run row, the ledger row and the consumed counter — so
 * a lease reclaimed during the extraction, or any database error after the call, rolled
 * back every trace of a call that had already been billed, and the retry spent the money
 * again against a budget that had never heard of the first attempt. Now a rollback of
 * chunk 2 leaves chunk 1 standing: the run exists, the count is spent, and the
 * reservation is still on the ledger. The month is over-counted by a few cents until the
 * run is finalised, and over-counting is the direction in which nothing can be lost.
 *
 * If chunk 2's own SQL fails, the reservation stands and the row stays `running`;
 * `finaliseAbandonedRuns` closes it half an hour later as `lease_lost` and keeps the
 * reservation as the recorded cost, because nobody can know whether the call was made.
 *
 * `runFirmResearch` runs both halves in sequence. It is what a direct caller and most
 * tests want — one call, one answer — and it is *not* what the handler uses, because
 * two halves in one transaction is exactly the arrangement the split exists to end.
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

/** What chunk 1 leaves for chunk 2. The handler carries it in `payload.progress`. */
export interface ResearchReservation {
  readonly runId: string;
  /** Cents held on `provider_ledger` for the extraction this run has not made yet. */
  readonly reservedCents: number;
}

export type ResearchStart =
  /** Chunk 2 has work to do. */
  | ({ readonly kind: 'reserved' } & ResearchReservation)
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
 * Nothing here opens a socket. What it does is make the run's existence, its consumed
 * unit of the day's count and its reserved cents durable, so that whatever happens to
 * the worker next, the budget already knows this run was authorized.
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

  const clearance = await claimResearchClearance(context, { at: input.at });
  if (!clearance.ok) {
    await refuseRun(context, { runId, at: input.at, refusalCode: clearance.reason });
    return refuse(clearance.reason);
  }

  // The number the two money checks were just made against, held on the ledger under
  // the provider that will spend it. From here on `readSpend` counts this run, so a
  // second run started in the same minute is authorized against a budget that already
  // includes it — which is the only arrangement under which two runs cannot each be
  // cleared against the same remaining cents.
  const reservedCents = clearance.value.worstCaseCents;
  await reserveProviderSpend(context, {
    providerKey: EXTRACTION_PROVIDER,
    at: input.at,
    businessTimeZone: clearance.value.businessTimeZone,
    cents: reservedCents,
  });

  return accept({ kind: 'reserved', runId, reservedCents });
}

export interface FinishResearchInput extends ResearchReservation {
  readonly firmId: string;
  readonly revision: number;
  readonly at: string;
  readonly pageFetch: PageFetchProvider;
  /** Absent when the deployment has no model key. The run is smaller, not failed. */
  readonly extraction?: ExtractionProvider | undefined;
}

/**
 * Chunk 2: the calls, the evidence, the judgment, and the money moved from reserved to
 * spent.
 *
 * Every exit from here closes the run row and settles the reservation — released when
 * no call was made, turned into the actual figure when one was. The one exit that does
 * neither is a database error, which rolls this chunk back and leaves the row `running`
 * for `finaliseAbandonedRuns`.
 */
export async function finishFirmResearch(
  context: RepositoryContext,
  input: FinishResearchInput,
): Promise<ResearchResult<ResearchRunReport>> {
  const { runId, reservedCents } = input;
  const settings = await readResearchSettings(context);
  const businessTimeZone = await workspaceBusinessZone(context);
  /** Hand back cents for a run that asked the provider nothing. */
  const releaseAll = async (): Promise<void> => {
    await releaseProviderReservation(context, {
      providerKey: EXTRACTION_PROVIDER,
      at: input.at,
      businessTimeZone,
      cents: reservedCents,
    });
  };

  // Asked again, because a suppression or a merge may have landed between the chunks,
  // and a firm that has asked to be left alone is left alone from the moment it asks.
  const firm = await firmIsResearchable(context, input.firmId);
  if (!firm.ok) {
    await releaseAll();
    await refuseRun(context, { runId, at: input.at, refusalCode: firm.reason });
    return firm;
  }

  const links = await readFirmLinks(context, input.firmId);
  const urls = researchUrlsForFirm({
    firmWebsite: firm.value.website,
    links,
    maxPagesPerFirm: settings.maxPagesPerFirm,
  });
  if (urls.length === 0) {
    await releaseAll();
    await refuseRun(context, { runId, at: input.at, refusalCode: 'no_sources' });
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
    // No model call was made, so the reservation goes back and the run records the
    // fetch's own cost, which is nothing.
    await releaseAll();
    await failRun(context, { runId, at: input.at, refusalCode: 'provider_failure', costCents: fetched.costCents });
    return refuse('provider_failure');
  }

  const skipped: Record<string, number> = { ...fetched.value.skipped };
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  let costCents = fetched.costCents;
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
  let costEstimated = false;
  let generated: { readonly questions: readonly [string, string]; readonly opening: string } | null = null;
  // Why the model was or was not used, recorded so the sweep can tell the difference
  // between "there was no key" and "there was nothing to read". Re-selecting the second
  // every day was an unbounded spend on a firm with no pages.
  let extractionOutcome: RunExtraction =
    sources.length === 0 ? 'no_pages' : input.extraction === undefined ? 'unconfigured' : 'used';

  if (input.extraction !== undefined && sources.length > 0) {
    const extraction = input.extraction;
    const answer = await providerAttempt(async () =>
      await extraction.extract({
        sources: sources.map(source => ({ sourceReference: source.sourceReference, blocks: source.blocks })),
        firmName: firm.value.name,
      }),
    );
    // What the call actually cost — unless nobody said, in which case the reservation is
    // the honest figure. A transport that threw and a response with no usage may both
    // have been billed, and zero is the one answer that is certainly wrong.
    costEstimated = answer.costEstimated === true;
    const extractionCents = costEstimated ? reservedCents : answer.costCents;
    await recordProviderCall(context, {
      providerKey: extraction.providerKey,
      at: input.at,
      businessTimeZone,
      costCents: extractionCents,
      releaseReservedCents: reservedCents,
      ...(answer.ok ? {} : { failureCode: answer.failureCode }),
    });
    costCents += extractionCents;
    if (answer.ok) {
      const validation = validateFactSelections(answer.value.selections, sources);
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
      extractionOutcome = 'failed';
      await failRun(context, {
        runId,
        at: input.at,
        refusalCode: 'provider_failure',
        costCents,
        costEstimated,
        extraction: extractionOutcome,
      });
      return refuse('provider_failure');
    }
  } else {
    // Nothing was asked of the model, so the cents come back.
    await releaseAll();
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

  await completeRun(context, {
    runId,
    at: input.at,
    pagesFetched: fetched.value.pages.length,
    factsRecorded: recorded.length,
    modelName,
    inputTokens,
    outputTokens,
    costCents,
    costEstimated,
    extraction: extractionOutcome,
    brief: generated === null ? null : { ...generated, generated: true },
  });

  return accept({
    runId,
    firmId: input.firmId,
    revision: input.revision,
    outcome: 'completed',
    pagesFetched: fetched.value.pages.length,
    evidenceRecorded,
    factsRecorded: recorded.length,
    factsRefused,
    costCents,
    callFirst: judgments.callFirst,
    callFirstBecameTrue: judgments.callFirst && !wasCallFirst,
    skipped,
  });
}

/**
 * Both halves, in sequence.
 *
 * For a direct caller that wants one answer. The **handler does not use this**: running
 * the two halves in one transaction is the arrangement the split exists to end, and a
 * caller here is a caller with no chunk protocol to commit between them.
 */
export async function runFirmResearch(
  context: RepositoryContext,
  input: RunFirmResearchInput,
): Promise<ResearchResult<ResearchRunReport>> {
  const started = await beginFirmResearch(context, input);
  if (!started.ok) return started;
  if (started.value.kind === 'done') return accept(started.value.report);
  return await finishFirmResearch(context, {
    runId: started.value.runId,
    reservedCents: started.value.reservedCents,
    firmId: input.firmId,
    revision: input.revision,
    at: input.at,
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
