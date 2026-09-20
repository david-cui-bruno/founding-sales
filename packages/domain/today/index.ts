/**
 * The Today list (specification 8.2 and 8.3).
 *
 * One card per firm per workspace business date, four lanes in precedence, the card
 * derived from its contact tasks by the database rather than maintained by a writer.
 * See `docs/greenfield/today.md`.
 */

export {
  TODAY_ALGORITHM_VERSION,
  TODAY_ITEM_KINDS,
  TODAY_ITEM_STATUSES,
  TODAY_LANES,
  TODAY_REFUSAL_CODES,
  TODAY_SOURCE_KINDS,
  acceptToday,
  refuseToday,
  type TodayCardRow,
  type TodayCounts,
  type TodayItemKind,
  type TodayItemRow,
  type TodayItemStatus,
  type TodayLane,
  type TodayRefusalCode,
  type TodayResult,
  type TodaySnoozeRow,
  type TodaySourceKind,
} from './types.ts';

export {
  LANE_PRECEDENCE,
  aggregateCard,
  compareTodayCards,
  compareTodayItems,
  laneOfItemKind,
  type AggregatedCard,
  type TodayCardOrder,
  type TodayItemOrder,
} from './lanes.ts';

export {
  businessDateOf,
  cancelUnproducedItems,
  completeTodayItem,
  listTodayCards,
  listTodayItems,
  readTodayItem,
  upsertTodayItem,
  workspaceBusinessTimeZone,
  type ListTodayCardsInput,
  type ListTodayItemsInput,
  type UpsertTodayItemInput,
} from './snapshots.ts';

export {
  buildTodaySnapshot,
  callbackSource,
  defaultTodaySources,
  newFirmSource,
  type BuildTodaySnapshotInput,
  type TodayBuildReport,
  type TodayContribution,
  type TodaySource,
  type TodaySourceInput,
} from './build.ts';

export { promoteReply, promoteTodayItem, type PromoteReplyInput, type PromoteTodayItemInput } from './promotions.ts';

export {
  SNOOZE_REASON_MAX,
  cancelTodaySnooze,
  listActiveSnoozes,
  snoozeTodayItem,
  type SnoozeOutcome,
  type SnoozeTodayItemInput,
} from './snooze.ts';

export {
  readTodayFirm,
  readTodayList,
  type ReadTodayInput,
  type TodayCardDto,
  type TodayFirmDto,
  type TodayListDto,
  type TodayTaskDto,
} from './dto.ts';
