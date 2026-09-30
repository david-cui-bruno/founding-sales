import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmMutation } from './authorization.ts';
import { loadFirmForUpdate } from './firms.ts';
import { loadOpportunityForUpdate } from './pipeline.ts';
import { recordOpportunityValue } from './stageEvidence.ts';
import { accept, refuse, type CrmResult } from './types.ts';

/**
 * A person records an opportunity's monthly value (Kanban slice K).
 *
 * `recordOpportunityValue` is the append-only write the worker uses for research and call
 * estimates and performs no authorization of its own. This is the person's entry point:
 * the opportunity and its firm are locked in `changeStage`'s order, `decideFirmMutation`
 * decides (the assignee or an administrator), and the row is written with source
 * `person`. A closed opportunity still takes a value — recording what a Lost or Live
 * customer was worth is not a move — but a merged firm does not.
 */
export async function setOpportunityValue(
  context: RepositoryContext,
  input: { readonly opportunityId: string; readonly monthlyCents: number; readonly kind: 'estimated' | 'agreed' },
): Promise<CrmResult<{ readonly opportunityId: string }>> {
  const opportunity = await loadOpportunityForUpdate(context, input.opportunityId);
  if (opportunity === null) return refuse('opportunity_unknown');
  const firm = await loadFirmForUpdate(context, opportunity.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  const recorded = await recordOpportunityValue(context, { ...input, source: 'person' });
  if (!recorded.ok) return refuse(recorded.reason === 'opportunity_unknown' ? 'opportunity_unknown' : 'invalid_input');
  return accept({ opportunityId: opportunity.id });
}
