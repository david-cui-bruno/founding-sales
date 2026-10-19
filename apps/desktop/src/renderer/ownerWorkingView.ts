import type { PipelineView } from './firmWorkspaceContract.ts';
import type { TodayState } from './todayContract.ts';
import type { ReplyState } from './replyContract.ts';

/** Presentation only. Never archives, suppresses or changes a stored firm. */
export const INTERNAL_TEST_FIRM_NAME = 'Callie Internal Test';
export function isOwnerWorkingFirm(name: string | null | undefined): boolean {
  return name !== INTERNAL_TEST_FIRM_NAME;
}

export function ownerToday(state: TodayState): TodayState {
  const expanded = state.expanded !== null && !isOwnerWorkingFirm(state.expanded.firmName) ? null : state.expanded;
  return {
    ...state,
    cards: state.cards.filter(card => isOwnerWorkingFirm(card.firmName)),
    expanded,
    dialAdvice: expanded === null ? [] : state.dialAdvice,
  };
}

export function ownerReplies(state: ReplyState): ReplyState {
  return {
    ...state,
    cards: state.cards.filter(card => isOwnerWorkingFirm(card.firmName)),
    open: state.open !== null && !isOwnerWorkingFirm(state.open.firmName) ? null : state.open,
  };
}

/** Lists only. Direct firm/history reads remain reachable and unchanged. */
export function ownerPipeline(pipeline: PipelineView): PipelineView {
  const hidden = new Set([...pipeline.columns.flatMap(column => column.firms), ...(pipeline.unplacedFirms ?? [])].filter(firm => !isOwnerWorkingFirm(firm.name)).map(firm => firm.id));
  const plural = pipeline.plural;
  const cards = plural === undefined ? undefined : Object.fromEntries(Object.entries(plural.cards).filter(([, card]) => isOwnerWorkingFirm(card.firm.name)));
  return {
    ...pipeline,
    opportunityIdByFirmId: Object.fromEntries(Object.entries(pipeline.opportunityIdByFirmId).filter(([id]) => !hidden.has(id))),
    ...(pipeline.cards === undefined ? {} : { cards: Object.fromEntries(Object.entries(pipeline.cards).filter(([id]) => !hidden.has(id))) }),
    columns: pipeline.columns.map(column => ({ ...column, firms: column.firms.filter(firm => isOwnerWorkingFirm(firm.name)) })),
    ...(pipeline.unplacedFirms === undefined ? {} : { unplacedFirms: pipeline.unplacedFirms.filter(firm => isOwnerWorkingFirm(firm.name)) }),
    ...(plural === undefined || cards === undefined ? {} : { plural: {
      ...plural,
      cards,
      columns: plural.columns.map(column => ({ ...column, opportunityIds: column.opportunityIds.filter(id => cards[id] !== undefined) })),
      unplacedFirms: plural.unplacedFirms.filter(firm => isOwnerWorkingFirm(firm.name)),
    } }),
  };
}
