import { recordEvidence } from '../crm/evidence.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordFunnelFact } from '../funnel/facts.ts';
import { firmIsResearchable, firmIsSuppressed } from './firmState.ts';
import { validateFactSelections, type AdmittedFact, type FactSource } from './facts.ts';
import type { ProviderOutcome } from './providers.ts';
import { judgeFirm, type JudgmentContact } from './judgments.ts';
import { parsePageText } from './pageText.ts';
import { claimResearchClearance } from './ceilings.ts';
import { recordProviderCall } from './ledger.ts';
import { researchUrlsForFirm } from './sourcePolicy.ts';
import { completeRun, failRun, openRun, recordRefusedRun, refuseRun } from './runs.ts';
import type { ExtractionProvider, PageFetchProvider } from './providers.ts';
import {
  COMPANY_PAGE_PROVIDER,
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

export async function runFirmResearch(
  context: RepositoryContext,
  input: RunFirmResearchInput,
): Promise<ResearchResult<ResearchRunReport>> {
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
  if (runId === null) return accept(replayed(input.firmId, input.revision));

  const clearance = await claimResearchClearance(context, { at: input.at });
  if (!clearance.ok) {
    await refuseRun(context, { runId, at: input.at, refusalCode: clearance.reason });
    return refuse(clearance.reason);
  }
  const settings = clearance.value.settings;

  const links = await readFirmLinks(context, input.firmId);
  const urls = researchUrlsForFirm({
    firmWebsite: firm.value.website,
    links,
    maxPagesPerFirm: settings.maxPagesPerFirm,
  });
  if (urls.length === 0) {
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
    businessTimeZone: clearance.value.businessTimeZone,
    costCents: fetched.costCents,
    ...(fetched.ok ? {} : { failureCode: fetched.failureCode }),
  });
  if (!fetched.ok) {
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
  let generated: { readonly questions: readonly [string, string]; readonly opening: string } | null = null;

  if (input.extraction !== undefined && sources.length > 0) {
    const extraction = input.extraction;
    const answer = await providerAttempt(async () =>
      await extraction.extract({
        sources: sources.map(source => ({ sourceReference: source.sourceReference, blocks: source.blocks })),
        firmName: firm.value.name,
      }),
    );
    await recordProviderCall(context, {
      providerKey: input.extraction.providerKey,
      at: input.at,
      businessTimeZone: clearance.value.businessTimeZone,
      costCents: answer.costCents,
      ...(answer.ok ? {} : { failureCode: answer.failureCode }),
    });
    costCents += answer.costCents;
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
      // The job's ladder retries; the evidence stays.
      bump(`extraction_${answer.failureCode}`);
      await failRun(context, { runId, at: input.at, refusalCode: 'provider_failure', costCents });
      return refuse('provider_failure');
    }
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

  // The funnel, inside the run's transaction (lane J-facts,
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
 * A provider call as a value, whatever it does.
 *
 * `ProviderOutcome` already covers a provider that reports a failure. This covers the
 * other one — a transport that throws, a JSON parse that throws, an adapter with a bug
 * — because after `claimResearchClearance` a throw does not fail the run, it erases
 * the run's accounting and re-authorizes the spend. `costCents: 0` is the honest figure
 * for a call whose response never arrived: what it actually cost is unknowable, and the
 * ledger's failure count is what says the attempt happened.
 */
async function providerAttempt<T>(call: () => Promise<ProviderOutcome<T>>): Promise<ProviderOutcome<T>> {
  try {
    return await call();
  } catch {
    return { ok: false, failureCode: 'transport_error', costCents: 0 };
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
