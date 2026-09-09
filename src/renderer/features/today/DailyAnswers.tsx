import { dailyAnswerPresentationMatches } from '../../../shared/contracts/dailyAnswerPresentationContract';
import type { ReactNode } from 'react';
import { AnswerIdentity, OriginalCallContext, revealMessageFocus } from './AnswerPresentation';
import { ClipboardCheck } from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { DailyAnswer } from '../../../shared/contracts/dailyContract';
import {
  requestedDraftSession,
  type RequestedDraftApi,
} from './requestedDraftSession';
import { LinkedInStep } from '../linkedin/LinkedInStep';
import type { LinkedInApi } from '../../../shared/contracts/linkedInContract';
export const answerKey = (a: DailyAnswer) =>
  a.kind === 'reply'
    ? JSON.stringify([
        a.kind,
        a.accountId,
        a.thread.thread.provider,
        a.thread.thread.mailboxSubject,
        a.thread.thread.providerThreadId,
        a.draft ? ['draft', a.draft.id] : ['no-draft'],
      ])
    : `${a.kind}:${a.accountId}:${a.draft.id}`;
export const answerLabel = (a: DailyAnswer) =>
  a.kind === 'manual_linkedin'
    ? 'Manual LinkedIn'
    : a.kind === 'reply'
      ? 'Reply'
      : 'Email';
