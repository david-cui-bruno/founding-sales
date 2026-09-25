import { IMPORT_ISSUE_CODES } from '@fss/contracts';
import type { CrmScreen, CrmState, MergeView } from './firmWorkspaceContract.ts';

/**
 * What the CRM windows show, as a pure function of the state the main process sent.
 *
 * The same split G2 made for the Today window, for the same reason: every rule in
 * specification 14.2 — "when offline or below the minimum client version,
 * cloud-dependent controls show a clear non-actionable state" — becomes a unit test
 * rather than a screenshot.
 *
 * No sentence in this file is composed from data. A refusal arrives as a stable code
 * and is mapped to one fixed English sentence, so the words a person reads are
 * versioned with the release and one code never says two different things.
 */

export interface BannerView {
  readonly tone: 'info' | 'warning' | 'blocking';
  readonly text: string;
}

export interface FirmWorkspaceView {
  readonly screen: CrmScreen;
  readonly heading: string;
  readonly banners: readonly BannerView[];
  /** Whether anything that would mutate cloud state may be offered at all. */
  readonly actionsEnabled: boolean;
  /** Whether this caller was given the firm in detail (Appendix F row 2). */
  readonly showsDetail: boolean;
  /** Why the rest of the page is missing, when it is. Null when nothing is missing. */
  readonly redactionNotice: string | null;
}

export const FIRM_HEADING = 'Firm';
export const PIPELINE_HEADING = 'Pipeline';
export const MERGE_HEADING = 'Resolve this merge';
export const ADD_FIRM_HEADING = 'Add firm';
export const IMPORT_HEADING = 'Import firms';

/**
 * Every code the CRM windows can be handed, and the one sentence each one says.
 *
 * The CRM refusal codes are `@fss/contracts`' `CRM_REFUSAL_CODES`; the rest are the
 * client's own states. A code with no entry here is shown as the generic sentence
 * rather than as the code, because a reason code on screen is a bug report for a
 * person who cannot file one.
 */
export const CRM_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  offline: 'Callie cannot reach the server. Nothing here can be changed until it can.',
  client_upgrade_required: 'This version of Callie is out of date. Install the current build to continue.',
  not_assigned: 'This firm is assigned to somebody else, so it cannot be changed here.',
  admin_only: 'Only an administrator can do that.',
  firm_merged: 'This record was merged into another firm. Open that one instead.',
  firm_unknown: 'That firm is no longer here.',
  contact_unknown: 'That contact is no longer here.',
  lost_reason_required: 'A lost opportunity needs a reason.',
  stage_unknown: 'That stage is not part of this pipeline.',
  stage_retired: 'That stage has been retired and cannot be moved into.',
  opportunity_closed: 'This opportunity is closed. Reopen it before changing its stage.',
  merge_conflicts: 'These two records disagree. Choose which value to keep for each.',
  merge_cross_firm: 'Those two people are at different firms. Merge the firms first.',
  merge_same_record: 'That is the same record twice.',
  merge_already_performed: 'That merge has already happened.',
  saved: 'Saved.',
  merged: 'Merged.',
  stage_changed: 'Stage changed.',
  // Lane g84: Add firm and Import. A refused form marks its fields; the line says so.
  firm_added: 'Firm added.',
  imported: 'Imported.',
  imported_with_refusals: 'Imported, except the rows listed below.',
  import_nothing_to_commit: 'Nothing in this file is new. Fix the rows marked, or choose another file.',
  import_file_too_large: 'That file is larger than 512 KB. Split it and import each part.',
  duplicate_in_workspace: 'That firm is already here. Open it, or change the website or the name.',
  malformed_body: 'Callie could not send that. Check the fields and try again.',
  // Lane g88: confirming a number, putting a firm in the pipeline, enrolling a contact.
  route_confirmed: 'Number confirmed. It can be called now.',
  route_version_stale: 'That number changed since this page was drawn. Look again before confirming it.',
  route_invalid: 'That number failed validation, so it cannot be confirmed by hand. Add the right number instead.',
  route_retired: 'That number was retired.',
  route_unknown: 'That number is no longer here.',
  opportunity_opened: 'In the pipeline, at the first stage.',
  opportunity_open_exists: 'This firm is already in the pipeline.',
  enrolled: 'Enrolled. The first step is on its way to Today.',
  opportunity_not_open: 'This firm has no open opportunity. Add it to the pipeline first.',
  contact_already_enrolled: 'That person is already in a sequence.',
  firm_zone_unknown: 'Callie does not know this firm’s time zone yet, so it cannot schedule the steps.',
  version_not_published: 'That sequence version is not published.',
  version_retired: 'That sequence version was retired.',
  version_has_no_steps: 'That sequence has no steps.',
});

