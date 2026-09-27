import type { ContactDto, FirmPageResponse, RouteDto } from '@fss/contracts';
import { useState, type JSX } from 'react';
import { inWords, shortDay, shortDayTime } from '../dates.ts';
import type { CheckRouteRequest, ContactEdit, EnrollRequest, FirmSequencesView } from '../firmWorkspaceContract.ts';
import { EMAIL_VALIDATION_TEXT, emailValidationStateOf } from '../firmWorkspaceView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowActions, RowMain, Rows, Section, Tag } from '../ui/layout.tsx';
import { Select } from '../ui/select.tsx';

/**
 * The Firm page (specification 7.2, 7.3, 8.1, 15, Appendix F).
 *
 * Identity, how to reach them, who to talk to, what is running, where the deal stands
 * and what is holding it — in that order, because that is the order a person asks the
 * questions in.
 *
 * **The redaction is the API's and the page does not repeat it.** A page that arrived as
 * `any_active_member` has no contacts, no routes and no history in it — not empty ones,
 * none — so there is nothing for this file to hide. What it does instead is say so, once:
 * an interface that silently omits four sections teaches a person that the firm has no
 * contacts.
 *
 * **A phone number is callable.** Until 1.0.13 an unverified number carried "Confirm this
 * number" and a paragraph explaining what confirming meant. A phone is usable on entry
 * since wave 2 (S4.4) and a dial accepts one an older release stored as a candidate, so
 * the prompt is gone and the row says what is true: Callie can call it.
 *
 * **An address says where its check stands**, because that one really is pending — the
 * worker checks every new address's domain — and "Check again" queues another.
 */

function Identity({ page }: { readonly page: FirmPageResponse }): JSX.Element {
  const firm = page.read.firm;
  const detail = page.visibility === 'assigned_or_admin' && page.read.visibility === 'assigned_or_admin' ? page.read.firm : null;
  const where = [firm.locality, firm.regionCode].filter(part => part !== null).join(', ');
  const rows: readonly (readonly [string, string])[] = [
    ['Website', firm.website ?? '—'],
    ['Where', where === '' ? '—' : where],
    ['Stage', firm.stageKey === null ? '—' : inWords(firm.stageKey)],
    // 9.2: a firm with no established zone says which rule could not place it, because
    // "no time zone" and "we never looked" are different problems.
    ['Time zone', firm.timeZone ?? (firm.timeZoneUnresolvedReason === null ? '—' : inWords(firm.timeZoneUnresolvedReason))],
    ...(detail === null
      ? []
      : ([
          ['Address', detail.addressLine ?? '—'],
          ['Postal code', detail.postalCode ?? '—'],
        ] as const)),
  ];
  return (
    <section data-testid="firm-identity" className="mt-5">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-xs text-muted-foreground">{term}</dt>
            <dd className="truncate">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** What a phone number's eligibility means to a person who wants to ring it. */
function phoneTag(route: RouteDto): { readonly text: string; readonly tone: 'ok' | 'warn' | 'none' } {
  if (route.eligibility === 'retired') return { text: 'Retired', tone: 'none' };
  if (route.eligibility === 'invalid') return { text: 'Not a number Callie can dial', tone: 'warn' };
  return { text: 'Callable', tone: 'ok' };
}

function PhoneRoutes({ routes }: { readonly routes: readonly RouteDto[] }): JSX.Element {
  return (
    <Section data-testid="firm-routes-phone" title="Phone" count={routes.length}>
      {routes.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No phone number is recorded.</p>
      ) : (
        <Rows>
          {routes.map(route => {
            const tag = phoneTag(route);
            return (
              <Row key={route.id} data-testid="firm-route">
                <RowMain line={<span data-testid="route-value">{route.value}</span>} />
                <span data-testid="route-eligibility" className="sr-only">
                  {route.eligibility}
                </span>
                <span data-testid="route-version" className="sr-only">{`v${String(route.version)}`}</span>
                <Tag tone={tag.tone}>{tag.text}</Tag>
              </Row>
            );
          })}
        </Rows>
      )}
    </Section>
  );
}

function EmailRoutes({
  routes,
  actionsEnabled,
  onCheckRoute,
}: {
  readonly routes: readonly RouteDto[];
  readonly actionsEnabled: boolean;
  onCheckRoute(request: CheckRouteRequest): void;
}): JSX.Element {
  return (
    <Section data-testid="firm-routes-email" title="Email" count={routes.length}>
      {routes.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No email address is recorded.</p>
      ) : (
        <Rows>
          {routes.map(route => {
            const state = emailValidationStateOf(route);
            return (
              <Row key={route.id} data-testid="firm-route">
                <RowMain
                  line={<span data-testid="route-value">{route.value}</span>}
                  detail={state === null ? null : <span data-testid="route-validation">{EMAIL_VALIDATION_TEXT[state]}</span>}
                />
                <span data-testid="route-eligibility" className="sr-only">
                  {route.eligibility}
                </span>
                <span data-testid="route-version" className="sr-only">{`v${String(route.version)}`}</span>
                {state === 'checking' ? (
                  <RowActions>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="route-check"
                      disabled={!actionsEnabled}
                      onClick={() => {
                        onCheckRoute({ routeId: route.id, routeVersion: route.version });
                      }}
                    >
                      Check again
                    </Button>
                  </RowActions>
                ) : null}
              </Row>
            );
          })}
        </Rows>
      )}
    </Section>
  );
}

