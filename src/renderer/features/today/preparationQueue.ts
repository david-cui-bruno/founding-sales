import { localAccountPreparationStepSchema, type LocalAccountPreparation, type LocalAccountPreparationStep } from '../../../shared/contracts/localWorkspaceContract';

/** Every control opens the existing company view. None runs research, opens a draft, imports, approves or sends. */
export const preparationControlLabel: Readonly<Record<LocalAccountPreparationStep, string>> = Object.freeze({
  reopen_draft: 'Reopen draft', draft: 'Open draft', add_route: 'Open route review', research: 'Open research', unknown: 'Open company',
});
type Rankable = { account: { id: string; name: string }; preparation?: LocalAccountPreparation };
const unassessed = localAccountPreparationStepSchema.options.length;
const rank = (item: Rankable) => item.preparation ? localAccountPreparationStepSchema.options.indexOf(item.preparation.nextStep) : unassessed;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Most ready first in contract enum order, then name, then id. Rows without a summary keep their order at the end. */
export function rankPreparationQueue<T extends Rankable>(snapshots: readonly T[]): T[] {
  return [...snapshots].sort((a, b) => {
    const order = rank(a) - rank(b);
    if (order !== 0 || !a.preparation || !b.preparation) return order;
    return compare(a.account.name, b.account.name) || compare(a.account.id, b.account.id);
  });
}
/** Presentation of a saved summary only. Absent summary means nothing is claimed. */
export function preparationSummary(preparation: LocalAccountPreparation | undefined): { reason: string | null; label: string | null } {
  if (!preparation) return { reason: null, label: null };
  return { reason: preparation.reason, label: preparationControlLabel[preparation.nextStep] };
}
