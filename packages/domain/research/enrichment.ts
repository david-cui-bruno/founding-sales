import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordEvidence } from '../crm/evidence.ts';
import { claimResearchClearance } from './ceilings.ts';
import { evidenceRetentionExpiry, readProvider, recordProviderCall } from './configuration.ts';
import { findDuplicateCandidates, suggestDuplicate } from './duplicates.ts';
import { firmIsResearchable } from './discovery.ts';
import { resolveResearchFirmZone } from './firmZone.ts';
import { findBusinessEmail, withheldEmails, type BusinessEmailPage } from './businessEmail.ts';
import { targetFitVerdict, validateFactSelections, type CompanyFact, type FactSource } from './facts.ts';
import { mailtoTargets, parsePageText } from './pageText.ts';
import { permittedFirmSources, researchSourcePolicy, websiteRootOf } from './sourcePolicy.ts';
import { recordSuggestion } from './suggestions.ts';
import type { ExtractionProvider, PageFetchProvider } from './providers.ts';
import { accept, refuse, type ResearchRefusalCode, type ResearchResult } from './types.ts';

/**
 * Enrichment: one firm, at one revision (specification 7.4, 13.2, Appendix C;
 * deliverable 1).
 *
 * > Enrichment may add evidence to existing firms and suggest canonical values,
 * > contacts, and routes.
 *
 * Which is exactly the list of things it does, and the list stops there. It creates no
 * contact and no route: it *suggests* them. That is a deliberate narrowing of what the
 * old build did — the old page provider admitted routes directly — and the reason is
 * section 7.4's next sentence, which makes a route's promotion the versioned policy's
 * decision and leaves a weak route a candidate. A suggested route a person accepts
 * still goes through `addPhoneRoute`, where `decideRouteEligibility` decides what it
 * becomes. See `docs/decisions/g10-enrichment-suggests-routes.md`.
 *
 * ## The revision is the idempotency
 *
 * Appendix C: `research-firm:{firm}:{revision}`, protected by "firm/evidence
 * revision". `nextFirmResearchRevision` is one more than the firm's highest recorded
 * run, and `research_firm_runs` is unique on `(workspace, firm, revision)`. So the
 * caller materializes a job for a named revision, and a job claimed twice finds the
 * row it already opened and does nothing again.
 *
 * That also answers scenario 37's other half. A merge takes the source firm's row lock
 * before it reads anything; an enrichment holds `FOR KEY SHARE` on that row through
 * every child insert it makes. So either the enrichment commits first and the merge
 * carries its evidence and suggestions over, or the merge commits first and the
 * enrichment's next command reads a firm whose status is `merged` and refuses.
 *
 * ## A suppressed firm is never refreshed
 *
 * `firmIsResearchable` is asked before the clearance is claimed and before any
 * provider is called. A firm a prospect has asked not to be contacted is not
 * re-read, and the run records `firm_suppressed` so the refusal is visible rather than
 * silent. The enqueue path asks the same question, so a suppressed firm is not queued
 * either.
 */

export interface EnrichmentRunInput {
  readonly firmId: string;
  /** The revision this job was materialized for. Appendix C's `{revision}`. */
  readonly revision: number;
  readonly pageFetch: PageFetchProvider;
  /** Optional: without it the run records pages and deterministic findings only. */
  readonly extraction?: ExtractionProvider | undefined;
  /** Database time. One run dates every write it makes identically. */
  readonly at: string;
}

export interface EnrichmentRunReport {
  readonly runId: string;
  readonly firmId: string;
  readonly revision: number;
  readonly outcome: 'completed' | 'already_recorded';
  readonly pagesFetched: number;
  readonly evidenceRecorded: number;
  readonly factsAdmitted: number;
  readonly factsRefused: number;
  readonly suggestionsCreated: number;
  readonly fieldsFilled: number;
  readonly duplicatesSuggested: number;
  readonly costMicros: number;
  readonly targetFit: 'yes' | 'no' | null;
  readonly skipped: Readonly<Record<string, number>>;
}

