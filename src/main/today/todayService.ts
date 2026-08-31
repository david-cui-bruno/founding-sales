import type { MutationReceipt } from '../../shared/contracts/commonContract';
import type {
  CompleteActionRequest,
  LogPastActivityRequest,
  PinActionRequest,
  SnoozeActionRequest,
  TodaySnapshot,
} from '../../shared/contracts/todayContract';

/**
 * The renderer-facing Today surface. `get` returns one whole strict snapshot
 * and every command returns a MutationReceipt. This seam is distinct from the
 * domain TodayService: all ordering, capacity, opt-out checks, action
 * replacement, and lane assignment stay behind the domain facade.
 */
export type TodayProvider = {
  get(): Promise<TodaySnapshot>;
  complete(input: CompleteActionRequest): Promise<MutationReceipt>;
  snooze(input: SnoozeActionRequest): Promise<MutationReceipt>;
  pin(input: PinActionRequest): Promise<MutationReceipt>;
  logPastActivity(input: LogPastActivityRequest): Promise<MutationReceipt>;
};

/** The domain facade methods the Today slice consumes. */
export type TodayDomainInvoker = {
  getToday(): TodaySnapshot | Promise<TodaySnapshot>;
  completePrimaryAction(input: CompleteActionRequest): MutationReceipt;
  snoozePrimaryAction(input: SnoozeActionRequest): MutationReceipt;
  pinWithinLane(input: PinActionRequest): MutationReceipt;
  logPastActivity(input: LogPastActivityRequest): MutationReceipt;
};

/**
 * Thin delegate from the Today IPC surface to the domain facade. No business
 * rules, SQL, or DTO mapping belong in this module.
 */
export function createTodayProvider(domain: TodayDomainInvoker): TodayProvider {
  return {
    get: async () => domain.getToday(),
    complete: async (input) => domain.completePrimaryAction(input),
    snooze: async (input) => domain.snoozePrimaryAction(input),
    pin: async (input) => domain.pinWithinLane(input),
    logPastActivity: async (input) => domain.logPastActivity(input),
  };
}
