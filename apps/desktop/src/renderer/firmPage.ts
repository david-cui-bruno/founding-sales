import type { ContactDto, FirmDetailDto, FirmPageResponse, RouteDto } from '@fss/contracts';
import { renderContactsEditor } from './contactsEditor.ts';
import { button, describe, element, orDash } from './firmDom.ts';
import type { ConfirmRouteRequest, ContactEdit, EnrollRequest, FirmSequencesView } from './firmWorkspaceContract.ts';

/**
 * The Firm page (specification 7.2, 7.3, 8.1, 15, Appendix F).
 *
 * Identity, routes with their eligibility, contacts, the opportunity and its stage
 * history, and the holds — in that order, because that is the order a person asks
 * the questions in: who is this, how do I reach them, who do I talk to, where are
 * we, and why can I not do anything.
 *
 * **The redaction is the API's and the page does not repeat it.** A page that
 * arrived as `any_active_member` has no contacts, no routes and no history in it —
 * not empty ones, none — so there is nothing for this file to hide. What it does
 * instead is say so, once, in a sentence: an interface that silently omits four
 * sections teaches a person that the firm has no contacts.
 *
 * **A route shows its eligibility and its version.** Section 9.1 makes the version
 * the number `authorizeDial` compares against, "preventing a stale client from
 * dialing a replaced or retired number", so the number a person is looking at is
 * the number the dial authorization will be about. A route that is not `usable` is
 * shown and marked, never hidden: "this firm has no phone number" and "this firm's
 * phone number is not confirmed yet" are different facts.
 */

export interface FirmPageOptions {
  readonly page: FirmPageResponse;
  readonly actionsEnabled: boolean;
  readonly redactionNotice: string | null;
  readonly onSaveContact: (edit: ContactEdit) => void;
  /** Lane g88: the Sequences section, and its three actions. Absent draws neither. */
  readonly sequences?: FirmSequencesView | null;
  readonly onConfirmRoute?: (request: ConfirmRouteRequest) => void;
  readonly onOpenOpportunity?: () => void;
  readonly onEnroll?: (request: EnrollRequest) => void;
}

/**
 * Why a number can be confirmed here and an address cannot (lane g88). Said once under
 * each section that has an unconfirmed route, so the button's absence on an address is
 * explained rather than puzzling.
 */
export const CONFIRM_NUMBER_HINT =
  'A number becomes callable once you confirm it reaches this firm. Callie records that you confirmed it, and when.';
export const EMAIL_UNCONFIRMED_HINT =
  'An address that is not usable yet needs a validation Callie cannot do by hand, so there is no confirm button for it.';

function renderIdentity(root: HTMLElement, page: FirmPageResponse, detail: FirmDetailDto | null): void {
  const firm = page.read.firm;
  const panel = element('section', { className: 'firm-identity', testId: 'firm-identity' });
  panel.append(element('h2', { text: firm.name }));
  const list = element('dl');
  describe(list, 'Website', orDash(firm.website));
  describe(list, 'Where', orDash([firm.locality, firm.regionCode].filter(part => part !== null).join(', ')));
  describe(list, 'Stage', orDash(firm.stageKey));
  describe(list, 'Control', orDash(firm.controlMode));
  // 9.2: a firm with no established zone says which rule could not place it, because
  // "no time zone" and "we never looked" are different problems.
  describe(list, 'Time zone', orDash(firm.timeZone ?? firm.timeZoneUnresolvedReason));
  describe(list, 'Assigned to', orDash(firm.assignedUserId));
  if (detail !== null) {
    describe(list, 'Address', orDash(detail.addressLine));
    describe(list, 'Postal code', orDash(detail.postalCode));
  }
  panel.append(list);
  root.append(panel);
}