/** The revision a new enrichment job for this firm should carry. */
export async function nextFirmResearchRevision(context: RepositoryContext, firmId: string): Promise<number> {
  const { rows } = await context.db.query<{ revision: number | null }>(
    'SELECT max(revision) AS revision FROM research_firm_runs WHERE workspace_id = $1 AND firm_id = $2',
    [context.scope.workspaceId, firmId],
  );
  return (rows[0]?.revision ?? 0) + 1;
}

export async function runFirmEnrichment(
  context: RepositoryContext,
  input: EnrichmentRunInput,
): Promise<ResearchResult<EnrichmentRunReport>> {
  if (!Number.isInteger(input.revision) || input.revision < 1) return refuse('invalid_input');

  const researchable = await firmIsResearchable(context, input.firmId);
  if (!researchable.ok) {
    await recordRefusedRun(context, input.firmId, input.revision, researchable.reason);
    return refuse(researchable.reason);
  }

  const clearance = await claimResearchClearance(context, {
    work: 'firm_enrichment',
    providerKey: input.pageFetch.providerKey,
    at: input.at,
  });
  if (!clearance.ok) {
    await recordRefusedRun(context, input.firmId, input.revision, clearance.reason);
    return refuse(clearance.reason);
  }
  if (clearance.value.provider.kind !== 'page') return refuse('provider_unknown');

  const runId = await openRun(context, input.firmId, input.revision);
  if (runId === null) {
    return accept({
      runId: '',
      firmId: input.firmId,
      revision: input.revision,
      outcome: 'already_recorded',
      pagesFetched: 0,
      evidenceRecorded: 0,
      factsAdmitted: 0,
      factsRefused: 0,
      suggestionsCreated: 0,
      fieldsFilled: 0,
      duplicatesSuggested: 0,
      costMicros: 0,
      targetFit: null,
      skipped: {},
    });
  }

  const firm = await readFirmForEnrichment(context, input.firmId);
  if (firm === null) {
    await closeRun(context, runId, { outcome: 'failed', refusalCode: 'firm_unknown' });
    return refuse('firm_unknown');
  }
  const root = websiteRootOf(firm.website ?? '');
  if (root === null) {
    // No website means nothing to read. Not a failure of the run; a firm that
    // publishes no site simply has no pages, and the record says so.
    await closeRun(context, runId, { outcome: 'refused', refusalCode: 'source_blocked' });
    return refuse('source_blocked');
  }

  const urls = permittedFirmSources(root.domain, clearance.value.settings.maxPagesPerFirm).filter(
    url => researchSourcePolicy(url) === 'candidate',
  );
  const fetched = await input.pageFetch.fetchPages({ urls, maxBytes: clearance.value.settings.maxPageBytes });
  await recordProviderCall(context, {
    providerKey: input.pageFetch.providerKey,
    costMicros: fetched.costMicros,
    ...(fetched.ok ? {} : { failureCode: fetched.failureCode }),
    businessTimeZone: clearance.value.businessTimeZone,
    at: input.at,
  });
  if (!fetched.ok) {
    await closeRun(context, runId, {
      outcome: 'failed',
      refusalCode: 'provider_refused',
      costMicros: fetched.costMicros,
    });
    return refuse('provider_refused');
  }

  const skipped: Record<string, number> = { ...fetched.value.skipped };
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  let costMicros = fetched.costMicros;
  let evidenceRecorded = 0;
  const factSources: FactSource[] = [];
  const emailPages: BusinessEmailPage[] = [];

  for (const page of fetched.value.pages) {
    const parsed = parsePageText(page.body, page.contentType);
    if (parsed.blocks.length === 0) {
      bump(parsed.truncated ? 'page_over_bound' : 'page_unreadable');
      continue;
    }
    const expiry = evidenceRetentionExpiry(clearance.value.provider, new Date(page.retrievedAt));
    const evidence = await recordEvidence(context, {
      firmId: input.firmId,
      provider: clearance.value.provider.providerKey,
      sourceReference: page.url,
      contentHash: page.contentHash,
      retrievedAt: new Date(page.retrievedAt),
      termsAllowRetention: clearance.value.provider.termsAllowRetention,
      ...(expiry === null ? {} : { retentionExpiresAt: expiry }),
      detail: { kind: 'company_page', blocks: parsed.blocks.length, truncated: parsed.truncated },
    });
    if (!evidence.ok) {
      bump(`evidence_${evidence.reason}`);
      continue;
    }
    evidenceRecorded += 1;
    // The evidence item's own reference is what a fact's provenance names, so a quote
    // can always be traced to the row that recorded the page it came from.
    factSources.push({ sourceReference: page.url, blocks: parsed.blocks });
    // Addresses may be in the rendered text or only in a `mailto:` attribute, so the
    // email pass reads both, with the markup's links appended as their own lines.
    const markup = new TextDecoder('utf-8').decode(page.body);
    emailPages.push({
      sourceReference: page.url,
      text: [parsed.blocks.map(block => block.text).join('\n'), ...mailtoTargets(markup)].join('\n'),
    });
  }

  let factsAdmitted = 0;
  let factsRefused = 0;
  let facts: readonly CompanyFact[] = [];
  if (input.extraction !== undefined && factSources.length > 0) {
    const extractionProvider = await readProvider(context, input.extraction.providerKey);
    if (extractionProvider === null || !extractionProvider.enabled) {
      bump('extraction_unavailable');
    } else {
      const selections = await input.extraction.extract({
        sources: factSources.map(source => ({ sourceReference: source.sourceReference, blocks: source.blocks })),
        maxInputBytes: clearance.value.settings.maxPageBytes,
      });
      await recordProviderCall(context, {
        providerKey: input.extraction.providerKey,
        costMicros: selections.costMicros,
        ...(selections.ok ? {} : { failureCode: selections.failureCode }),
        businessTimeZone: clearance.value.businessTimeZone,
        at: input.at,
      });
      costMicros += selections.costMicros;
      if (selections.ok) {
        // The quote is looked up from the block, never taken from the provider.
        const validation = validateFactSelections(selections.value, factSources);
        facts = validation.facts;
        factsAdmitted = validation.facts.length;
        factsRefused = validation.refused.length;
        for (const entry of validation.refused) bump(`fact_${entry.refusal}`);
      } else {
        // A failed extraction is observed, never a reason to discard the pages and
        // the evidence this run already recorded.
        bump('extraction_failed');
      }
    }
  }

  let suggestionsCreated = 0;
  let fieldsFilled = 0;
  const propose = async (finding: Parameters<typeof recordSuggestion>[1]): Promise<void> => {
    const recorded = await recordSuggestion(context, finding);
    if (!recorded.ok) {
      bump(`suggestion_${recorded.reason}`);
      return;
    }
    suggestionsCreated += 1;
    if (recorded.value.applied) fieldsFilled += 1;
  };

  // The one address the firm publishes on its own domain. A suggestion, not a route:
  // section 7.4 makes the promotion the policy's decision, and a person accepting the
  // suggestion goes through `addEmailRoute`, where the policy decides.
  const found = findBusinessEmail({
    domain: root.domain,
    pages: emailPages,
    withheld: withheldEmails(emailPages),
  });
  if (found.finding !== null) {
    await propose({
      firmId: input.firmId,
      kind: 'email_route',
      proposedValue: found.finding.email,
      confidence: found.finding.selection === 'role_mailbox' ? 0.7 : 0.6,
      providerKey: clearance.value.provider.providerKey,
      dedupeKey: `email:${found.finding.email}`,
    });
  }
  for (const [reason, count] of Object.entries(found.refused)) {
    if (count > 0) skipped[`email_${reason}`] = (skipped[`email_${reason}`] ?? 0) + count;
  }

  // Each admitted fact is a suggestion about the firm. None of them is a canonical
  // field in `FILLABLE_CANONICAL_FIELDS`, so none of them is applied automatically;
  // `recordSuggestion` decides that, not this loop.
  for (const fact of facts) {
    await propose({
      firmId: input.firmId,
      kind: 'canonical_field',
      fieldKey: fact.key,
      proposedValue: fact.quote.slice(0, 500),
      confidence: 0.6,
      providerKey: input.extraction?.providerKey ?? clearance.value.provider.providerKey,
      dedupeKey: `${fact.key}:${fact.sourceReference}:${fact.blockId}`,
    });
  }

  // A coordinate may have arrived since the firm was created, and a rule version may
  // have changed, so the zone is re-decided on every enrichment.
  await resolveResearchFirmZone(context, { firmId: input.firmId });

  let duplicatesSuggested = 0;
  for (const duplicate of await findDuplicateCandidates(context, { firmId: input.firmId })) {
    const suggested = await suggestDuplicate(context, duplicate, clearance.value.provider.providerKey);
    if (suggested.ok) duplicatesSuggested += 1;
  }

  await closeRun(context, runId, {
    outcome: 'completed',
    evidenceRecorded,
    suggestionsCreated,
    costMicros,
    skipped,
  });

  return accept({
    runId,
    firmId: input.firmId,
    revision: input.revision,
    outcome: 'completed',
    pagesFetched: fetched.value.pages.length,
    evidenceRecorded,
    factsAdmitted,
    factsRefused,
    suggestionsCreated,
    fieldsFilled,
    duplicatesSuggested,
    costMicros,
    targetFit: targetFitVerdict(facts),
    skipped,
  });
}