export function DailyAnswers({
  items,
  selected,
  name,
  onSelect,
  unavailable = false,
  workspaceId,
}: {
  items: DailyAnswer[];
  selected: string | null;
  name(id: string): string;
  onSelect(key: string): void;
  unavailable?: boolean;
  workspaceId?: string | null;
}) {
  return (
    <section className="native-desk__lane" aria-labelledby="daily-answers" tabIndex={0}>
      <h2 id="daily-answers">
        <span className="native-desk__lane-label"><ClipboardCheck size={14} aria-hidden="true" />Needs your approval</span> <span className="native-desk__count">{unavailable ? 'Unavailable' : items.length}</span>
      </h2>
      {items.length === 0 ? (
        null
      ) : (
        items.map((a) => {
          const contact = a.kind !== 'reply' && a.presentation && workspaceId && dailyAnswerPresentationMatches(a.presentation, a.draft, workspaceId) ? a.presentation.contact : null;
          return (
          <button
            type="button"
            className="native-desk__row"
            data-row-key={answerKey(a)}
            aria-current={selected === answerKey(a) ? 'true' : undefined}
            key={answerKey(a)}
            aria-label={`${answerLabel(a)} · ${name(a.accountId)}`}
            aria-description={contact?.displayName ?? (a.kind === 'requested_followup' ? a.draft.recipient : name(a.accountId))}
            onClick={() => onSelect(answerKey(a))}
          >
            <strong>{contact?.displayName ?? (a.kind === 'requested_followup' ? a.draft.recipient : name(a.accountId))}</strong>
            <small>{answerLabel(a)}</small>
            <span className="native-desk__row-company">{name(a.accountId)}</span>
            <span>
              {a.kind === 'manual_linkedin'
                ? 'Manual step'
                : a.kind === 'reply'
                  ? a.stale
                    ? 'Saved reply needs review'
                    : 'Review saved reply'
                  : a.approval
                    ? a.approval.receipt.status === 'pending' ? 'Approval pending' : a.approval.receipt.status === 'rejected' ? 'Approval rejected' : a.approval.state.replaceAll('_', ' ')
                    : 'Review saved email'}
            </span>
          </button>
        );})
      )}
    </section>
  );
}
function RequestedEditor({
  item,
  api,
  workspaceId,
  actionHold,
  company = 'Company unavailable',
  accountDetails,
}: {
  item: Extract<DailyAnswer, { kind: 'requested_followup' }>;
  api: RequestedDraftApi;
  workspaceId: string;
  actionHold?: string;
  company?: string;
  accountDetails?: ReactNode;
}) {
  const session = requestedDraftSession(
    api,
    workspaceId,
    item.draft,
    item.approval,
  );
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const subject = useRef<HTMLInputElement>(null),
    body = useRef<HTMLTextAreaElement>(null);
  const { expiry, attested } = state;
  const setExpiry = (value: string) => session.setPermission(value, attested);
  const setAttested = (value: boolean) => session.setPermission(expiry, value);
  useEffect(() => {
    session.ingest(item.draft, item.approval);
  }, [session, item]);
  useEffect(() => {
    session.setActionHold(actionHold);
  }, [session, actionHold]);
  useLayoutEffect(() => {
    const f = session.focus;
    if (f) {
      const el = f.field === 'subject' ? subject.current : body.current;
      el?.focus();
      el?.setSelectionRange(f.start, f.end);
    }
  }, [session]);
  const remember = (
    field: 'subject' | 'body',
    el: HTMLInputElement | HTMLTextAreaElement,
  ) => {
    session.focus = {
      field,
      start: el.selectionStart ?? 0,
      end: el.selectionEnd ?? 0,
    };
  };
  const presentation = item.presentation && dailyAnswerPresentationMatches(item.presentation, state.draft, workspaceId) ? item.presentation : undefined;
  const locked =
    state.busy ||
    state.unknownApproval ||
    state.approval?.state === 'pending_preflight' ||
    state.approval?.state === 'materialized';
  const expiryInstant =
    expiry && Number.isFinite(Date.parse(expiry))
      ? new Date(expiry).toISOString()
      : '';
  return (
    <div className="native-desk__composer">
      <AnswerIdentity type="Requested email" tag={state.unknownApproval ? 'Approval receipt unknown' : state.approval?.receipt.status === 'pending' ? 'Approval pending' : state.approval?.receipt.status === 'rejected' ? 'Approval rejected' : state.approval ? state.approval.state.replaceAll('_', ' ') : 'Review saved email'} company={company} fallback={state.draft.recipient} contact={presentation?.contact} />
      <div className="native-desk__message-area" onFocusCapture={revealMessageFocus}>
      <p className="native-desk__recipient">To {state.draft.recipient}</p>
      <OriginalCallContext context={presentation?.callContext} />
      <label>
        Subject
        <input
          ref={subject}
          aria-label="Email subject"
          value={state.subject}
          readOnly={locked}
          onSelect={(e) => remember('subject', e.currentTarget)}
          onChange={(e) => {
            session.edit('subject', e.target.value);
            session.autosave();
          }}
        />
      </label>
      <label className="native-desk__message-field">
        Message
        <textarea
          ref={body}
          aria-label="Email body"
          value={state.body}
          readOnly={locked}
          onSelect={(e) => remember('body', e.currentTarget)}
          onChange={(e) => {
            session.edit('body', e.target.value);
            session.autosave();
          }}
        />
      </label>
      </div>
      <footer className="native-desk__action-area">
      <div className="native-desk__permission">
        <label className="native-desk__check">
          <input
            type="checkbox"
            checked={attested}
            disabled={locked}
            onChange={(e) => setAttested(e.target.checked)}
          />
          I confirm this recipient requested information by email during the
          recorded call.
        </label>
        <label>
          Approval expires (local time)
          <input
            type="datetime-local"
            aria-label="Approval expiry"
            value={expiry}
            disabled={locked}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </label>
      </div>
      <div className="native-desk__actions">
        <button
          type="button"
          className="native-desk__primary"
          disabled={
            !!(actionHold || state.holdReason) ||
            locked ||
            state.conflict ||
            state.stale ||
            !attested ||
            !expiryInstant ||
            Date.parse(expiryInstant) <= Date.now()
          }
          onClick={() => void session.approve(expiryInstant, attested)}
        >
          Approve email
        </button>
        <button
          type="button"
          disabled={
            locked || state.conflict || !!(actionHold || state.holdReason)
          }
          onClick={() => void session.flush().catch((): void => undefined)}
        >
          Save edits
        </button>
        <details className="native-desk__approval-checks" open={!!(state.error || state.stale || state.unknownApproval || actionHold || state.holdReason)}>
          <summary>Approval checks</summary>
        <p>
          Approval first saves the exact displayed draft with the owner. It is
          not confirmation of sending.
        </p>
        <button
          type="button"
          disabled={state.busy || !!(actionHold || state.holdReason)}
          onClick={() => void session.preflight()}
        >
          Owner preflight
        </button>
      <details className="native-desk__evidence">
        <summary>Call and draft evidence</summary>
        <p>Requested email · revision {state.draft.revision}</p>
        <p>From {state.draft.sender}</p>
        <p>Call event: {state.draft.originalCall.outcomeEventId}</p>
        {presentation?.issues.map(issue => <p key={`${issue.field}:${issue.reason}`}>{issue.field.replaceAll('_', ' ')}: {issue.reason.replaceAll('_', ' ')}</p>)}
        <p>
          Evidence:{' '}
          {state.draft.evidenceIds.join(', ') || 'No evidence IDs stored'}
        </p>
      </details>
      <details className="native-desk__evidence"><summary>Company details</summary>{accountDetails}</details>
        </details>
      </div>
      <div className="native-desk__feedback" aria-live="polite">
        {(!attested || !expiryInstant || Date.parse(expiryInstant) <= Date.now()) && <p>Confirm the request and choose a future expiry to approve this email.</p>}
        <p>{state.saving ? 'Saving edits…' : 'Approval saves the exact draft. Not confirmed sent.'}</p>
        {(actionHold || state.holdReason) && (
          <p role="status">{actionHold || state.holdReason}</p>
        )}
        {state.error && <p role="alert">{state.error}</p>}
        {state.approval && (
          <p>
            Approval: {state.approval.state.replaceAll('_', ' ')}. Not confirmed
            sent.{state.approval.reason && ` ${state.approval.reason}`}
          </p>
        )}
        {state.unknownApproval && (
          <button
            disabled={state.busy || !!(actionHold || state.holdReason)}
            onClick={() => void session.retryApproval()}
          >
            Retry same approval
          </button>
        )}
      </div>
      {state.incoming && (
        <details open>
          <summary>Saved version needs review</summary>
          <p>The saved version differs. Review the displayed recipient and text before explicitly choosing a version.</p>
          <p>Saved recipient: {state.incoming.recipient}</p>
          <p>{state.incoming.subject}</p>
          <pre>{state.incoming.body}</pre>
          <button
            disabled={state.busy || state.unknownApproval}
            onClick={() => {
              session.useSavedVersion();
            }}
          >
            Use saved version and discard displayed edits
          </button>
        </details>
      )}
      </footer>
    </div>
  );
}
export function DailyAnswerDetail({
  item,
  workspaceId,
  api,
  linkedin,
  actionHold,
  company = 'Company unavailable',
  accountDetails,
}: {
  item: DailyAnswer;
  workspaceId: string;
  api: RequestedDraftApi;
  linkedin: LinkedInApi;
  actionHold?: string;
  company?: string;
  accountDetails?: ReactNode;
}) {
  if (item.kind === 'requested_followup')
    return (
      <RequestedEditor
        key={answerKey(item)}
        item={item}
        workspaceId={workspaceId}
        api={api}
        actionHold={actionHold}
        company={company}
        accountDetails={accountDetails}
      />
    );
  if (item.kind === 'manual_linkedin')
    return (
      <LinkedInStep
        key={answerKey(item)}
        item={item}
        workspaceId={workspaceId}
        api={linkedin}
        actionHold={actionHold}
        company={company}
        accountDetails={accountDetails}
      />
    );
  return (
    <section>
      <h3>Saved reply</h3>
      {item.draft ? (
        <>
          <p>To {item.draft.recipient}</p>
          <h4>{item.draft.subject}</h4>
          <pre>{item.draft.body}</pre>
        </>
      ) : (
        <p>No saved reply draft.</p>
      )}
      <p role="status">
        {item.stale ? 'Thread or context changed. ' : ''}Reply approval held: an
        exact permission binding and public draft editor are not available here.
        Review the conversation and owner permissions before continuing.
      </p>
      <details><summary>Company details</summary>{accountDetails}</details>
    </section>
  );
}