function renderRoutes(
  root: HTMLElement,
  kind: 'Phone' | 'Email',
  routes: readonly RouteDto[],
  confirm: { readonly enabled: boolean; readonly onConfirm: (request: ConfirmRouteRequest) => void } | null,
): void {
  const panel = element('section', { className: 'firm-routes', testId: `firm-routes-${kind.toLowerCase()}` });
  panel.append(element('h2', { text: `${kind} routes` }));
  if (routes.length === 0) {
    panel.append(element('p', { text: `No ${kind.toLowerCase()} route is recorded.` }));
    root.append(panel);
    return;
  }
  const list = element('ul');
  for (const route of routes) {
    const item = element('li', { testId: 'firm-route' });
    item.append(element('span', { className: 'route-value', testId: 'route-value', text: route.value }));
    item.append(
      element('span', { className: `route-eligibility route-${route.eligibility}`, testId: 'route-eligibility', text: route.eligibility }),
    );
    item.append(element('span', { className: 'route-version', testId: 'route-version', text: `v${String(route.version)}` }));
    // Lane g88: a candidate number can be confirmed by the person who knows it reaches
    // the firm. The version on screen travels with the command, so a number that changed
    // since this page was drawn is refused rather than confirmed.
    if (confirm !== null && route.eligibility === 'candidate') {
      const action = button('Confirm this number', 'route-confirm', confirm.enabled);
      action.addEventListener('click', () => {
        confirm.onConfirm({ routeId: route.id, routeVersion: route.version });
      });
      item.append(action);
    }
    list.append(item);
  }
  panel.append(list);
  if (routes.some(route => route.eligibility === 'candidate')) {
    panel.append(
      element('p', {
        className: 'hint',
        testId: `routes-hint-${kind.toLowerCase()}`,
        text: confirm !== null ? CONFIRM_NUMBER_HINT : EMAIL_UNCONFIRMED_HINT,
      }),
    );
  }
  root.append(panel);
}

const ENROLLMENT_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  active: 'running',
  review_required: 'waiting for your review',
  completed: 'finished',
  stopped: 'stopped',
});

/**
 * The Firm page's Sequences section (lane g88, audit G03): what is running here, and how
 * to start a contact on a published sequence. A firm with no open opportunity is offered
 * "Add to pipeline" first, because an enrolment serves an opportunity (11.2); a closed
 * one says so and offers nothing, because a Won or Lost firm is not enrolled again from
 * here.
 */
function renderSequences(
  root: HTMLElement,
  page: Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>,
  contacts: readonly ContactDto[],
  options: FirmPageOptions,
): void {
  const view = options.sequences;
  if (view === undefined || view === null) return;
  const panel = element('section', { className: 'firm-sequences', testId: 'firm-sequences' });
  panel.append(element('h2', { text: 'Sequences' }));
  if (view.readError !== null) {
    panel.append(
      element('p', { className: 'inert', testId: 'firm-sequences-unread', text: `Callie could not read the sequences (${view.readError}).` }),
    );
    root.append(panel);
    return;
  }

  const names = new Map(contacts.map(contact => [contact.id, contact.fullName] as const));
  if (view.enrollments.length > 0) {
    const list = element('ul', { className: 'rows', testId: 'firm-enrollments' });
    for (const enrollment of view.enrollments) {
      const item = element('li', { testId: 'firm-enrollment' });
      const row = element('div', { className: 'row' });
      const main = element('div', { className: 'row-main' });
      main.append(element('span', { className: 'name', text: `${names.get(enrollment.contactId) ?? 'A contact'} — ${enrollment.label}` }));
      main.append(
        element('span', {
          className: 'why',
          text: `${ENROLLMENT_STATE_LABELS[enrollment.state] ?? enrollment.state}, since ${enrollment.startedAt.slice(0, 10)}`,
        }),
      );
      row.append(main);
      item.append(row);
      list.append(item);
    }
    panel.append(list);
  }

  const opportunity = page.opportunity;
  if (opportunity === null || opportunity.status !== 'open') {
    if (opportunity !== null) {
      panel.append(
        element('p', { className: 'inert', testId: 'enroll-closed', text: 'This firm’s opportunity is closed, so nobody here is enrolled from this page.' }),
      );
      root.append(panel);
      return;
    }
    panel.append(
      element('p', { className: 'hint', testId: 'enroll-needs-pipeline', text: 'Put the firm in the pipeline before enrolling anybody here.' }),
    );
    const open = button('Add to pipeline', 'open-opportunity', options.actionsEnabled && options.onOpenOpportunity !== undefined);
    open.addEventListener('click', () => {
      options.onOpenOpportunity?.();
    });
    panel.append(open);
    root.append(panel);
    return;
  }

  const active = contacts.filter(contact => contact.status === 'active');
  if (view.published.length === 0 || active.length === 0) {
    panel.append(
      element('p', {
        className: 'hint',
        testId: 'enroll-unavailable',
        text: view.published.length === 0 ? 'No sequence is published yet. Publish one in Sequences.' : 'Add a contact before enrolling anybody here.',
      }),
    );
    root.append(panel);
    return;
  }

  const form = element('form', { className: 'toolbar', testId: 'enroll-form' });
  const contact = element('select', { testId: 'enroll-contact' });
  for (const entry of active) {
    const option = element('option', { text: entry.fullName });
    option.value = entry.id;
    contact.append(option);
  }
  const sequence = element('select', { testId: 'enroll-sequence' });
  for (const entry of view.published) {
    const option = element('option', { text: entry.label });
    option.value = entry.sequenceVersionId;
    sequence.append(option);
  }
  contact.disabled = sequence.disabled = !options.actionsEnabled;
  const enroll = button('Enrol', 'enroll-submit', options.actionsEnabled && options.onEnroll !== undefined);
  enroll.type = 'submit';
  form.addEventListener('submit', event => {
    event.preventDefault();
    options.onEnroll?.({ sequenceVersionId: sequence.value, contactId: contact.value });
  });
  form.append(contact, sequence, enroll);
  panel.append(form);
  root.append(panel);
}

