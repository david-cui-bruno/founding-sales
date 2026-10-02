import { useEffect, useState, type JSX } from 'react';
import { reasonSentence, type PreparedBriefDto } from '@fss/contracts';
import type { OperationInput, OperationOutput } from '../../shared/operations.ts';
import { useDrafts, useSessionEpoch } from '../app/drafts.tsx';
import { shortDate } from '../researchView.ts';
import { Button } from '../ui/button.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { Label } from '../v2/parts.tsx';

/**
 * A firm's prepared brief (lane PB, migration 0038), on the firm page and on the Today card.
 *
 * Text prepared outside Callie — the DFW research agent's call briefs — shown beside
 * Callie's own research and never mistaken for it: the label says "Prepared research ·
 * observed <date> · not verified by Callie". The text keeps its line breaks and folds
 * beyond about six lines behind "Show more". Each source is a link that opens in the
 * default browser through the seam that already exists (`app.ts`'s window-open handler
 * hands an `https:` URL to `shell.openExternal` and denies everything else); a source that
 * is not https is shown as its label and not linked.
 *
 * An administrator gets Edit (a textarea) and Clear. What is kept follows K1–K7:
 *
 *   * **K1** — the draft, the open editor, the pending command and its answer live in the
 *     shell's drafts store, keyed `prepared-brief:<firm>:…`; the store is the session's, so
 *     a sign-out or another person signing in starts empty;
 *   * **K2** — opening the editor records the server text it began from (`base`); Save sends
 *     only the brief, and only when it changed; when the server's text has moved since the
 *     edit began the draft is dropped and "Changed elsewhere" is said instead of sending
 *     the old base back;
 *   * **K3** — a command's answer is keyed by firm and by its own token: a late answer
 *     updates the feedback only, and never reopens an editor David closed;
 *   * **K5** — the editor closes and the draft goes only on a success answer; a refusal
 *     keeps both, with the reason next to the editor.
 *
 * Escape, or a second press of Edit, closes the editor and keeps the draft (UI criterion 2).
 */

const COLLAPSE_LINES = 6;
const COLLAPSE_CHARACTERS = 600;

/** "2 Oct 2026" from `2026-10-02`, read at local noon so no zone moves it a day. */
export function observedDate(date: string): string {
  return shortDate(`${date}T12:00:00`) || date;
}

export function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

let nextToken = 0;

/**
 * The latest command per firm, per session (K3): shell memory that outlives the component,
 * keyed by the drafts store's session token so a new session never sees the last one's.
 */
const latestCommand = new WeakMap<object, Map<string, string>>();
const FALLBACK_SESSION = {};

export type SetBrief = (input: OperationInput<'firms.setPreparedBrief'>) => Promise<OperationOutput<'firms.setPreparedBrief'>>;
export type ClearBrief = (input: OperationInput<'firms.clearPreparedBrief'>) => Promise<OperationOutput<'firms.clearPreparedBrief'>>;

const defaultSet: SetBrief = async input => {
  const api = globalThis.callieApi;
  if (api === undefined) return { saved: null, reason: 'offline' };
  return await api.command('firms.setPreparedBrief', input);
};
const defaultClear: ClearBrief = async input => {
  const api = globalThis.callieApi;
  if (api === undefined) return { cleared: false, reason: 'offline' };
  return await api.command('firms.clearPreparedBrief', input);
};

function feedbackSentence(code: string): string {
  if (code === 'saved') return 'Saved.';
  if (code === 'cleared') return 'Cleared.';
  if (code === 'changed_elsewhere') return 'Changed elsewhere. Your edit was set aside; the text above is the current one.';
  if (code === 'offline') return 'Callie is offline. Nothing was saved; your edit is kept here.';
  return reasonSentence(code);
}