/**
 * Editing the people at a firm (specification 7.2).
 *
 * "one active primary contact per firm is permitted but not required."
 *
 * Promotion is a checkbox rather than a radio group, and the reason is worth recording:
 * `updateContact` demotes the current primary inside the same transaction that promotes
 * the new one, so the client asks for "make this one primary" and the server does both
 * halves. A radio group would be the client modelling a constraint it does not own.
 *
 * Demoting without promoting anybody is deliberately not offered: zero primary contacts
 * is legal, but "nobody is the main contact here any more" is a decision, and an unticked
 * box is not one.
 */
function ContactRow({
  contact,
  enabled,
  onSave,
}: {
  readonly contact: ContactDto;
  readonly enabled: boolean;
  onSave(edit: ContactEdit): void;
}): JSX.Element {
  const [fullName, setFullName] = useState(contact.fullName);
  const [title, setTitle] = useState(contact.title ?? '');
  const [primary, setPrimary] = useState(contact.isPrimary);
  const changed = fullName !== contact.fullName || title !== (contact.title ?? '') || (primary && !contact.isPrimary);
  return (
    <Row data-testid="contact-row" data-contact-id={contact.id}>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Input
          data-testid="contact-name"
          aria-label="Name"
          autoComplete="off"
          disabled={!enabled}
          value={fullName}
          onChange={event => {
            setFullName(event.target.value);
          }}
          className="h-7 flex-1 border-transparent bg-transparent px-1 hover:border-input focus:border-input"
        />
        <Input
          data-testid="contact-title"
          aria-label="Title"
          autoComplete="off"
          disabled={!enabled}
          value={title}
          onChange={event => {
            setTitle(event.target.value);
          }}
          className="h-7 flex-1 border-transparent bg-transparent px-1 text-muted-foreground hover:border-input focus:border-input"
        />
      </span>
      <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <input
          type="checkbox"
          data-testid="contact-primary"
          checked={primary}
          // Already the primary: the box records that and there is nothing to ask for.
          disabled={!enabled || contact.isPrimary}
          onChange={event => {
            setPrimary(event.target.checked);
          }}
        />
        Main contact
      </label>
      <Tag data-testid="contact-status">{contact.status}</Tag>
      <RowActions>
        <Button
          size="sm"
          variant="outline"
          data-testid="contact-save"
          disabled={!enabled || !changed}
          onClick={() => {
            onSave({
              contactId: contact.id,
              fullName: fullName.trim(),
              title: title.trim() === '' ? null : title.trim(),
              makePrimary: primary && !contact.isPrimary,
            });
          }}
        >
          Save
        </Button>
      </RowActions>
    </Row>
  );
}

const ENROLLMENT_STATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  active: 'running',
  review_required: 'waiting for your review',
  completed: 'finished',
  stopped: 'stopped',
});

