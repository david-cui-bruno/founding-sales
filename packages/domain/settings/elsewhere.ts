/**
 * The configuration 10.1 lists that this lane does not store.
 *
 * Section 10.1 names one list: "versioned state postures, call windows, approved
 * template versions, the postal footer, sending limits, research limits,
 * route-eligibility thresholds, and pauses". Most of those already have a table, a
 * versioning rule and a command written by the lane that owns the behaviour they
 * govern, and copying them into `workspace_settings` would give the workspace two
 * answers to the same question.
 *
 * One of them is not anywhere, and that is deliberate: there is no postal footer to
 * administer. David decided on 22 September 2026 that an automated email carries no
 * postal address, so the slice was removed rather than moved
 * (`docs/decisions/g20-automated-email-carries-no-postal-address.md`). It is not in
 * the list below either, because the list is navigation and there is nowhere to go.
 *
 * So the settings surface is one page over several endpoints, and this is the list
 * the page renders. It is data rather than prose in a document because the Mac
 * builds its navigation from it, and because a slice that moves should break a test
 * rather than leave a dead link.
 *
 * `path` is the endpoint. `ownedBy` is the lane, so the next person reading a stale
 * entry knows whose file to look in.
 */

export interface SettingsElsewhere {
  readonly topic: string;
  readonly path: string;
  readonly ownedBy: string;
}

export const SETTINGS_ELSEWHERE: readonly SettingsElsewhere[] = Object.freeze([
  { topic: 'Memberships and roles', path: '/admin/memberships', ownedBy: 'G2 identity' },
  { topic: 'Devices', path: '/admin/devices', ownedBy: 'G2 identity' },
  { topic: 'Pipeline stages', path: '/pipeline/stages', ownedBy: 'G9 (this lane), over G3a tables' },
  // G8's `workspace_holiday_calendars`, versioned because every stored due instant
  // freezes the calendar version it was computed from. The settings page shows the
  // current calendar — read through G8's `currentHolidayCalendar` and carried in the
  // settings snapshot — and edits it with G8's own command. No calendar data lives
  // in `workspace_settings`; see
  // docs/decisions/g9-two-slices-that-belong-to-other-lanes.md.
  { topic: 'Workspace holidays', path: '/sequences/holidays', ownedBy: 'G8 sequences' },
  // G7-2's, and its paths are known: `setAdminCap` on `mailbox_send_ramp`, and the
  // authentication checklist and per-domain enable on `sending_domains`. Both are
  // admin-only with a redacted 403, so the settings page gates the section on role
  // rather than letting a salesperson press a control that answers 403.
  { topic: 'Sending caps and the ramp', path: '/outbound/cap', ownedBy: 'G7-2 sending' },
  { topic: 'Domain authentication and sending enable', path: '/outbound/authentication', ownedBy: 'G7-2 sending' },
  { topic: 'State postures', path: '/postures', ownedBy: 'G4 policy' },
  { topic: 'Calling window', path: '/postures/calling-window', ownedBy: 'G4 policy' },
  { topic: 'Pauses', path: '/pauses', ownedBy: 'G4 policy' },
  { topic: 'Suppressions', path: '/suppressions', ownedBy: 'G4 suppression' },
  { topic: 'Mailbox connection', path: '/gmail/status', ownedBy: 'G7 Gmail' },
  { topic: 'Dead jobs', path: '/admin/jobs/dead', ownedBy: 'G5 jobs' },
  { topic: 'Alerts and acknowledgement', path: '/admin/alerts', ownedBy: 'G5 jobs' },
]);