export function PreparedBrief({
  firmId,
  brief,
  canEdit,
  enabled,
  onChanged,
  setBrief = defaultSet,
  clearBrief = defaultClear,
}: {
  readonly firmId: string;
  /** The firm's prepared brief, or null; undefined when the read did not carry one (an older API). */
  readonly brief: PreparedBriefDto | null | undefined;
  /** Administrators edit and clear. */
  readonly canEdit: boolean;
  readonly enabled: boolean;
  /** A command landed: the view reads its own state again. */
  onChanged(): void;
  readonly setBrief?: SetBrief;
  readonly clearBrief?: ClearBrief;
}): JSX.Element | null {
  const drafts = useDrafts();
  const session = useSessionEpoch() ?? FALLBACK_SESSION;
  const prefix = `prepared-brief:${firmId}:`;
  const key = {
    text: `${prefix}text`,
    base: `${prefix}base`,
    open: `${prefix}open`,
    pending: `${prefix}pending`,
    feedback: `${prefix}feedback`,
  };
  const text = drafts.values[key.text];
  const base = drafts.values[key.base];
  const open = drafts.values[key.open] === '1';
  const pending = (drafts.values[key.pending] ?? '') !== '';
  const feedback = drafts.values[key.feedback] ?? '';
  const [expanded, setExpanded] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const current = brief?.brief ?? null;

  // K2: the server's text moved since the edit began. The kept edit is dropped, not sent.
  useEffect(() => {
    if (base === undefined || base === '' || current === null) return;
    if (base !== current && !pending) {
      drafts.set(key.text, '');
      drafts.set(key.base, '');
      drafts.set(key.open, '');
      drafts.set(key.feedback, 'changed_elsewhere');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, current, pending]);

  if (brief === undefined) return null;
  if (brief === null && feedback !== 'cleared') return null;

  const closeEditor = (): void => {
    // Escape and a second press both close and keep the draft (criterion 2).
    drafts.set(key.open, '');
  };
  const toggleEditor = (): void => {
    if (open) {
      closeEditor();
      return;
    }
    if (current === null) return;
    if (base === undefined || base === '') {
      drafts.set(key.base, current);
      drafts.set(key.text, current);
    }
    drafts.set(key.feedback, '');
    drafts.set(key.open, '1');
  };

  const send = (run: () => Promise<string>, onSuccess: () => void): void => {
    nextToken += 1;
    const token = String(nextToken);
    const commands = latestCommand.get(session) ?? new Map<string, string>();
    latestCommand.set(session, commands);
    commands.set(firmId, token);
    drafts.set(key.pending, token);
    drafts.set(key.feedback, '');
    void run()
      .then(
        code => code,
        () => 'offline',
      )
      .then(code => {
        // K3: only this firm's latest command settles it; an older answer is dropped.
        if (commands.get(firmId) !== token) return;
        commands.delete(firmId);
        drafts.set(key.pending, '');
        drafts.set(key.feedback, code);
        if (code === 'saved' || code === 'cleared') {
          onSuccess();
          onChanged();
        }
      });
  };

  const save = (): void => {
    if (pending || text === undefined || base === undefined) return;
    if (current !== base) {
      drafts.set(key.text, '');
      drafts.set(key.base, '');
      drafts.set(key.open, '');
      drafts.set(key.feedback, 'changed_elsewhere');
      return;
    }
    if (text === base || text.trim() === '') return;
    const sent = text;
    send(
      async () => {
        const answer = await setBrief({ firmId, brief: sent });
        return answer.saved === null ? (answer.reason ?? 'offline') : 'saved';
      },
      () => {
        // K5: the draft goes only now. The editor is read-only while the save is in flight,
        // so the draft is still the text that was sent.
        drafts.set(key.text, '');
        drafts.set(key.base, '');
        drafts.set(key.open, '');
      },
    );
  };

  const clear = (): void => {
    if (pending) return;
    setConfirmClear(false);
    send(
      async () => {
        const answer = await clearBrief({ firmId });
        return answer.reason === null ? 'cleared' : answer.reason;
      },
      () => {
        drafts.set(key.text, '');
        drafts.set(key.base, '');
        drafts.set(key.open, '');
      },
    );
  };

  if (brief === null) {
    return (
      <section data-testid="prepared-brief" className="py-2">
        <p data-testid="prepared-brief-feedback" className="text-xs text-muted-foreground">
          {feedbackSentence('cleared')}
        </p>
      </section>
    );
  }

  const lines = brief.brief.split('\n');
  const long = lines.length > COLLAPSE_LINES || brief.brief.length > COLLAPSE_CHARACTERS;
  const folded = long && !expanded;
  const dirty = text !== undefined && base !== undefined && base !== '' && text !== base && text.trim() !== '';

  return (
    <section data-testid="prepared-brief" className="group/prepared">
      <Label
        actions={
          canEdit ? (
            <span className="flex items-center gap-1 opacity-0 transition-opacity group-focus-within/prepared:opacity-100 group-hover/prepared:opacity-100">
              <Button
                variant="ghost"
                data-testid="prepared-brief-edit"
                aria-expanded={open}
                className="h-6 rounded-md px-2 text-xs text-muted-foreground"
                disabled={!enabled}
                onClick={toggleEditor}
              >
                Edit
              </Button>
              {confirmClear ? (
                <>
                  <Button variant="ghost" data-testid="prepared-brief-clear-confirm" className="h-6 rounded-md px-2 text-xs" disabled={!enabled || pending} onClick={clear}>
                    Clear brief
                  </Button>
                  <Button variant="ghost" data-testid="prepared-brief-clear-cancel" className="h-6 rounded-md px-2 text-xs text-muted-foreground" onClick={() => setConfirmClear(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  data-testid="prepared-brief-clear"
                  className="h-6 rounded-md px-2 text-xs text-muted-foreground"
                  disabled={!enabled || pending}
                  onClick={() => setConfirmClear(true)}
                >
                  Clear
                </Button>
              )}
            </span>
          ) : null
        }
      >
        Prepared brief
      </Label>
      <p data-testid="prepared-brief-provenance" className="mb-1.5 text-xs text-faint">
        Prepared research · observed {observedDate(brief.observedOn)} · not verified by Callie
      </p>

      {open ? (
        <div data-testid="prepared-brief-editor" className="flex flex-col gap-1.5">
          <Textarea
            data-testid="prepared-brief-text-input"
            aria-label="Prepared brief"
            rows={8}
            maxLength={4000}
            readOnly={pending}
            value={text ?? ''}
            onChange={event => drafts.set(key.text, event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeEditor();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" data-testid="prepared-brief-save" disabled={!enabled || pending || !dirty} onClick={save}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" data-testid="prepared-brief-close" onClick={closeEditor}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p
            data-testid="prepared-brief-text"
            className={folded ? 'line-clamp-6 text-sm whitespace-pre-line' : 'text-sm whitespace-pre-line'}
          >
            {brief.brief}
          </p>
          {long ? (
            <button
              type="button"
              data-testid="prepared-brief-more"
              aria-expanded={expanded}
              className="mt-0.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          ) : null}
        </>
      )}

      {feedback === '' ? null : (
        <p data-testid="prepared-brief-feedback" role="status" className="mt-1 text-xs text-muted-foreground">
          {feedbackSentence(feedback)}
        </p>
      )}

      {brief.sources.length === 0 ? null : (
        <ul data-testid="prepared-brief-sources" className="mt-2 flex flex-col gap-0.5">
          {brief.sources.map(source => (
            <li key={source.url} className="text-xs">
              {isHttpsUrl(source.url) ? (
                <a
                  data-testid="prepared-brief-source"
                  href={source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {source.label}
                  <span className="text-faint"> · {source.url.replace(/^https:\/\//u, '').split('/')[0]}</span>
                </a>
              ) : (
                <span data-testid="prepared-brief-source-unlinked" className="text-muted-foreground">
                  {source.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