function Sequences({
  page,
  contacts,
  view,
  actionsEnabled,
  onOpenOpportunity,
  onEnroll,
}: {
  readonly page: Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>;
  readonly contacts: readonly ContactDto[];
  readonly view: FirmSequencesView;
  readonly actionsEnabled: boolean;
  onOpenOpportunity(): void;
  onEnroll(request: EnrollRequest): void;
}): JSX.Element {
  const names = new Map(contacts.map(contact => [contact.id, contact.fullName] as const));
  const active = contacts.filter(contact => contact.status === 'active');
  const [contactId, setContactId] = useState(active[0]?.id ?? '');
  const [sequenceVersionId, setSequenceVersionId] = useState(view.published[0]?.sequenceVersionId ?? '');
  const opportunity = page.opportunity;

  const body = ((): JSX.Element => {
    if (view.readError !== null) {
      return (
        <p data-testid="firm-sequences-unread" className="py-2 text-sm text-muted-foreground">
          {`Callie could not read the sequences (${view.readError}).`}
        </p>
      );
    }
    if (opportunity === null) {
      return (
        <div className="flex items-center gap-3 py-2">
          <p data-testid="enroll-needs-pipeline" className="text-sm text-muted-foreground">
            Put the firm in the pipeline before enrolling anybody here.
          </p>
          <Button size="sm" data-testid="open-opportunity" disabled={!actionsEnabled} onClick={onOpenOpportunity}>
            Add to pipeline
          </Button>
        </div>
      );
    }
    if (opportunity.status !== 'open') {
      return (
        <p data-testid="enroll-closed" className="py-2 text-sm text-muted-foreground">
          This firm’s opportunity is closed, so nobody here is enrolled from this page.
        </p>
      );
    }
    if (view.published.length === 0 || active.length === 0) {
      return (
        <p data-testid="enroll-unavailable" className="py-2 text-sm text-muted-foreground">
          {view.published.length === 0
            ? 'No sequence is published yet. Publish one in Sequences.'
            : 'Add a contact before enrolling anybody here.'}
        </p>
      );
    }
    return (
      <div data-testid="enroll-form" className="flex items-center gap-2 py-2">
        <Select
          data-testid="enroll-contact"
          aria-label="Who"
          disabled={!actionsEnabled}
          value={contactId}
          onChange={event => {
            setContactId(event.target.value);
          }}
          className="w-44"
        >
          {active.map(entry => (
            <option key={entry.id} value={entry.id}>
              {entry.fullName}
            </option>
          ))}
        </Select>
        <Select
          data-testid="enroll-sequence"
          aria-label="Sequence"
          disabled={!actionsEnabled}
          value={sequenceVersionId}
          onChange={event => {
            setSequenceVersionId(event.target.value);
          }}
          className="w-56"
        >
          {view.published.map(entry => (
            <option key={entry.sequenceVersionId} value={entry.sequenceVersionId}>
              {entry.label}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          data-testid="enroll-submit"
          disabled={!actionsEnabled}
          onClick={() => {
            onEnroll({ sequenceVersionId, contactId });
          }}
        >
          Enrol
        </Button>
      </div>
    );
  })();

  return (
    <Section data-testid="firm-sequences" title="Sequences" count={view.enrollments.length}>
      {view.enrollments.length === 0 ? null : (
        <Rows data-testid="firm-enrollments">
          {view.enrollments.map(enrollment => (
            <Row key={enrollment.enrollmentId} data-testid="firm-enrollment">
              <RowMain
                line={`${names.get(enrollment.contactId) ?? 'A contact'} — ${enrollment.label}`}
                detail={`${ENROLLMENT_STATE_LABELS[enrollment.state] ?? enrollment.state}, since ${shortDay(enrollment.startedAt)}`}
              />
            </Row>
          ))}
        </Rows>
      )}
      {body}
    </Section>
  );
}

function Opportunity({ page }: { readonly page: Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }> }): JSX.Element {
  const opportunity = page.opportunity;
  return (
    <Section data-testid="firm-opportunity" title="Opportunity">
      {opportunity === null ? (
        <p data-testid="opportunity-none" className="py-2 text-sm text-muted-foreground">
          There is no opportunity at this firm yet.
        </p>
      ) : (
        <>
          <p className="py-1 text-sm">
            {`${inWords(opportunity.status)} at ${inWords(opportunity.stageKey)}, opened ${shortDay(opportunity.openedAt)}`}
            {opportunity.closeReason === null ? '' : ` · closed because ${inWords(opportunity.closeReason)}`}
          </p>
          <ol data-testid="stage-history" className="mt-1 flex flex-col border-t border-border">
            {page.stageHistory.map(event => (
              <li
                key={`${event.occurredAt}:${event.toStageKey}`}
                data-testid="stage-event"
                className="flex items-center gap-3 border-b border-border py-1 text-xs last:border-b-0"
              >
                <span data-testid="stage-event-move" className="flex-1">
                  {`${event.fromStageKey === null ? 'opened' : inWords(event.fromStageKey)} → ${inWords(event.toStageKey)}`}
                </span>
                {event.reason === null ? null : (
                  <span data-testid="stage-event-reason" className="text-muted-foreground">
                    {event.reason}
                  </span>
                )}
                <span data-testid="stage-event-at" className="text-muted-foreground">
                  {shortDay(event.occurredAt)}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </Section>
  );
}

function Holds({ page }: { readonly page: Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }> }): JSX.Element {
  return (
    <Section data-testid="firm-holds" title="Holds" count={page.holds.length}>
      {page.holds.length === 0 ? (
        <p data-testid="holds-none" className="py-2 text-sm text-muted-foreground">
          Nothing is holding this firm.
        </p>
      ) : (
        <Rows>
          {page.holds.map(hold => (
            <Row key={`${hold.reasonCode}:${hold.startedAt}`} data-testid="firm-hold">
              <RowMain
                line={<span data-testid="hold-reason">{inWords(hold.reasonCode)}</span>}
                detail={
                  <>
                    <span data-testid="hold-blocks">{hold.blockedActionKinds.map(inWords).join(', ')}</span>
                    {' · since '}
                    <span data-testid="hold-since">{shortDayTime(hold.startedAt)}</span>
                    {hold.recoveryAction === null ? null : (
                      <>
                        {' · clears with '}
                        <span data-testid="hold-recovery">{inWords(hold.recoveryAction)}</span>
                      </>
                    )}
                  </>
                }
              />
              {hold.recoveryAction === null ? <span data-testid="hold-recovery" className="sr-only">—</span> : null}
            </Row>
          ))}
        </Rows>
      )}
    </Section>
  );
}

export function FirmPage({
  page,
  sequences,
  actionsEnabled,
  redactionNotice,
  onSaveContact,
  onCheckRoute,
  onOpenOpportunity,
  onEnroll,
}: {
  readonly page: FirmPageResponse;
  readonly sequences: FirmSequencesView | null;
  readonly actionsEnabled: boolean;
  readonly redactionNotice: string | null;
  onSaveContact(edit: ContactEdit): void;
  onCheckRoute(request: CheckRouteRequest): void;
  onOpenOpportunity(): void;
  onEnroll(request: EnrollRequest): void;
}): JSX.Element {
  // Both discriminators, because they are two independent facts: the page's width and
  // the read's. They always agree — `readFirmPage` produces them together — and the
  // narrowing is what makes "the detail fields exist" a type rather than a hope.
  const detail = page.visibility === 'assigned_or_admin' && page.read.visibility === 'assigned_or_admin' ? page.read.firm : null;
  return (
    <>
      <Identity page={page} />
      {page.visibility !== 'assigned_or_admin' || detail === null ? (
        <p data-testid="firm-redacted" className="mt-6 text-sm text-muted-foreground">
          {redactionNotice ?? ''}
        </p>
      ) : (
        <>
          <PhoneRoutes routes={detail.phoneRoutes} />
          <EmailRoutes routes={detail.emailRoutes} actionsEnabled={actionsEnabled} onCheckRoute={onCheckRoute} />
          <Section data-testid="contacts-panel" title="Contacts" count={detail.contacts.length}>
            {detail.contacts.length === 0 ? (
              <p data-testid="contacts-empty" className="py-2 text-sm text-muted-foreground">
                Nobody is recorded at this firm yet.
              </p>
            ) : (
              <Rows data-testid="contacts-list">
                {detail.contacts.map(contact => (
                  <ContactRow key={contact.id} contact={contact} enabled={actionsEnabled} onSave={onSaveContact} />
                ))}
              </Rows>
            )}
          </Section>
          {sequences === null ? null : (
            <Sequences
              page={page}
              contacts={detail.contacts}
              view={sequences}
              actionsEnabled={actionsEnabled}
              onOpenOpportunity={onOpenOpportunity}
              onEnroll={onEnroll}
            />
          )}
          <Opportunity page={page} />
          <Holds page={page} />
        </>
      )}
    </>
  );
}
