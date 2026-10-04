import { deadlineLabel } from '../meetings/MeetingTaskControls.tsx';
import { holdEnrollmentLine, reasonSentence, type ContactDto, type FirmDetailDto, type FirmPageResponse, type HeldOutgoingMessage, type RouteDto } from '@fss/contracts';
import { useEffect, useState, type JSX, type ReactNode } from 'react';
import type { BoardCard, StageSuggestion } from '@fss/contracts';
import { inWords, shortDay, shortDayTime } from '../dates.ts';
import type {
  CheckRouteRequest,
  ContactEdit,
  EnrollRequest,
  FirmSequencesView,
  ResolveOutgoingRequest,
} from '../firmWorkspaceContract.ts';
import { nextActionLabel } from '../pipeline/cardText.ts';
import { EMAIL_VALIDATION_TEXT, emailValidationStateOf, noticeText } from '../firmWorkspaceView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Row, RowActions, RowMain, Rows, Tag } from '../ui/layout.tsx';
import { Chip, Group } from '../v2/parts.tsx';
import type { FirmTaskDto } from '@fss/contracts';
import type { Generation } from '../app/generation.ts';
import { currentCrmMemory, useBaseGuard, useKeptText } from './crmMemory.ts';
import { FirmTimeline, type TimelinePorts } from './FirmTimeline.tsx';
import { useClearDrafts, useHasDrafts } from '../app/drafts.tsx';
import { StageEventRow, StageWhy } from './StageWhy.tsx';
import { Select } from '../ui/select.tsx';
import { CallHistory } from '../calling/CallHistory.tsx';
import { FirmMeetings } from '../meetings/FirmMeetings.tsx';
import { BasicsEditor } from '../today/BasicsEditor.tsx';
import { StopBadge, contactStopLabel, firmStopLabel, type StopLabel } from './stops.tsx';

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

function Identity({
  page,
  actionsEnabled,
  onBasicsSaved,
  stageName,
}: {
  readonly page: FirmPageResponse;
  readonly actionsEnabled: boolean;
  onBasicsSaved(): void;
  stageName(key: string): string;
}): JSX.Element {
  const firm = page.read.firm;
  const detail = page.visibility === 'assigned_or_admin' && page.read.visibility === 'assigned_or_admin' ? page.read.firm : null;
  // Open or closed is kept above the route; the editor itself stays mounted while closed,
  // so its draft is there when it is opened again (criteria 2 and 7). Escape closes it and
  // never discards.
  const memory = currentCrmMemory();
  const [, redraw] = useState(0);
  const editing = memory.pageEditors[`basics:${firm.id}`] === true;
  const setEditing = (open: boolean): void => {
    memory.pageEditors[`basics:${firm.id}`] = open;
    redraw(n => n + 1);
  };
  const [opened, setOpened] = useState(editing);
  if (editing && !opened) setOpened(true);
  // The number a new one replaces: the firm's own callable line, else its first callable one.
  const callable = detail?.phoneRoutes.filter(route => route.eligibility === 'usable') ?? [];
  const phone = callable.find(route => route.contactId === null) ?? callable[0] ?? null;
  // The basics editor's drafts are the shell's (`firm-basics:<firm>:`). They remember what they
  // started from: if the firm's number, place or zone changed since, they are dropped, so a
  // save can never send the old value back over the new one (K2).
  const clearBasics = useClearDrafts();
  const basicsBase = JSON.stringify([firm.locality, firm.regionCode, firm.timeZone, phone?.value ?? null]);
  const [basicsChanged, setBasicsChanged] = useState(false);
  const baseKey = `basics:${firm.id}:base`;
  const seen = memory.drafts[baseKey];
  if (seen === undefined) memory.drafts[baseKey] = basicsBase;
  const hasBasicsDrafts = useHasDrafts(`firm-basics:${firm.id}:`);
  useEffect(() => {
    const kept = currentCrmMemory().drafts[baseKey];
    if (kept === undefined || kept === basicsBase) return;
    currentCrmMemory().drafts[baseKey] = basicsBase;
    // Only an edit that was in progress is "changed elsewhere"; the page's own save also moves the base.
    if (hasBasicsDrafts) {
      clearBasics(`firm-basics:${firm.id}:`);
      setBasicsChanged(true);
    }
  }, [baseKey, basicsBase, clearBasics, firm.id, hasBasicsDrafts]);
  const where = [firm.locality, firm.regionCode].filter(part => part !== null).join(', ');
  const rows: readonly (readonly [string, string])[] = [
    ['Website', firm.website ?? '—'],
    ['Where', where === '' ? '—' : where],
    ['Stage', firm.stageKey === null ? '—' : stageName(firm.stageKey)],
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
    <section data-testid="firm-identity">
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-xs text-muted-foreground">{term}</dt>
            <dd className="truncate" title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {/* Slice S2: the number, city, state and zone a call needs, the same form as Today's. */}
      {detail === null ? null : (
        <>
          <Button
            variant="quiet"
            size="sm"
            data-testid="firm-edit-basics"
            aria-expanded={editing}
            className="mt-2 -ml-2"
            disabled={!actionsEnabled}
            onClick={() => {
              setEditing(!editing);
            }}
          >
            {editing ? 'Close phone and location' : 'Edit phone and location'}
          </Button>
          {basicsChanged ? (
            <p data-testid="basics-changed-elsewhere" role="status" className="mt-1 text-xs text-muted-foreground">
              Changed elsewhere. Your earlier edit was dropped; these are the current details.
            </p>
          ) : null}
          {opened ? (
            <div
              className="callie-v2 mt-2 max-w-[560px]"
              hidden={!editing}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setEditing(false);
                }
              }}
            >
              <BasicsEditor
                firmId={firm.id}
                values={{ locality: firm.locality, regionCode: firm.regionCode, timeZone: firm.timeZone }}
                phone={phone === null ? null : { routeId: phone.id, e164: phone.value }}
                enabled={actionsEnabled}
                onSaved={() => {
                  setEditing(false);
                  onBasicsSaved();
                }}
                onCancel={() => {
                  setEditing(false);
                }}
              />
            </div>
          ) : null}
        </>
      )}
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
    <Group data-testid="firm-routes-phone" title="Phone" count={routes.length}>
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
    </Group>
  );
}

