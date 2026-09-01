import type { LearningCategory } from '../../../shared/contracts/learningsContract';

export const CATEGORY_LABELS: Readonly<Record<LearningCategory, string>> =
  Object.freeze({
    pain: 'Pain',
    objection: 'Objection',
    alternative: 'Alternative',
    winning_language: 'Winning language',
    pricing_reaction: 'Pricing reaction',
    product_request: 'Product request',
    coaching: 'Coaching',
    invalidated_assumption: 'Invalidated assumption',
  });
