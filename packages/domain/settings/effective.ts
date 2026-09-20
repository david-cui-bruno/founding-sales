import {
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_SETTING_VALUES,
  HARD_MAILBOX_DAILY_CEILING,
  alertThresholdsSchema,
  holidayCalendarSettingSchema,
  sendingEnabledSettingSchema,
  sendingLimitsSettingSchema,
  type AlertThresholds,
  type SendingLimitsSetting,
} from '@fss/contracts';
import type { WorkspaceHolidayCalendar } from '../src/rules/businessDays.ts';

/**
 * What a stored setting *means*, as pure functions.
 *
 * Everything here answers a question some other lane will ask — "may I send", "what
 * is this mailbox's cap today", "is this date a working day" — and none of it touches
 * a database. The reads in `store.ts` return whatever is stored; these turn that into
 * the one number or boolean the caller may act on.
 *
 * Each one fails to the safe side when the stored value is unreadable. A settings row
 * that does not parse is a bug, and the response to a bug in the configuration that
 * governs outbound mail is to behave as though the configuration said "no".
 */

/**
 * Specification 16.2: "Production sending remains disabled until all mandatory
 * scenarios for the affected release class pass, the deployed commit/image digests
 * match the rehearsal artifacts, and an authenticated admin enables sending."
 *
 * Two switches, ANDed, and the AND is the whole point — see
 * `docs/decisions/g9-sending-enable-is-two-switches.md`. The deployment flag is the
 * release process's statement that the gate passed on these digests; the setting is
 * the admin's act. Neither alone is the sentence above, and either alone being
 * sufficient would be a way to send from an artifact nobody rehearsed.
 */
export function effectiveSendingEnabled(deploymentEnabled: boolean, storedSetting: unknown): boolean {
  if (!deploymentEnabled) return false;
  const parsed = sendingEnabledSettingSchema.safeParse(storedSetting);
  if (!parsed.success) return false;
  return parsed.data.enabled;
}

/**
 * The cap for one mailbox today: the lower of what 12.7's ramp allows and what an
 * admin configured, never higher than the hard ceiling.
 *
 * "Admins may lower caps. After sustained healthy results they may raise a mailbox to
 * 75, but version one has a hard automated ceiling of 100 per mailbox per business
 * day." So the admin's number is a second ceiling and never a floor: an admin cannot
 * configure their way past a ramp that has not advanced, which is what the ramp is
 * for.
 */
export function effectiveMailboxDailyCap(rampCap: number, storedSetting: unknown): number {
  const parsed = sendingLimitsSettingSchema.safeParse(storedSetting);
  const configured: SendingLimitsSetting['perMailboxDailyCap'] = parsed.success
    ? parsed.data.perMailboxDailyCap
    : null;
  const ramp = Number.isFinite(rampCap) ? Math.max(0, Math.trunc(rampCap)) : 0;
  const capped = Math.min(ramp, HARD_MAILBOX_DAILY_CEILING);
  return configured === null ? capped : Math.min(capped, configured);
}

/** 12.6's rolling primary-domain recipient guard, lowered if an admin lowered it. */
export function effectiveDomainRecipientGuard(storedSetting: unknown): number {
  const parsed = sendingLimitsSettingSchema.safeParse(storedSetting);
  const fallback = DEFAULT_SETTING_VALUES.sending_limits as SendingLimitsSetting;
  return parsed.success ? parsed.data.domainRecipientsPer24h : fallback.domainRecipientsPer24h;
}

/**
 * 11.2's "configured workspace holidays", in the shape `resolveDelay` wants.
 *
 * The version travels with the dates, so a stored due instant names the calendar that
 * produced it and "a later change to the holiday calendar can then be told apart from
 * a bug" stays true. The setting's own version number is that identity — there is no
 * second version field for an operator to forget to bump.
 */
export function holidayCalendarOf(storedSetting: unknown, settingVersion: number): WorkspaceHolidayCalendar {
  const parsed = holidayCalendarSettingSchema.safeParse(storedSetting);
  if (!parsed.success || parsed.data.dates.length === 0) {
    return { version: `workspace.${String(settingVersion)}`, dates: [] };
  }
  return { version: `workspace.${String(settingVersion)}`, dates: [...parsed.data.dates].sort() };
}

/** 13.3's thresholds, or the release defaults when the stored value is unreadable. */
export function alertThresholdsOf(storedSetting: unknown): AlertThresholds {
  const parsed = alertThresholdsSchema.safeParse(storedSetting);
  return parsed.success ? parsed.data : DEFAULT_ALERT_THRESHOLDS;
}