function renderOpportunity(root: HTMLElement, page: Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>): void {
  const panel = element('section', { className: 'firm-opportunity', testId: 'firm-opportunity' });
  panel.append(element('h2', { text: 'Opportunity' }));
  if (page.opportunity === null) {
    panel.append(element('p', { testId: 'opportunity-none', text: 'There is no opportunity at this firm yet.' }));
    root.append(panel);
    return;
  }
  const list = element('dl');
  describe(list, 'Status', page.opportunity.status);
  describe(list, 'Stage', page.opportunity.stageKey);
  describe(list, 'Control', page.opportunity.controlMode);
  describe(list, 'Opened', page.opportunity.openedAt);
  if (page.opportunity.closeReason !== null) describe(list, 'Closed because', page.opportunity.closeReason);
  panel.append(list);

  const history = element('ol', { testId: 'stage-history' });
  for (const event of page.stageHistory) {
    const item = element('li', { testId: 'stage-event' });
    item.append(
      element('span', { testId: 'stage-event-move', text: `${event.fromStageKey ?? 'opened'} → ${event.toStageKey}` }),
    );
    item.append(element('span', { testId: 'stage-event-at', text: event.occurredAt }));
    if (event.reason !== null) item.append(element('span', { testId: 'stage-event-reason', text: event.reason }));
    history.append(item);
  }
  panel.append(history);
  root.append(panel);
}

function renderHolds(root: HTMLElement, page: Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>): void {
  const panel = element('section', { className: 'firm-holds', testId: 'firm-holds' });
  panel.append(element('h2', { text: 'Holds' }));
  if (page.holds.length === 0) {
    panel.append(element('p', { testId: 'holds-none', text: 'Nothing is holding this firm.' }));
    root.append(panel);
    return;
  }
  const list = element('ul');
  for (const hold of page.holds) {
    const item = element('li', { testId: 'firm-hold' });
    item.append(element('span', { testId: 'hold-reason', text: hold.reasonCode }));
    item.append(element('span', { testId: 'hold-blocks', text: hold.blockedActionKinds.join(', ') }));
    item.append(element('span', { testId: 'hold-since', text: hold.startedAt }));
    // Section 15: only an explicitly recoverable hold exposes a control, and this
    // lane offers none — it names the action so a person knows what would clear it.
    item.append(element('span', { testId: 'hold-recovery', text: orDash(hold.recoveryAction) }));
    list.append(item);
  }
  panel.append(list);
  root.append(panel);
}

export function renderFirmPage(root: HTMLElement, options: FirmPageOptions): void {
  const page = options.page;
  // Both discriminators, because they are two independent facts: the page's width
  // and the read's. They always agree — `readFirmPage` produces them together — and
  // the narrowing is what makes "the detail fields exist" a type rather than a hope.
  const detail = page.visibility === 'assigned_or_admin' && page.read.visibility === 'assigned_or_admin'
    ? page.read.firm
    : null;
  renderIdentity(root, page, detail);

  if (page.visibility !== 'assigned_or_admin' || detail === null) {
    root.append(
      element('p', {
        className: 'redaction',
        testId: 'firm-redacted',
        text: options.redactionNotice ?? '',
      }),
    );
    return;
  }

  const onConfirm = options.onConfirmRoute;
  renderRoutes(
    root,
    'Phone',
    detail.phoneRoutes,
    onConfirm === undefined ? null : { enabled: options.actionsEnabled, onConfirm },
  );
  renderRoutes(root, 'Email', detail.emailRoutes, null);
  renderContactsEditor(root, {
    contacts: detail.contacts,
    enabled: options.actionsEnabled,
    onSave: options.onSaveContact,
  });
  renderSequences(root, page, detail.contacts, options);
  renderOpportunity(root, page);
  renderHolds(root, page);
}
