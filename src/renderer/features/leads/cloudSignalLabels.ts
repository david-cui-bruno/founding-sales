import type { CloudScoreChip } from '../../../shared/contracts/leadsContract';

/**
 * Short labels for the scorer's stable signal ids (cloud/lambdas/scorer
 * FIT_WEIGHTS plus the timing trigger labels `<type>_recent` /
 * `<type>_window` and the seasonal types). The inspector renders these as a
 * list, never free prose; unknown ids fall back to a humanized id so a new
 * cloud signal can never break the UI.
 */
const CLOUD_SIGNAL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  portfolio_in_band: 'Portfolio in target band',
  live_vacancy: 'Live vacancy',
  recent_acquisition: 'Recently acquired',
  open_compliance_deadline: 'Open compliance deadline',
  self_managed_at_distance: 'Self-managed at a distance',
  pre_1940_stock: 'Pre-1940 housing stock',
  reachable_direct_contact: 'Direct contact on record',
  llc_owner_no_pm: 'LLC owner, no manager',
  prior_tool_adoption: 'Prior tool adoption',
  active_permit_recent: 'Recent active permit',
  frbo_listing_recent: 'Fresh FRBO listing',
  community_post_recent: 'Recent community post',
  violation_opened_recent: 'Violation opened recently',
  permit_filed_recent: 'Permit filed recently',
  deed_transfer_recent: 'Recent deed transfer',
  review_pain_recent: 'Recent review pain',
  registry_delta_recent: 'Registry change',
  lead_cert_window_window: 'Lead cert window open',
  heating_season: 'Heating season',
  student_turnover: 'Student turnover season',
  tax_season: 'Tax season',
  no_signals: 'No active signals',
});

export function cloudSignalLabel(signal: string): string {
  const known = CLOUD_SIGNAL_LABELS[signal];
  if (known !== undefined) return known;
  const humanized = signal.replace(/_/g, ' ');
  return humanized.length > 0
    ? humanized[0]!.toUpperCase() + humanized.slice(1)
    : signal;
}

/** The exact chip text: two separate axes, never one combined number. */
export function formatCloudChip(scores: CloudScoreChip): string {
  return `Fit ${scores.fit} · Timing ${scores.timing}`;
}