interface EnrichmentFirm {
  readonly website: string | null;
}

async function readFirmForEnrichment(
  context: RepositoryContext,
  firmId: string,
): Promise<EnrichmentFirm | null> {
  const { rows } = await context.db.query<{ website: string | null }>(
    "SELECT website FROM firms WHERE workspace_id = $1 AND id = $2 AND status = 'active'",
    [context.scope.workspaceId, firmId],
  );
  const row = rows[0];
  return row === undefined ? null : { website: row.website };
}

async function openRun(
  context: RepositoryContext,
  firmId: string,
  revision: number,
): Promise<string | null> {
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO research_firm_runs (workspace_id, firm_id, revision)
     VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT research_firm_runs_one_per_revision DO NOTHING
     RETURNING id`,
    [context.scope.workspaceId, firmId, revision],
  );
  return rows[0]?.id ?? null;
}

async function closeRun(
  context: RepositoryContext,
  runId: string,
  input: {
    readonly outcome: 'completed' | 'refused' | 'failed';
    readonly refusalCode?: ResearchRefusalCode | undefined;
    readonly evidenceRecorded?: number | undefined;
    readonly suggestionsCreated?: number | undefined;
    readonly costMicros?: number | undefined;
    readonly skipped?: Readonly<Record<string, number>> | undefined;
  },
): Promise<void> {
  await context.db.query(
    `UPDATE research_firm_runs
        SET outcome = $3, completed_at = now(), refusal_code = $4,
            evidence_recorded = $5, suggestions_created = $6, cost_micros = $7::bigint
      WHERE workspace_id = $1 AND id = $2`,
    [
      context.scope.workspaceId,
      runId,
      input.outcome,
      input.refusalCode ?? null,
      input.evidenceRecorded ?? 0,
      input.suggestionsCreated ?? 0,
      Math.max(0, Math.trunc(input.costMicros ?? 0)),
    ],
  );
}

/**
 * Record that a run was refused before it started.
 *
 * A refusal is written down. "The ceiling stopped it" and "the firm is suppressed" are
 * the two answers an operator most needs from a research queue that produced nothing,
 * and a job that completed silently gives neither.
 */
async function recordRefusedRun(
  context: RepositoryContext,
  firmId: string,
  revision: number,
  refusalCode: ResearchRefusalCode,
): Promise<void> {
  await context.db.query(
    `INSERT INTO research_firm_runs
       (workspace_id, firm_id, revision, completed_at, outcome, refusal_code)
     VALUES ($1, $2, $3, now(), 'refused', $4)
     ON CONFLICT ON CONSTRAINT research_firm_runs_one_per_revision DO NOTHING`,
    [context.scope.workspaceId, firmId, revision, refusalCode],
  );
}
