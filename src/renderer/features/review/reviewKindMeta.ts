import type { ReviewItem, ReviewKind } from '../../../shared/contracts/reviewContract';

/**
 * A queue kind reached rendering without UI metadata. The exhaustive
 * switches below make TypeScript fail compilation when a new review kind
 * is added to the contract without a queue tab, copy, and actions.
 */
export function assertNeverReviewKind(value: never): never {
  throw new Error(`Unhandled review kind: ${String(value)}`);
}

/** Fixed tab order: communication triage first, system safety last. */
export const REVIEW_KIND_ORDER = Object.freeze([
  'unmatched_communication',
  'ambiguous_identity',
  'transcript_suggestion',
  'import_problem',
  'adapter_failure',
  'system_error',
] as const satisfies readonly ReviewKind[]);

export type ReviewKindMeta = {
  tabLabel: string;
  emptyCopy: string;
};

/** The only renderer copies of review queue display strings. */
export function reviewKindMeta(kind: ReviewKind): ReviewKindMeta {
  switch (kind) {
    case 'unmatched_communication':
      return {
        tabLabel: 'Unmatched communications',
        emptyCopy: 'No items are shown in this local review snapshot. This is not an import-completeness, identity-completeness, or adapter-health check.',
      };
    case 'ambiguous_identity':
      return {
        tabLabel: 'Ambiguous identities',
        emptyCopy: 'No items are shown in this local review snapshot. This is not an import-completeness, identity-completeness, or adapter-health check.',
      };
    case 'transcript_suggestion':
      return {
        tabLabel: 'Transcript suggestions',
        emptyCopy: 'No items are shown in this local review snapshot. This is not an import-completeness, identity-completeness, or adapter-health check.',
      };
    case 'import_problem':
      return {
        tabLabel: 'Import problems',
        emptyCopy: 'No items are shown in this local review snapshot. This is not an import-completeness, identity-completeness, or adapter-health check.',
      };
    case 'adapter_failure':
      return {
        tabLabel: 'Adapter failures',
        emptyCopy: 'No items are shown in this local review snapshot. This is not an import-completeness, identity-completeness, or adapter-health check.',
      };
    case 'system_error':
      return {
        tabLabel: 'System errors',
        emptyCopy: 'No items are shown in this local review snapshot. This is not an import-completeness, identity-completeness, or adapter-health check.',
      };
    default:
      return assertNeverReviewKind(kind);
  }
}

const CHANNEL_LABELS = Object.freeze({
  call: 'Call',
  text: 'Text',
  email: 'Email',
});

/** One-line headline shown on the queue row and the detail panel. */
export function reviewItemTitle(item: ReviewItem): string {
  switch (item.kind) {
    case 'unmatched_communication':
      return `${CHANNEL_LABELS[item.channel]} from ${item.handle}`;
    case 'ambiguous_identity':
      return item.summary;
    case 'transcript_suggestion':
      return item.proposedValue;
    case 'import_problem':
      return `Row ${item.rowNumber}`;
    case 'adapter_failure':
      return item.adapter;
    case 'system_error':
      return item.summary;
    default:
      return assertNeverReviewKind(item);
  }
}

/** Supporting line under the headline. */
export function reviewItemSummary(item: ReviewItem): string {
  switch (item.kind) {
    case 'unmatched_communication':
      return item.summary;
    case 'ambiguous_identity':
      return `${item.candidatePersonIds.length} candidate people`;
    case 'transcript_suggestion':
      return item.evidence[0] ?? '';
    case 'import_problem':
      return item.summary;
    case 'adapter_failure':
      return item.summary;
    case 'system_error':
      return `Invariant: ${item.invariant}`;
    default:
      return assertNeverReviewKind(item);
  }
}
