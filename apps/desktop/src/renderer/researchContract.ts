import { z } from 'zod';
import {
  callBriefSchema,
  researchFactSchema,
  researchJudgmentsSchema,
  researchLinkSchema,
  researchRunSchema,
  researchSettingsSchema,
  researchSpendSchema,
  uuid,
} from '@fss/contracts';

/**
 * What the Research section and the Research settings are given (lane R).
 *
 * The whole state, every time, exactly as every other view's bridge answers: there is
 * no local model to go stale and no optimistic update to reconcile, which is 14.2's
 * "contains no authoritative … logic" made structural rather than promised.
 *
 * `firm` is null before a firm has been opened, and for a firm this person may not see
 * — the API answers `not_found` for a colleague's firm exactly as the Today card does,
 * and the window is told nothing more than that.
 *
 * `settings` is null for a salesperson: `/research/settings` is admin-only, including
 * the read, because the read *is* the workspace's budget. The section is absent rather
 * than inert, for the reason `SendingSection.tsx` gives — a control that exists only to
 * be refused teaches nothing.
 */

export const researchFirmViewSchema = z.strictObject({
  firmId: uuid,
  brief: callBriefSchema.nullable(),
  facts: z.array(researchFactSchema),
  judgments: researchJudgmentsSchema.nullable(),
  runs: z.array(researchRunSchema),
  links: z.array(researchLinkSchema),
});
export type ResearchFirmView = z.infer<typeof researchFirmViewSchema>;

export const researchStateSchema = z.strictObject({
  firm: researchFirmViewSchema.nullable(),
  /** Admin only; null for everybody else. */
  settings: researchSettingsSchema.nullable(),
  /** What one run may cost at the current settings. Null when the settings are. */
  worstCaseRunCents: z.number().int().min(0).nullable(),
  spend: researchSpendSchema.nullable(),
  /** A stable code, never a sentence composed here. */
  notice: z.string().max(80).nullable(),
  /** Whether a mutating command may be attempted at all. */
  mayMutate: z.boolean(),
  role: z.enum(['admin', 'salesperson']).nullable(),
});
export type ResearchState = z.infer<typeof researchStateSchema>;

export interface ResearchSettingsEdit {
  readonly enabled?: boolean;
  readonly dailyFirmCeiling?: number;
  readonly dailyCostCeilingCents?: number;
  readonly monthlyCostCeilingCents?: number;
  readonly maxPagesPerFirm?: number;
}
