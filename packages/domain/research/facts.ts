import type { PageBlock } from './pageText.ts';

/**
 * The bounded fact set an extraction provider may select from, and the provenance
 * rule that makes a selection admissible.
 *
 * Ported from `59b3e1bb^:packages/domain/research/facts.ts`, widened by six keys and
 * narrowed in one way that matters: nothing here decides a verdict. The old file had
 * `targetFitVerdict`; the four judgments now live in `judgments.ts`, so this file is
 * only about what a page said.
 *
 * Two rules make a selection admissible:
 *
 *   * the key must be one of `FACT_KEYS` — a closed set, so a provider cannot invent
 *     a field that then lands on a firm;
 *   * the quote is the **whole text of the block the selection names**, looked up
 *     here. A provider returns `{ key, sourceReference, blockId }` and no text at all,
 *     so it cannot paraphrase, trim a qualifier or drop a negation. That single rule
 *     is what keeps a "fact" attributable to something the firm published.
 *
 * Nothing in this file grants any permission, and no key here can hold a person's
 * name, address, number or e-mail. That is by construction — there is no such key —
 * and `isNonContactFact` is the function a later widening has to come past.
 */

/**
 * The facts a provider may select.
 *
 * The first eight are the old set. `target_fit` names a block showing the firm manages
 * property for others; `not_target` names one showing it does not (brokerage only,
 * association only, commercial only, a vendor). Neither selected leaves fit unknown,
 * which is the honest third state.
 *
 * The six added for v1 are the ones the four judgments need:
 *
 *   * `portfolio_size` — a published count of doors or properties.
 *   * `software_evidence` — the firm names a portal, an owner login or a product.
 *     A portal link supports a software inference. It proves nothing about budget.
 *   * `hiring_maintenance` — the firm's own careers page advertises maintenance or
 *     coordination work. It suggests an opportunity for discussion, and nothing more.
 *   * `phone_listed` — the firm publishes a number to call. Not the number itself:
 *     the block that shows one exists, which is a reachability fact and not a route.
 *   * `named_role` — a named person with a title, on the firm's own team page.
 *   * `recent_change` — the firm says something changed: an acquisition, a new office,
 *     a new system, a growth announcement.
 */
