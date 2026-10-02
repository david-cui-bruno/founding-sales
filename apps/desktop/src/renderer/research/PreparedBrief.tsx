import { useEffect, useState, type JSX } from 'react';
import { reasonSentence, type PreparedBriefDto } from '@fss/contracts';
import type { OperationInput, OperationOutput } from '../../shared/operations.ts';
import { useDrafts, useSessionEpoch } from '../app/drafts.tsx';
import { shortDate } from '../researchView.ts';
import { Button } from '../ui/button.tsx';
import { Textarea } from '../ui/textarea.tsx';
import { Label } from '../v2/parts.tsx';
import { usePatchPreparedBrief } from './patchPreparedBrief.ts';

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
 *     keeps both, with the reason next to the editor;
 *   * **K7 (design reset I2)** — a success answers the firm's stored brief, which is patched
 *     into the cached data of that firm only (`patchPreparedBrief.ts`); nothing is read again
 *     and no firm is opened, so a late answer cannot undo a navigation.
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
  setBrief = defaultSet,
  clearBrief = defaultClear,
}: {
  readonly firmId: string;
  /** The firm's prepared brief, or null; undefined when the read did not carry one (an older API). */
  readonly brief: PreparedBriefDto | null | undefined;
  /** Administrators edit and clear. */
  readonly canEdit: boolean;
  readonly enabled: boolean;
  readonly setBrief?: SetBrief;
  readonly clearBrief?: ClearBrief;
}): JSX.Element | null {
  const drafts = useDrafts();
  const session = useSessionEpoch() ?? FALLBACK_SESSION;
  const patch = usePatchPreparedBrief();
  const keysOf = (target: string) => {
    const at = `prepared-brief:${target}:`;
    return { text: `${at}text`, base: `${at}base`, open: `${at}open`, pending: `${at}pending`, feedback: `${at}feedback` };
  };
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
  /** The firm whose Clear is waiting for its confirmation (K1: keyed by firm, reset when it changes). */
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const confirmClear = confirmFor === firmId;

  // A firm change ends any confirmation and takes focus off this section's controls, so a key
  // pressed next (J, then Enter) cannot reach a command meant for the firm before (K1/K4).
  useEffect(() => {
    setConfirmFor(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[data-prepared-brief]') !== null) active.blur();
  }, [firmId]);
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

  /** `run` answers its code, and on success the firm's stored brief, which is patched in (I2). */
  const send = (target: string, run: () => Promise<{ readonly code: string; readonly brief?: PreparedBriefDto | null }>, onSuccess: () => void): void => {
    const keys = keysOf(target);
    nextToken += 1;
    const token = String(nextToken);
    const commands = latestCommand.get(session) ?? new Map<string, string>();
    latestCommand.set(session, commands);
    commands.set(target, token);
    drafts.set(keys.pending, token);
    drafts.set(keys.feedback, '');
    void run()
      .then(
        answer => answer,
        (): { readonly code: string; readonly brief?: PreparedBriefDto | null } => ({ code: 'offline' }),
      )
      .then(({ code, brief: stored }) => {
        // K3: only this firm's latest command settles it; an older answer is dropped.
        if (commands.get(target) !== token) return;
        commands.delete(target);
        drafts.set(keys.pending, '');
        drafts.set(keys.feedback, code);
        if (code === 'saved' || code === 'cleared') {
          onSuccess();
          // Design reset I2: a pure patch of THAT firm's cached data. No read, no expand, no open.
          if (stored !== undefined) patch(target, stored);
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
    const target = firmId;
    const keys = key;
    send(
      target,
      async () => {
        const answer = await setBrief({ firmId: target, brief: sent });
        return answer.saved === null ? { code: answer.reason ?? 'offline' } : { code: 'saved', brief: answer.saved.brief };
      },
      () => {
        // K5: the draft goes only now. The editor is read-only while the save is in flight,
        // so the draft is still the text that was sent.
        drafts.set(keys.text, '');
        drafts.set(keys.base, '');
        drafts.set(keys.open, '');
      },
    );
  };

  /** The confirmation's own firm, carried on its button: the command names that firm and no other. */
  const clear = (target: string | undefined): void => {
    setConfirmFor(null);
    if (pending || target === undefined || target === '') return;
    const keys = keysOf(target);
    send(
      target,
      async () => {
        const answer = await clearBrief({ firmId: target });
        return answer.reason === null ? { code: 'cleared', brief: null } : { code: answer.reason };
      },
      () => {
        drafts.set(keys.text, '');
        drafts.set(keys.base, '');
        drafts.set(keys.open, '');
      },
    );
  };

  if (brief === null) {
    return (
      <section data-testid="prepared-brief" data-prepared-brief="" className="py-2">
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
    <section data-testid="prepared-brief" data-prepared-brief="" className="group/prepared">
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
                  <Button
                    variant="ghost"
                    data-testid="prepared-brief-clear-confirm"
                    data-firm-id={firmId}
                    className="h-6 rounded-md px-2 text-xs"
                    disabled={!enabled || pending}
                    onClick={event => clear(event.currentTarget.dataset['firmId'])}
                  >
                    Clear brief
                  </Button>
                  <Button variant="ghost" data-testid="prepared-brief-clear-cancel" className="h-6 rounded-md px-2 text-xs text-muted-foreground" onClick={() => setConfirmFor(null)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  data-testid="prepared-brief-clear"
                  className="h-6 rounded-md px-2 text-xs text-muted-foreground"
                  disabled={!enabled || pending}
                  onClick={() => setConfirmFor(firmId)}
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
