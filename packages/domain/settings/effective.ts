import {
  DEFAULT_ALERT_THRESHOLDS,
  alertThresholdsSchema,
  sendingEnabledSettingSchema,
  type AlertThresholds,
} from '@fss/contracts';

/**
 * What a stored setting *means*, as pure functions.
 *
 * Each one answers a question some other lane will ask — "may I send", "what is the
 * canary threshold" — and none of it touches a database. The reads in `store.ts`
 * return whatever is stored; these turn that into the one number or boolean the
 * caller may act on.
 *
 * Each one fails to the safe side when the stored value is unreadable. A settings row
 * that does not parse is a bug, and the response to a bug in the configuration that
 * governs outbound mail is to behave as though the configuration said "no".
 *
 * There is deliberately nothing here about the per-mailbox cap or the domain
 * recipient guard. G7-2's `mailbox_send_ramp` and `sending_domains` hold both, with
 * the ramp computed from `healthy_sending_days` rather than stored and the ceilings
 * enforced by row-level CHECK. A function here that combined a ramp with a stored
 * cap would be a second implementation of 12.7 that could disagree with the
 * constraint. See `docs/decisions/g9-two-slices-that-belong-to-other-lanes.md`.
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
 *
 * This is a *pure rule* and takes the deployment flag as an argument rather than
 * reading configuration for itself, because the caller that matters is not in this
 * lane: **G12 (release gates) wires the send path's read of this attestation**, and
 * a third fact has to hold beside these two — G7-2's per-domain
 * `sending_domains.automated_sending_enabled`, which is the DNS authentication gate
 * and not this. See `docs/decisions/g9-two-slices-that-belong-to-other-lanes.md`.
 */
export function effectiveSendingEnabled(deploymentEnabled: boolean, storedSetting: unknown): boolean {
  if (!deploymentEnabled) return false;
  const parsed = sendingEnabledSettingSchema.safeParse(storedSetting);
  if (!parsed.success) return false;
  return parsed.data.enabled;
}

/** 13.3's thresholds, or the release defaults when the stored value is unreadable. */
export function alertThresholdsOf(storedSetting: unknown): AlertThresholds {
  const parsed = alertThresholdsSchema.safeParse(storedSetting);
  return parsed.success ? parsed.data : DEFAULT_ALERT_THRESHOLDS;
}