export const FACT_KEYS = [
  'ownership',
  'portfolio_description',
  'portfolio_size',
  'residential_scope',
  'operating_footprint',
  'maintenance_workflow',
  'software_evidence',
  'hiring_maintenance',
  'phone_listed',
  'role',
  'named_role',
  'recent_change',
  'target_fit',
  'not_target',
] as const;
export type FactKey = (typeof FACT_KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(FACT_KEYS);

export function isFactKey(value: string): value is FactKey {
  return KEY_SET.has(value);
}

/**
 * One line each, sent to the extraction provider as the dictionary it selects from.
 *
 * Written here rather than in the prompt file so the definition a model is given and
 * the key the database stores cannot drift apart: the prompt is built by iterating
 * this record.
 */
export const FACT_KEY_DEFINITIONS: Readonly<Record<FactKey, string>> = Object.freeze({
  ownership: 'who owns or runs the firm, in the firm’s own words',
  portfolio_description: 'what kind of property the firm manages',
  portfolio_size: 'a published count of doors, units or properties managed',
  residential_scope: 'whether the firm manages residential property, and of what kind',
  operating_footprint: 'the cities, counties or states the firm operates in',
  maintenance_workflow: 'how the firm handles maintenance requests, vendors or work orders',
  software_evidence: 'a portal, owner login, tenant login or named product the firm uses',
  hiring_maintenance: 'the firm’s own careers page advertising maintenance or coordination work',
  phone_listed: 'a block showing the firm publishes a telephone number to call',
  role: 'a job title the firm names on its own site',
  named_role: 'a named person with a title on the firm’s own team page',
  recent_change: 'something the firm says has recently changed: an acquisition, an office, a system, growth',
  target_fit: 'the firm manages property on behalf of owners — it is the kind of firm we sell to',
  not_target: 'the firm is not that: brokerage only, an association, commercial only, or a vendor',
});

/** One source of blocks: a fetched page, named by the evidence reference it produced. */
export interface FactSource {
  readonly sourceReference: string;
  readonly blocks: readonly PageBlock[];
}

/** What an extraction provider returns. Deliberately no text field. */
export interface FactSelection {
  readonly key: string;
  readonly sourceReference: string;
  readonly blockId: string;
}

/** A selection that passed the provenance rule, with the quote looked up locally. */
export interface AdmittedFact {
  readonly key: FactKey;
  readonly sourceReference: string;
  readonly blockId: string;
  readonly quote: string;
}

export type FactRefusal = 'unknown_key' | 'unknown_source' | 'unknown_block' | 'duplicate_selection' | 'quote_too_long';

export interface FactValidation {
  readonly facts: readonly AdmittedFact[];
  /** Every selection that was not admitted, and why. Counted for the run record. */
  readonly refused: readonly { readonly selection: FactSelection; readonly refusal: FactRefusal }[];
}

/** `firm_facts_quote_present` refuses anything longer. A block over it is not a quote. */
export const MAX_QUOTE_CHARACTERS = 500;

/**
 * Admit the selections a provider returned.
 *
 * Total: an unrecognised key, an unknown source, an unknown block, a repeat or a
 * block too long to store is refused and counted rather than throwing, because one
 * bad selection must not discard the page's other evidence. The caller records the
 * counts; nothing here decides what the admitted facts are worth.
 */
export function validateFactSelections(
  selections: readonly FactSelection[],
  sources: readonly FactSource[],
): FactValidation {
  const index = new Map<string, Map<string, string>>();
  for (const source of sources) {
    const blocks = new Map<string, string>();
    for (const block of source.blocks) blocks.set(block.id, block.text);
    index.set(source.sourceReference, blocks);
  }

  const facts: AdmittedFact[] = [];
  const refused: { selection: FactSelection; refusal: FactRefusal }[] = [];
  const seen = new Set<string>();

  for (const selection of selections) {
    if (!isFactKey(selection.key)) {
      refused.push({ selection, refusal: 'unknown_key' });
      continue;
    }
    const blocks = index.get(selection.sourceReference);
    if (blocks === undefined) {
      refused.push({ selection, refusal: 'unknown_source' });
      continue;
    }
    const quote = blocks.get(selection.blockId);
    if (quote === undefined || quote.trim() === '') {
      refused.push({ selection, refusal: 'unknown_block' });
      continue;
    }
    if (quote.length > MAX_QUOTE_CHARACTERS) {
      // Dropped whole, never cut: half a published block is a sentence nobody wrote.
      refused.push({ selection, refusal: 'quote_too_long' });
      continue;
    }
    const fingerprint = `${selection.key}\u0000${selection.sourceReference}\u0000${selection.blockId}`;
    if (seen.has(fingerprint)) {
      refused.push({ selection, refusal: 'duplicate_selection' });
      continue;
    }
    seen.add(fingerprint);
    facts.push({ key: selection.key, sourceReference: selection.sourceReference, blockId: selection.blockId, quote });
  }

  return { facts, refused };
}

/**
 * Whether a fact key describes the firm rather than a way to reach a person.
 *
 * Every key in `FACT_KEYS` is non-contact by construction — the set contains no name,
 * address, number or e-mail key — and this function is the place that says so, so a
 * later widening has to come past it. `phone_listed` and `named_role` are the two
 * that look closest to a contact fact and are not: one records that a number exists,
 * the other that a page names a person. Neither stores the number or the name outside
 * the quote the firm itself published.
 */
export function isNonContactFact(key: FactKey): boolean {
  return FACT_KEYS.includes(key);
}
