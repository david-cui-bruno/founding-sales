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
  { topic: 'State postures', path: '/postures', ownedBy: 'G4 policy' },
  { topic: 'Calling window', path: '/postures/calling-window', ownedBy: 'G4 policy' },
  { topic: 'Pauses', path: '/pauses', ownedBy: 'G4 policy' },
  { topic: 'Suppressions', path: '/suppressions', ownedBy: 'G4 suppression' },
  { topic: 'Research limits and provider budgets', path: '/research/config', ownedBy: 'G10 research' },
  { topic: 'Route eligibility thresholds', path: '/research/policy', ownedBy: 'G10 research' },
  { topic: 'Mailbox connection', path: '/gmail/status', ownedBy: 'G7 Gmail' },
  { topic: 'Dead jobs', path: '/admin/jobs/dead', ownedBy: 'G5 jobs' },
  { topic: 'Alerts and acknowledgement', path: '/admin/alerts', ownedBy: 'G5 jobs' },
]);