function EmailRoutes({
  routes,
  actionsEnabled,
  busy,
  onCheckRoute,
}: {
  readonly routes: readonly RouteDto[];
  readonly actionsEnabled: boolean;
  /** Whether this route's own Check again is on the wire (P1-4). */
  busy(form: string): boolean;
  onCheckRoute(request: CheckRouteRequest): void;
}): JSX.Element {
  return (
    <Group data-testid="firm-routes-email" title="Email" count={routes.length}>
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
                      disabled={!actionsEnabled || busy(`route:${route.id}`)}
                      {...(busy(`route:${route.id}`) ? { 'aria-busy': true } : {})}
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
    </Group>
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
/**
 * One contact, editable in place. `saving` is this contact's own Save: two rows of the
 * same firm wait for their own command and not for each other's.
 */
function ContactRow({
  contact,
  enabled,
  saving,
  onSave,
  stop = null,
}: {
  readonly contact: ContactDto;
  /** Migration 0037 (P2): "Email stopped", "Calls stopped" or "All contact stopped". */
  readonly stop?: StopLabel | null;
  readonly enabled: boolean;
  readonly saving: boolean;
  onSave(edit: ContactEdit): void;
}): JSX.Element {
  // Kept above the route: a half-edited contact survives a visit elsewhere (criterion 7).
  // A kept edit remembers what it started from; if the contact changed meanwhile it is dropped
  // rather than sent over the newer value (K2).
  const guard = useBaseGuard(`contact:${contact.id}`, JSON.stringify([contact.fullName, contact.title, contact.isPrimary]));
  const [fullName, setFullNameKept] = useKeptText(`contact:${contact.id}:name`, contact.fullName);
  const [title, setTitleKept] = useKeptText(`contact:${contact.id}:title`, contact.title ?? '');
  const [primaryText, setPrimaryText] = useKeptText(`contact:${contact.id}:primary`, contact.isPrimary ? 'yes' : 'no');
  const primary = primaryText === 'yes';
  const setFullName = (next: string): void => {
    guard.begin();
    setFullNameKept(next);
  };
  const setTitle = (next: string): void => {
    guard.begin();
    setTitleKept(next);
  };
  const setPrimary = (next: boolean): void => {
    guard.begin();
    setPrimaryText(next ? 'yes' : 'no');
  };
  const changed = fullName !== contact.fullName || title !== (contact.title ?? '') || (primary && !contact.isPrimary);
  return (
    <Row data-testid="contact-row" data-contact-id={contact.id} className="flex-wrap gap-y-1 py-2">
      <span className="flex min-w-0 basis-full flex-col gap-0.5">
        <Input
          data-testid="contact-name"
          aria-label="Name"
          autoComplete="off"
          disabled={!enabled || saving}
          value={fullName}
          onChange={event => {
            setFullName(event.target.value);
          }}
          className="h-7 border-transparent bg-transparent px-1 font-medium hover:border-input focus:border-input"
        />
        <Input
          data-testid="contact-title"
          aria-label="Title"
          autoComplete="off"
          disabled={!enabled || saving}
          value={title}
          onChange={event => {
            setTitle(event.target.value);
          }}
          className="h-7 border-transparent bg-transparent px-1 text-muted-foreground hover:border-input focus:border-input"
        />
      </span>
      <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <input
          type="checkbox"
          data-testid="contact-primary"
          checked={primary}
          // Already the primary: the box records that and there is nothing to ask for.
          disabled={!enabled || saving || contact.isPrimary}
          onChange={event => {
            setPrimary(event.target.checked);
          }}
        />
        Main contact
      </label>
      <Tag data-testid="contact-status">{contact.status}</Tag>
      <StopBadge label={stop} testId="contact-stop" />
      {guard.changedElsewhere ? (
        <span data-testid="contact-changed-elsewhere" role="status" className="basis-full text-xs text-muted-foreground">
          Changed elsewhere. Your earlier edit was dropped.
        </span>
      ) : null}
      <RowActions>
        <Button
          size="sm"
          variant="outline"
          data-testid="contact-save"
          disabled={!enabled || !changed || saving}
          {...(saving ? { 'aria-busy': true } : {})}
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
  completed: 'finished',
  stopped: 'stopped',
});

function Sequences({
  busy,
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
  /** Whether this form's own command is on the wire (P1-4). */
  busy(form: string): boolean;
  onOpenOpportunity(): void;
  onEnroll(request: EnrollRequest): void;
}): JSX.Element {
  const names = new Map(contacts.map(contact => [contact.id, contact.fullName] as const));
  const active = contacts.filter(contact => contact.status === 'active');
  const [keptContact, setContactId] = useKeptText(`enroll:${page.read.firm.id}:contact`, active[0]?.id ?? '');
  const [keptSequence, setSequenceVersionId] = useKeptText(`enroll:${page.read.firm.id}:sequence`, view.published[0]?.sequenceVersionId ?? '');
  // A kept choice that is no longer on offer (the contact left, the version was retired) is
  // not sent: the first current option stands in for it (K2).
  const contactId = active.some(entry => entry.id === keptContact) ? keptContact : (active[0]?.id ?? '');
  const sequenceVersionId = view.published.some(entry => entry.sequenceVersionId === keptSequence)
    ? keptSequence
    : (view.published[0]?.sequenceVersionId ?? '');
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
          <Button
            size="sm"
            data-testid="open-opportunity"
            disabled={!actionsEnabled || busy('opportunity')}
            {...(busy('opportunity') ? { 'aria-busy': true } : {})}
            onClick={onOpenOpportunity}
          >
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
          disabled={!actionsEnabled || busy('enroll')}
          {...(busy('enroll') ? { 'aria-busy': true } : {})}
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
    <Group data-testid="firm-sequences" title="Sequences" count={view.enrollments.length}>
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
    </Group>
  );
}

/** The notices a held outgoing message's resolution can leave (S1 review P1-C). */
export const OUTGOING_NOTICES: ReadonlySet<string> = new Set([
  'outgoing_resolved',
  'already_resolved',
  'already_applied',
  'not_assigned',
  'match_unknown',
  'message_unknown',
]);

/**
 * Your own e-mails waiting for a firm (send-path v2, S1 review P1-C).
 *
 * A direct Gmail send matched to more than one firm is held: nothing about it is applied
 * until a person says which conversation it belongs to. This lists them, one row each,
 * with a hover action per candidate firm that sends the existing resolve command. The
 * outcome, or the refusal — `already_resolved` when somebody got there first — is said
 * under the list.
 */
export function HeldOutgoing({
  messages,
  notice,
  actionsEnabled,
  busy,
  onResolve,
}: {
  readonly messages: readonly HeldOutgoingMessage[];
  readonly notice: string | null;
  readonly actionsEnabled: boolean;
  busy(form: string): boolean;
  onResolve(request: ResolveOutgoingRequest): void;
}): JSX.Element | null {
  const said = notice !== null && OUTGOING_NOTICES.has(notice) ? noticeText(notice) : null;
  if (messages.length === 0 && said === null) return null;
  return (
    <Group data-testid="held-outgoing" title="Your e-mails waiting for a firm" count={messages.length}>
      {messages.length === 0 ? null : (
        <Rows data-testid="held-outgoing-list">
          {messages.map(message => (
            <Row key={message.messageId} data-testid="held-outgoing-row">
              <RowMain
                line={`Sent ${shortDayTime(message.internalDate)}`}
                detail={`Which firm is this about? ${message.candidates.map(candidate => candidate.firmName).join(' or ')}`}
              />
              <RowActions>
                {message.candidates.map(candidate => (
                  <Button
                    key={candidate.opportunityId}
                    size="sm"
                    variant="outline"
                    data-testid="held-outgoing-choose"
                    disabled={!actionsEnabled || busy(`outgoing:${message.messageId}`)}
                    onClick={() => {
                      onResolve({ messageId: message.messageId, opportunityId: candidate.opportunityId });
                    }}
                  >
                    {candidate.firmName}
                  </Button>
                ))}
              </RowActions>
            </Row>
          ))}
        </Rows>
      )}
      {said === null ? null : (
        <p data-testid="held-outgoing-notice" className="py-2 text-sm text-muted-foreground">
          {said}
        </p>
      )}
    </Group>
  );
}

/**
 * "I will handle this myself" (P1-1 of the GPT-6 review of PR 332).
 *
 * The one control that records an explicit takeover, which is the manual mode an
 * evidenced follow-up does not run beside. It is offered only while the opportunity is
 * open and automated: a firm already in manual needs no button to say so, and nothing
 * here reverses manual mode, because automation never does.
 */
function TakeOver({
  firmId,
  enabled,
  saving,
  onTakeOver,
}: {
  /** Whose reason this is: the draft is kept per firm, never shared between firms (K1). */
  readonly firmId: string;
  readonly enabled: boolean;
  readonly saving: boolean;
  onTakeOver(reason: string): void;
}): JSX.Element {
  const [reason, setReason] = useKeptText(`take-over:${firmId}:reason`);
  return (
    <div data-testid="take-over" className="flex items-center gap-2 py-2">
      <Input
        data-testid="take-over-reason"
        aria-label="Why you are taking this over"
        placeholder="Why you are taking this over"
        value={reason}
        onChange={event => setReason(event.target.value)}
      />
      <Button
        data-testid="take-over-submit"
        disabled={!enabled || saving || reason.trim() === ''}
        onClick={() => {
          onTakeOver(reason.trim());
          setReason('');
        }}
      >
        I will handle this myself
      </Button>
    </div>
  );
}

/**
 * Whether "I will handle this myself" has anything left to say (P1-1 of the second review
 * of PR 332).
 *
 * It used to be offered only while the opportunity was automated, which hid it in exactly
 * the state a person most needs it: manual on a *signal* — a reply, an engaged call, or
 * (history since send-path v2, when a direct send stopped being a takeover) a direct send
 * they said to keep following up after — is the state in which an evidenced follow-up
 * still runs beside them. So the control is offered for every open opportunity
 * except one already taken over by hand, where pressing it would change nothing.
 */
function takeoverOffered(
  opportunity: NonNullable<Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>['opportunity']>,
): boolean {
  if (opportunity.status !== 'open') return false;
  if (opportunity.controlMode === 'automated') return true;
  return opportunity.controlModeOrigin !== 'salesperson_command';
}

function Opportunity({
  page,
  card,
  stageName,
  actionsEnabled,
  busy,
  onTakeOver,
}: {
  readonly page: Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>;
  readonly card: BoardCard | undefined;
  stageName(key: string): string;
  readonly actionsEnabled: boolean;
  busy(form: string): boolean;
  onTakeOver(reason: string): void;
}): JSX.Element {
  const opportunity = page.opportunity;
  return (
    <Group data-testid="firm-opportunity" title="Opportunity and stage">
      {opportunity === null ? (
        <p data-testid="opportunity-none" className="py-2 text-sm text-muted-foreground">
          There is no opportunity at this firm yet.
        </p>
      ) : (
        <>
          <p className="py-1 text-sm">
            {`${inWords(opportunity.status)} at ${stageName(opportunity.stageKey)}, opened ${shortDay(opportunity.openedAt)}`}
            {opportunity.closeReason === null ? '' : ` · closed because ${inWords(opportunity.closeReason)}`}
          </p>
          <StageWhy history={page.stageHistory} card={card} stageName={stageName} />
          {takeoverOffered(opportunity) ? (
            <TakeOver firmId={page.read.firm.id} enabled={actionsEnabled} saving={busy('take-over')} onTakeOver={onTakeOver} />
          ) : null}
          <ol data-testid="stage-history" className="mt-1 flex flex-col border-t border-border">
            {page.stageHistory.map(event => (
              <StageEventRow key={`${event.occurredAt}:${event.toStageKey}`} event={event} stageName={stageName} />
            ))}
          </ol>
        </>
      )}
    </Group>
  );
}

function Holds({ page }: { readonly page: Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }> }): JSX.Element {
  return (
    <Group data-testid="firm-holds" title="Holds" count={page.holds.length}>
      {page.holds.length === 0 ? (
        <p data-testid="holds-none" className="py-2 text-sm text-muted-foreground">
          Nothing is holding this firm.
        </p>
      ) : (
        <Rows>
          {page.holds.map(hold => (
            <Row key={`${hold.reasonCode}:${hold.startedAt}`} data-testid="firm-hold">
              <RowMain
                line={<span data-testid="hold-reason">{reasonSentence(hold.reasonCode)}</span>}
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
                    {holdEnrollmentLine(hold.enrollment) === null ? null : (
                      <>
                        {' · '}
                        <span data-testid="hold-enrollment">{holdEnrollmentLine(hold.enrollment)}</span>
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
    </Group>
  );
}

/**
 * The firm's follow-up permissions (migration 0025).
 *
 * The four facts David's decision names, in the order a person reads them: what was
 * agreed, how much it permits, when it stops, and the event it rests on. The evidence is
 * shown as what it is — a recorded call, an inbound e-mail, a booking reference — rather
 * than as an id, because the id means nothing to the one person who uses this app; the
 * id is in the title attribute for the day it is needed.
 */
function FollowUpPermissions({
  page,
}: {
  readonly page: Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>;
}): JSX.Element {
  const permissions = page.followUpPermissions;
  return (
    <Group data-testid="firm-follow-ups" title="Follow-up permissions" count={permissions.length}>
      {permissions.length === 0 ? (
        <p data-testid="follow-ups-none" className="py-2 text-sm text-muted-foreground">
          Callie may not write to anybody at this firm.
        </p>
      ) : (
        <Rows>
          {permissions.map(permission => (
            <Row key={permission.id} data-testid="firm-follow-up">
              <RowMain
                line={<span data-testid="follow-up-scope">{inWords(permission.scope)}</span>}
                detail={
                  <>
                    <span data-testid="follow-up-kind">{inWords(permission.kind)}</span>
                    {' · '}
                    <span data-testid="follow-up-evidence" title={evidenceId(permission)}>
                      {evidenceWords(permission)}
                    </span>
                    {' · '}
                    <span data-testid="follow-up-state">{permissionState(permission)}</span>
                  </>
                }
              />
            </Row>
          ))}
        </Rows>
      )}
    </Group>
  );
}

type FollowUp = Extract<FirmPageResponse, { visibility: 'assigned_or_admin' }>['followUpPermissions'][number];

function evidenceWords(permission: FollowUp): string {
  if (permission.callLogId !== null) return 'from a recorded call';
  if (permission.mailMessageId !== null) return 'from an e-mail they sent';
  return 'from a booking';
}

function evidenceId(permission: FollowUp): string {
  return permission.callLogId ?? permission.mailMessageId ?? permission.bookingReference ?? '';
}

/** Revoked, spent, expired or live — the one sentence that says whether it still counts. */
function permissionState(permission: FollowUp): string {
  if (permission.revokedAt !== null) return `withdrawn ${shortDayTime(permission.revokedAt)}`;
  if (permission.consumedAt !== null) return `used ${shortDayTime(permission.consumedAt)}`;
  if (Date.parse(permission.expiresAt) <= Date.now()) return `expired ${shortDayTime(permission.expiresAt)}`;
  return `until ${shortDayTime(permission.expiresAt)}`;
}

/** The earliest next action the board knows of, as the card shows it (no new read). */
function NextAction({ card, timeZone }: { readonly card: BoardCard | undefined; readonly timeZone: string | null }): JSX.Element {
  const next = card?.nextAction ?? null;
  return (
    <Group data-testid="firm-next-action" title="Next action">
      {next === null ? (
        <p className="py-1 text-sm text-muted-foreground">Nothing is scheduled.</p>
      ) : (
        <p className="py-1 text-sm" data-testid="firm-next-action-line">
          {nextActionLabel(next, timeZone)}
        </p>
      )}
    </Group>
  );
}

const TASK_WORDS: Readonly<Record<FirmTaskDto['kind'], string>> = { callback: 'Callback', call_task: 'Task', meeting_task: 'Meeting task', step: 'Sequence step' };

/**
 * The firm's open work, soonest first (S4F). Read-only: acting on a task stays where it is
 * today. A callback and a step carry a code for a label, so they are put in words here.
 */
function FirmTasks({ tasks }: { readonly tasks: readonly FirmTaskDto[] }): JSX.Element {
  const label = (task: FirmTaskDto): string =>
    task.kind === 'step' ? (task.label === 'linkedin_task' ? 'LinkedIn step' : 'Call step') : task.kind === 'callback' ? 'Callback requested' : task.label;
  return (
    <Group data-testid="firm-tasks" title="Tasks" count={tasks.length}>
      {tasks.length === 0 ? (
        <p data-testid="tasks-none" className="py-1 text-sm text-muted-foreground">
          Nothing is waiting on this firm.
        </p>
      ) : (
        <ul className="flex flex-col border-t border-border">
          {tasks.map(task => (
            <li key={task.key} data-testid="firm-task" className="flex items-baseline gap-3 border-b border-border py-1 text-sm last:border-b-0">
              <span className="min-w-0 flex-1 truncate" title={label(task)}>
                {label(task)}
              </span>
              <span className="text-xs text-muted-foreground">{TASK_WORDS[task.kind]}</span>
              {task.status === 'held' ? <Chip tone="warn">Held</Chip> : null}
              <span className="w-32 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{task.deadline === undefined ? shortDayTime(task.dueAt) : deadlineLabel(task.deadline)}</span>
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}

/** Contacts without the editing controls: the panel's form, who is there and how to reach them. */
function ContactsBrief({ detail }: { readonly detail: FirmDetailDto }): JSX.Element {
  const routesOf = (id: string): string[] =>
    [...detail.phoneRoutes, ...detail.emailRoutes].filter(route => route.contactId === id && route.eligibility !== 'retired').map(route => route.value);
  return (
    <Group data-testid="contacts-panel" title="Contacts" count={detail.contacts.length}>
      {detail.contacts.length === 0 ? (
        <p data-testid="contacts-empty" className="py-1 text-sm text-muted-foreground">
          Nobody is recorded at this firm yet.
        </p>
      ) : (
        <ul data-testid="contacts-list" className="flex flex-col">
          {detail.contacts.map(contact => (
            <li key={contact.id} data-testid="contact-row" className="flex flex-col py-1">
              <span className="flex items-center gap-1.5 text-sm">
                <span className="truncate font-medium">{contact.fullName}</span>
                {contact.isPrimary ? <Chip tone="outline">Main contact</Chip> : null}
              </span>
              <span className="truncate text-xs text-muted-foreground">{[contact.title, ...routesOf(contact.id)].filter(part => part !== null).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}

export function FirmPage({
  page,
  sequences,
  actionsEnabled,
  busy,
  redactionNotice,
  onSaveContact,
  onCheckRoute,
  onOpenOpportunity,
  onEnroll,
  onTakeOver,
  heldOutgoing = [],
  notice = null,
  onResolveOutgoing = () => undefined,
  onBasicsSaved = () => undefined,
  card,
  stageName = inWords,
  variant = 'page',
  research = null,
  guard,
  timelinePorts,
  onApplyStageSuggestion,
}: {
  readonly page: FirmPageResponse;
  readonly sequences: FirmSequencesView | null;
  readonly actionsEnabled: boolean;
  /** Whether one named form's own command is on the wire (1.0.13, after the review). */
  busy(form: string): boolean;
  readonly redactionNotice: string | null;
  onSaveContact(edit: ContactEdit): void;
  onCheckRoute(request: CheckRouteRequest): void;
  onOpenOpportunity(): void;
  onEnroll(request: EnrollRequest): void;
  onTakeOver(reason: string): void;
  /** The page's held outgoing messages (S1 review P1-C). */
  readonly heldOutgoing?: readonly HeldOutgoingMessage[];
  /** The window's notice, shown under the held messages when it is about one of them. */
  readonly notice?: string | null;
  onResolveOutgoing?(request: ResolveOutgoingRequest): void;
  /** The basics were saved (slice S2): read the page again. */
  onBasicsSaved?(): void;
  /** The firm's board card, when the board has been read: its next action and latest evidence. */
  readonly card?: BoardCard | undefined;
  /** A stage key as the workspace names it (the board's stages); the words of the key otherwise. */
  stageName?(key: string): string;
  /** `page`: the whole firm in two columns. `panel`: the Pipeline's side panel, one column. */
  readonly variant?: 'page' | 'panel';
  /** The Research section, mounted by the caller because it has its own read. */
  readonly research?: ReactNode;
  /** The session's guard, so a timeline page read for a session that ended is dropped. */
  readonly guard?: Generation;
  readonly timelinePorts?: TimelinePorts | null;
  /** Lane M1: "Move to Demo booked" from the Meetings rows, through the ordinary stage command. */
  /** Lane M1: told the firm the suggestion was read for, which the command must use. */
  onApplyStageSuggestion?(suggestion: StageSuggestion, firmId: string): void;
}): JSX.Element {
  // Both discriminators, because they are two independent facts: the page's width and
  // the read's. They always agree — `readFirmPage` produces them together — and the
  // narrowing is what makes "the detail fields exist" a type rather than a hope.
  const detail = page.visibility === 'assigned_or_admin' && page.read.visibility === 'assigned_or_admin' ? page.read.firm : null;
  // Migration 0037 (P2): "Email stopped", "Calls stopped" or "All contact stopped" under the
  // firm's identity, from the negotiated `stops`; nothing for a narrow read.
  const identity = (
    <>
      <Identity page={page} actionsEnabled={actionsEnabled} onBasicsSaved={onBasicsSaved} stageName={stageName} />
      {page.visibility === 'assigned_or_admin' ? (
        <div className="mt-2 empty:hidden">
          <StopBadge label={firmStopLabel(page.stops)} testId="firm-stop" />
        </div>
      ) : null}
    </>
  );
  if (page.visibility !== 'assigned_or_admin' || detail === null) {
    return (
      <div className="callie-v2 mt-4">
        {identity}
        <p data-testid="firm-redacted" className="mt-6 text-sm text-muted-foreground">
          {redactionNotice ?? ''}
        </p>
      </div>
    );
  }
  const calls = (
    <>
      {/* Slice C1: calls placed from Callie, with their recordings. Renders nothing until there is one. */}
      <CallHistory firmId={page.read.firm.id} timeZone={page.read.firm.timeZone} />
      {/* Slice M1: the firm's Cal.com meetings, their state and time. Renders nothing until there is one. */}
      {variant === 'page' ? (
        <FirmMeetings
          firmId={page.read.firm.id}
          actionsEnabled={actionsEnabled}
          // The deal's stage: a move made here or anywhere reads the suggestion again.
          refreshKey={page.visibility === 'assigned_or_admin' ? `${page.opportunity?.id ?? 'none'}:${page.opportunity?.stageKey ?? ''}` : ''}
          {...(onApplyStageSuggestion === undefined ? {} : { onApplySuggestion: onApplyStageSuggestion })}
          suggestionBusy={busy('opportunity') || (page.visibility === 'assigned_or_admin' && page.opportunity !== null && busy(`stage:${page.opportunity.id}`))}
        />
      ) : null}
    </>
  );
  if (variant === 'panel') {
    return (
      <div data-testid="firm-panel-body" className="callie-v2 flex flex-col">
        {identity}
        <NextAction card={card} timeZone={page.read.firm.timeZone} />
        <Group data-testid="firm-opportunity" title="Stage">
          {page.opportunity === null ? (
            <p data-testid="opportunity-none" className="py-1 text-sm text-muted-foreground">
              There is no opportunity at this firm yet.
            </p>
          ) : (
            <StageWhy history={page.stageHistory} card={card} stageName={stageName} />
          )}
        </Group>
        <ContactsBrief detail={detail} />
        <div className="mt-7 first:mt-0">{calls}</div>
        {research}
      </div>
    );
  }
  return (
    <div className="callie-v2 mt-5 grid gap-x-12 gap-y-6 min-[1100px]:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 max-w-[760px]">
        {page.tasks === undefined ? <NextAction card={card} timeZone={page.read.firm.timeZone} /> : <FirmTasks tasks={page.tasks} />}
        <Opportunity
          page={page}
          card={card}
          stageName={stageName}
          actionsEnabled={actionsEnabled}
          busy={busy}
          onTakeOver={onTakeOver}
        />
        <div className="mt-7">{calls}</div>
        {page.timeline === undefined || guard === undefined ? null : (
          <FirmTimeline
            key={page.read.firm.id}
            firmId={page.read.firm.id}
            timeline={page.timeline}
            guard={guard}
            stageName={stageName}
            {...(timelinePorts === undefined ? {} : { ports: timelinePorts })}
          />
        )}
        {research}
        {sequences === null ? null : (
          <Sequences
            page={page}
            contacts={detail.contacts}
            view={sequences}
            actionsEnabled={actionsEnabled}
            busy={busy}
            onOpenOpportunity={onOpenOpportunity}
            onEnroll={onEnroll}
          />
        )}
        <HeldOutgoing
          messages={heldOutgoing}
          notice={notice}
          actionsEnabled={actionsEnabled}
          busy={busy}
          onResolve={onResolveOutgoing}
        />
        <FollowUpPermissions page={page} />
        <Holds page={page} />
      </div>
      <aside aria-label="Properties and contacts" className="min-w-0">
        {identity}
        <PhoneRoutes routes={detail.phoneRoutes} />
        <EmailRoutes routes={detail.emailRoutes} actionsEnabled={actionsEnabled} busy={busy} onCheckRoute={onCheckRoute} />
        <Group data-testid="contacts-panel" title="Contacts" count={detail.contacts.length}>
          {detail.contacts.length === 0 ? (
            <p data-testid="contacts-empty" className="py-2 text-sm text-muted-foreground">
              Nobody is recorded at this firm yet.
            </p>
          ) : (
            <Rows data-testid="contacts-list">
              {detail.contacts.map(contact => (
                <ContactRow
                  key={contact.id}
                  contact={contact}
                  enabled={actionsEnabled}
                  saving={busy(`contact:${contact.id}`)}
                  onSave={onSaveContact}
                  stop={contactStopLabel(page.stops, contact.id)}
                />
              ))}
            </Rows>
          )}
        </Group>
      </aside>
    </div>
  );
}