/** The line above a refused Add firm form: its fields say what is wrong with each. */
export const CHECK_FIELDS = 'Check the fields marked below.';

export const GENERIC_NOTICE = 'That could not be done. Try again, or ask an administrator.';

export function noticeText(code: string): string {
  const known = CRM_NOTICES[code];
  if (known !== undefined) return known;
  // A field's code (lane g84): the sentence is under the field, and the line points there.
  if ((IMPORT_ISSUE_CODES as readonly string[]).includes(code)) return CHECK_FIELDS;
  return GENERIC_NOTICE;
}

const INFO_NOTICES: ReadonlySet<string> = new Set([
  'saved',
  'merged',
  'stage_changed',
  'firm_added',
  'imported',
  'route_confirmed',
  'opportunity_opened',
  'enrolled',
]);

/** The tone a notice is shown in. A refusal warns; an outcome informs. */
function toneOf(code: string): BannerView['tone'] {
  if (code === 'client_upgrade_required') return 'blocking';
  if (INFO_NOTICES.has(code)) return 'info';
  return 'warning';
}

const HEADINGS: Readonly<Record<CrmScreen, string>> = Object.freeze({
  firm: FIRM_HEADING,
  pipeline: PIPELINE_HEADING,
  merge: MERGE_HEADING,
  add_firm: ADD_FIRM_HEADING,
  import: IMPORT_HEADING,
});

export function buildFirmWorkspaceView(state: CrmState): FirmWorkspaceView {
  const banners: BannerView[] = [];
  if (!state.online) banners.push({ tone: 'warning', text: noticeText('offline') });
  if (state.notice !== null) banners.push({ tone: toneOf(state.notice), text: noticeText(state.notice) });

  const showsDetail = state.firm !== null && state.firm.visibility === 'assigned_or_admin';
  const redactionNotice =
    state.firm !== null && !showsDetail
      ? 'This firm is assigned to somebody else. You can see who it is and where it stands, and nothing else.'
      : null;

  return {
    screen: state.screen,
    heading: HEADINGS[state.screen],
    banners,
    // Offline is the only thing that disables every control at once. Not being the
    // assignee removes the controls entirely, because the data they would edit was
    // never sent.
    actionsEnabled: state.mayMutate && state.online,
    showsDetail,
    redactionNotice,
  };
}

/**
 * Whether a stage change may be submitted.
 *
 * Section 8.1: "Lost changes require a reason; an LLM may suggest but never commit
 * it." The server refuses `lost_reason_required` and is the authority; this is the
 * client not sending a command it can already see is incomplete, which is a
 * courtesy rather than a rule — and the test for it asserts both halves.
 */
export function stageChangeSubmittable(input: {
  readonly toStageKey: string;
  readonly terminalKindOf: (stageKey: string) => 'won' | 'lost' | null;
  readonly reason: string;
  readonly actionsEnabled: boolean;
}): boolean {
  if (!input.actionsEnabled || input.toStageKey.length === 0) return false;
  if (input.terminalKindOf(input.toStageKey) !== 'lost') return true;
  return input.reason.trim().length > 0;
}

/** A merge may be submitted once every conflict the API listed has been decided. */
export function mergeSubmittable(
  merge: MergeView,
  chosen: Readonly<Record<string, string>>,
  actionsEnabled: boolean,
): boolean {
  if (!actionsEnabled) return false;
  return merge.conflicts.every(conflict => {
    const value = chosen[conflict.field];
    // Only the values the API offered. A merge resolution is a choice between two
    // recorded values, never a third one typed into the conflict screen — "picking
    // one silently is how a merge loses a canonical value nobody meant to lose",
    // and inventing one here would be worse.
    const offered = [conflict.source, conflict.target].filter((side): side is string => side !== null);
    return value !== undefined && offered.includes(value);
  });
}
