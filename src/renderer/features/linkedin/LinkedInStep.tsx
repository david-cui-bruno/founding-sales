import { dailyAnswerPresentationMatches } from '../../../shared/contracts/dailyAnswerPresentationContract';
import type { ReactNode } from 'react';
import { AnswerIdentity, revealMessageFocus } from '../today/AnswerPresentation';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { DailyAnswer } from '../../../shared/contracts/dailyContract';
import type {
  LinkedInApi,
  LinkedInReport,
} from '../../../shared/contracts/linkedInContract';
import { linkedInSession } from './linkedInSession';
export function LinkedInStep({
  item,
  api,
  workspaceId,
  actionHold,
  company = 'Company unavailable',
  accountDetails,
}: {
  item: Extract<DailyAnswer, { kind: 'manual_linkedin' }>;
  api: LinkedInApi;
  workspaceId: string;
  actionHold?: string;
  company?: string;
  accountDetails?: ReactNode;
}) {
  const session = linkedInSession(api, workspaceId, item),
    state = useSyncExternalStore(session.subscribe, session.snapshot);
  const outcome = state.outcome,
    reply = state.replyText;
  const note = useRef<HTMLTextAreaElement>(null),
    replyEditor = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const f = session.focus;
    if (f) {
      const el = f.field === 'note' ? note.current : replyEditor.current;
      el?.focus();
      el?.setSelectionRange(f.start, f.end);
    }
  }, [session]);
  useEffect(() => session.setActionHold(actionHold), [session, actionHold]);
  useEffect(() => session.ingest(item), [session, item]);
  const presentation = item.presentation && dailyAnswerPresentationMatches(item.presentation, state.draft, workspaceId) ? item.presentation : undefined;
  const operationHeld =
    !!actionHold ||
    workspaceId !== state.draft.workspaceId ||
    state.busy ||
    state.draft.state === 'held' ||
    state.draft.state === 'closed';
  const held = operationHeld || state.conflict;
  return (
    <section className="native-desk__composer">
      <AnswerIdentity type="Manual LinkedIn" tag={state.draft.state} company={company} fallback={company} contact={presentation?.contact} />
      <div className="native-desk__message-area" onFocusCapture={revealMessageFocus}>
      <p>You send in LinkedIn. Opening or copying never records a send.</p>
      <label>
        LinkedIn note
        <textarea
          ref={note}
          onSelect={(e) => {
            session.focus = {
              field: 'note',
              start: e.currentTarget.selectionStart,
              end: e.currentTarget.selectionEnd,
            };
          }}
          aria-label="LinkedIn note"
          value={state.body}
          readOnly={held || !session.canEdit()}
          onChange={(e) => session.edit(e.target.value)}
        />
      </label>
      <details className="native-desk__evidence"><summary>Company details</summary>{accountDetails}</details>
      </div>
      <footer className="native-desk__action-area">
      <div className="native-desk__actions">
        <button
          className="native-desk__primary"
          disabled={held || (!!state.begin && state.begin.status !== 'pending')}
          onClick={() => void session.begin()}
        >
          Begin manual step
        </button>
        <button disabled={held} onClick={() => void session.saveEdits()}>
          Save note
        </button>
        <button disabled={held} onClick={() => void session.helper('open')}>
          Open LinkedIn
        </button>
        <button disabled={held} onClick={() => void session.helper('copy')}>
          Copy note
        </button>
      </div>
      <label>
        Manual outcome
        <select
          aria-label="Manual outcome"
          value={outcome}
          disabled={held || !!state.report}
          onChange={(e) =>
            session.chooseOutcome(
              e.target.value as LinkedInReport['outcome'] | '',
            )
          }
        >
          <option value="">Choose the observed outcome</option>
          <option value="human_reported_sent">I sent it manually</option>
          <option value="reply">Reply received</option>
          <option value="no_reply">No reply observed</option>
          <option value="opt_out">Opt out</option>
          <option value="cancelled">Cancelled</option>
          <option value="not_sent">Not sent</option>
          <option value="unknown">Unknown</option>
        </select>
      </label>
      {outcome === 'reply' && (
        <label>
          Reply text
          <textarea
            ref={replyEditor}
            onSelect={(e) => {
              session.focus = {
                field: 'reply',
                start: e.currentTarget.selectionStart,
                end: e.currentTarget.selectionEnd,
              };
            }}
            aria-label="Reply text"
            value={reply}
            onChange={(e) => session.editReply(e.target.value)}
          />
        </label>
      )}
      <div className="native-desk__actions">
        <button
          disabled={
            session.canRetryReport()
              ? operationHeld
              : held ||
                !outcome ||
                !session.canReport() ||
                (outcome === 'reply' && !reply.trim())
          }
          onClick={() => {
            if (session.canRetryReport()) void session.retryReport();
            else if (outcome) void session.report(outcome, reply);
          }}
        >
          {session.canRetryReport()
            ? 'Retry retained outcome'
            : 'Record outcome'}
        </button>
        <button
          disabled={state.busy || !!actionHold}
          onClick={() => void session.recover()}
        >
          Recover receipts
        </button>
      </div>
      {state.incoming && (
        <details open>
          <summary>Saved LinkedIn version needs review</summary>
          <p>The saved target or version differs. The retained note is shown above until you explicitly choose the saved version.</p>
          <p>
            Route: {state.incoming.draft.routeId} v
            {state.incoming.draft.routeVersion}. Draft revision{' '}
            {state.incoming.draft.revision}.
          </p>
          <pre>{state.incoming.draft.body}</pre>
          <p>
            Using this version discards the displayed local note. Resolve
            unknown or pending receipts first.
          </p>
          <button
            disabled={!session.canUseSavedVersion()}
            onClick={() => session.useSavedVersion()}
          >
            Use saved LinkedIn version
          </button>
        </details>
      )}
      <div className="native-desk__feedback" aria-live="polite">
        {state.feedback && <p>{state.feedback}</p>}
        {state.error && <p role="alert">{state.error}</p>}
        {actionHold && <p>{actionHold}</p>}
        {state.recovery.attempts.map((a) => (
          <p key={a.commandId}>
            Attempt receipt: {a.receipt?.status ?? 'unknown'}
          </p>
        ))}
      </div>
      </footer>
    </section>
  );
}
