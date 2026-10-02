import type { ReviewItem } from '@fss/contracts';
import { AlertCircle, X } from 'lucide-react';
import { useState, type JSX } from 'react';
import { cn } from '../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Block, Label, dense } from '../v2/parts.tsx';
import type { TodayCard } from '../todayContract.ts';
import { BasicsEditor, type BasicsField, type BasicsValues } from './BasicsEditor.tsx';
import { evidenceLines } from './afterCallModel.ts';

/**
 * Needs review (slice 3a, lane C; DESIGN-S3A §2.4): the group in the Queue, and each item's
 * facts, evidence and **inline correction** in the call panel of the firm it is about.
 *
 *   * the group lists the server's items (`GET /review`) as rows: what it is, which firm, and
 *     **Dismiss**; choosing a row opens that firm, where the item is drawn in full;
 *   * a correction opens **in place**, never navigates, closes on a second click or on Escape,
 *     and keeps its draft (`BasicsEditor`'s draft is above the route);
 *   * a pending hold is worded from what it is — "Waiting for this call's notes" — never as
 *     paused calling, and offers **Log** or **Dismiss**;
 *   * a stage item resolves by id, and **resolving an item never blocks the queue**.
 *
 * `mode` is data: a review proposal has no Apply anywhere on this surface.
 */

const api = (): NonNullable<typeof globalThis.callieApi> | undefined => globalThis.callieApi;

export function itemKey(item: ReviewItem): string {
  if (item.source === 'pending_hold') return `hold:${item.holdId}`;
  if (item.source === 'stage') return `stage:${item.itemId}`;
  return `proposal:${item.analysisId}:${item.proposal.key}`;
}

const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  outcome_unclear: 'The outcome is unclear',
  corrected_number: 'The number may be wrong',
  stop_scope: 'Asked to stop: how wide?',
  stop_with_email: 'Asked to stop, but wants an e-mail',
  follow_up_expired: 'E-mail request: over 7 days',
  referral_contact: 'Referred to someone',
  callback_zone_unknown: 'Callback: time zone unknown',
  buying_signal: 'Possible buying signal: not confirmed',
  follow_up: 'E-mail request: not confirmed',
  callback: 'Callback: not confirmed',
  outcome: 'Outcome: not confirmed',
});

export function itemLabel(item: ReviewItem): string {
  if (item.source === 'pending_hold') return 'Waiting for this call’s notes';
  if (item.source === 'stage') return 'A stage change needs a look';
  return KIND_LABELS[item.reviewKind] ?? item.proposal.reason;
}

export function itemFirmId(item: ReviewItem): string | null {
  return item.firmId;
}

/** Dismiss, by what the item is: a decline, a hold released, a stage item resolved. */
async function dismissItem(item: ReviewItem): Promise<{ readonly ok: boolean; readonly reason: string | null }> {
  const bridge = api();
  if (bridge === undefined) return { ok: false, reason: 'offline' };
  if (item.source === 'pending_hold') {
    const answer = await bridge.command('calling.pendingDismiss', { callSessionId: item.callSessionId });
    return { ok: answer.dismissed, reason: answer.reason };
  }
  if (item.source === 'stage') {
    const answer = await bridge.command('review.stageResolve', { itemId: item.itemId });
    return { ok: answer.resolved, reason: answer.reason };
  }
  const answer = await bridge.command('calling.proposalsDecline', {
    analysisId: item.analysisId,
    proposalHash: item.proposalHash,
    keys: [item.proposal.key],
  });
  return { ok: answer.declined, reason: answer.reason };
}

/** The group in the Queue: one row per item, in the server's order. Never in the J/K walk. */
export function ReviewGroup({
  items,
  cards,
  selected,
  onSelect,
  onChanged,
}: {
  readonly items: readonly ReviewItem[];
  readonly cards: readonly TodayCard[];
  readonly selected: string | null;
  onSelect(firmId: string): void;
  onChanged(): void;
}): JSX.Element | null {
  const [notes, setNotes] = useState<Readonly<Record<string, string>>>({});
  // Only the row that was chosen is current: a firm can have several items.
  const [active, setActive] = useState<string | null>(null);
  if (items.length === 0) return null;
  const nameOf = (firmId: string | null): string => cards.find(card => card.firmId === firmId)?.firmName ?? 'A firm not on today’s list';
  return (
    <div data-testid="queue-group" data-group="review" className="mb-3">
      <h3 className="flex h-7 items-center justify-between px-2 text-xs font-medium text-muted-foreground">
        <span data-testid="queue-group-label">Needs review</span>
        <span data-testid="queue-group-count" className="text-faint tabular">
          {items.length}
        </span>
      </h3>
      <ul className="flex flex-col gap-px">
        {items.map(item => {
          const key = itemKey(item);
          const firmId = itemFirmId(item);
          const current = firmId !== null && firmId === selected && active === key;
          return (
            <li key={key} className="group/review relative">
              <button
                type="button"
                data-testid="review-row"
                data-source={item.source}
                aria-current={current ? 'true' : undefined}
                disabled={firmId === null}
                onClick={() => {
                  setActive(key);
                  if (firmId !== null) onSelect(firmId);
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2 py-1.5 pr-14 text-left transition-colors hover:bg-pressed',
                  current && 'bg-selected',
                )}
              >
                <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-warn-ink" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span data-testid="review-firm" className="truncate text-sm">
                    {nameOf(firmId)}
                  </span>
                  <span data-testid="review-label" className="truncate text-xs text-muted-foreground">
                    {itemLabel(item)}
                  </span>
                  {notes[key] === undefined ? null : (
                    <span data-testid="review-note" role="status" className="truncate text-xs text-danger-ink">
                      {notes[key]}
                    </span>
                  )}
                </span>
              </button>
              <Button
                variant="ghost"
                data-testid="review-dismiss"
                aria-label="Dismiss"
                className={cn(dense.sm, 'absolute top-1.5 right-1 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/review:opacity-100')}
                onClick={() => {
                  void dismissItem(item).then(
                    result => {
                      if (result.ok) onChanged();
                      else setNotes(current => ({ ...current, [key]: 'Could not dismiss that. Nothing was changed.' }));
                    },
                    () => setNotes(current => ({ ...current, [key]: 'Could not dismiss that. Nothing was changed.' })),
                  );
                }}
              >
                <X /> Dismiss
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type Editor = 'phone' | 'timeZone' | 'stop';

/** The firm the items are about, as the call panel knows it. */
export interface ReviewFirm {
  readonly firmId: string;
  readonly values: BasicsValues;
  readonly phone: { readonly routeId: string; readonly e164: string } | null;
  readonly enabled: boolean;
  /** Calls of this firm that have a log, by session. */
  readonly loggedSessions: ReadonlySet<string>;
}

function ItemCard({
  item,
  firm,
  onChanged,
  onLog,
}: {
  readonly item: ReviewItem;
  readonly firm: ReviewFirm;
  onChanged(): void;
  onLog(callSessionId: string): void;
}): JSX.Element {
  const key = itemKey(item);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const toggle = (next: Editor): void => setEditor(editor === next ? null : next);
  const proposal = item.source === 'proposal' ? item.proposal : null;
  const logged = item.source !== 'stage' && firm.loggedSessions.has(item.callSessionId);

  const logIt = (): void => {
    if (item.source !== 'stage') onLog(item.callSessionId);
  };
  const dismiss = (): void => {
    void dismissItem(item).then(
      result => {
        if (result.ok) onChanged();
        else setNote('Could not dismiss that. Nothing was changed.');
      },
      () => setNote('Could not dismiss that. Nothing was changed.'),
    );
  };
  const stop = (): void => {
    const bridge = api();
    if (bridge === undefined) return;
    void bridge.command('suppressions.firmStop', { firmId: firm.firmId }).then(
      answer => {
        if (answer.stopped) {
          setEditor(null);
          setNote('Stopped: nobody at this firm will be contacted.');
          onChanged();
        } else setNote('Could not record the stop. Nothing was changed.');
      },
      () => setNote('Could not record the stop. Nothing was changed.'),
    );
  };

  const editors = (field: BasicsField): JSX.Element => (
    <BasicsEditor
      firmId={firm.firmId}
      values={firm.values}
      phone={firm.phone}
      focus={field}
      enabled={firm.enabled}
      onSaved={() => {
        setEditor(null);
        onChanged();
      }}
      onCancel={() => setEditor(null)}
    />
  );

  return (
    <li
      data-testid="review-item"
      data-source={item.source}
      data-kind={item.source === 'proposal' ? item.reviewKind : item.source}
      className="flex flex-col gap-1.5 border-b border-border py-2.5 last:border-b-0"
      onKeyDown={event => {
        // Escape closes an open correction and keeps its draft; it never discards.
        if (event.key === 'Escape' && editor !== null) {
          event.stopPropagation();
          setEditor(null);
        }
      }}
    >
      <p data-testid="review-item-label" className="text-sm font-medium">
        {itemLabel(item)}
      </p>

      {item.source === 'pending_hold' ? (
        <>
          <p className="text-xs text-muted-foreground">Callie is still waiting for this call’s notes. Calling is not stopped; e-mail and sequence steps for this firm wait.</p>
          <div className="flex gap-2">
            <Button variant="outline" data-testid="review-log" className={dense.md} onClick={logIt}>
              Log
            </Button>
            <Button variant="ghost" data-testid="review-item-dismiss" className={cn(dense.md, 'text-muted-foreground')} onClick={dismiss}>
              Dismiss
            </Button>
          </div>
        </>
      ) : null}

      {item.source === 'stage' ? (
        <>
          <p data-testid="review-stage-evidence" className="text-xs text-muted-foreground">
            Evidence: {item.evidenceKind}. {item.reason.replace(/_/gu, ' ')}.
          </p>
          <Button variant="outline" data-testid="review-item-dismiss" className={cn(dense.md, 'self-start')} onClick={dismiss}>
            Dismiss
          </Button>
        </>
      ) : null}

      {proposal === null ? null : (
        <>
          <p data-testid="review-reason" className="text-xs text-muted-foreground">
            {proposal.reason}
          </p>
          <ul data-testid="review-evidence" className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {evidenceLines(proposal).map(line => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          {proposal.kind === 'corrected_number' ? (
            <>
              <div className="flex items-center gap-2 text-sm">
                <span>They gave:</span>
                <span data-testid="review-spoken-number" className="font-mono tabular">
                  {proposal.params.spokenNumber}
                </span>
                <Button
                  variant="ghost"
                  data-testid="review-copy"
                  className={dense.sm}
                  onClick={() => {
                    void navigator.clipboard?.writeText(proposal.params.spokenNumber);
                    setCopied(true);
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <Button variant="outline" data-testid="review-correct-phone" aria-expanded={editor === 'phone'} className={cn(dense.md, 'self-start')} onClick={() => toggle('phone')}>
                Correct the number
              </Button>
              {editor === 'phone' ? editors('phone') : null}
            </>
          ) : null}

          {proposal.kind === 'outcome' && proposal.params.outcome === 'wrong_number' ? (
            <>
              <p className="text-xs text-muted-foreground">The call is logged as something else, but they said this was the wrong number. Correct the number so Callie stops using it.</p>
              <Button variant="outline" data-testid="review-correct-phone" aria-expanded={editor === 'phone'} className={cn(dense.md, 'self-start')} onClick={() => toggle('phone')}>
                Correct the number
              </Button>
              {editor === 'phone' ? editors('phone') : null}
            </>
          ) : null}

          {proposal.kind === 'callback_zone_unknown' ? (
            <>
              <p className="text-xs text-muted-foreground">Set the firm’s time zone, then apply the callback above.</p>
              <Button variant="outline" data-testid="review-correct-zone" aria-expanded={editor === 'timeZone'} className={cn(dense.md, 'self-start')} onClick={() => toggle('timeZone')}>
                Set the time zone
              </Button>
              {editor === 'timeZone' ? editors('timeZone') : null}
            </>
          ) : null}

          {proposal.kind === 'stop_scope' ? (
            logged ? (
              <>
                <Button variant="outline" data-testid="review-stop" aria-expanded={editor === 'stop'} className={cn(dense.md, 'self-start')} onClick={() => toggle('stop')}>
                  Stop all contact with this firm
                </Button>
                {editor === 'stop' ? (
                  <div data-testid="review-stop-confirm" className="flex flex-col gap-2 rounded-md border border-border bg-warn-soft/40 p-2.5">
                    <p className="text-xs">Callie will not call or e-mail anyone at this firm again. This is recorded as a firm-wide stop.</p>
                    <div className="flex gap-2">
                      <Button data-testid="review-stop-confirm-button" className={dense.md} onClick={stop}>
                        Confirm: stop all contact
                      </Button>
                      <Button variant="ghost" className={dense.md} onClick={() => setEditor(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p data-testid="review-stop-unlogged" className="text-xs text-muted-foreground">
                This call has no log yet: tick “Stop” in the suggestions and choose whether it covers all contact.
              </p>
            )
          ) : null}

          {proposal.kind === 'referral_contact' ? (
            <p data-testid="review-referral" className="text-sm">
              {proposal.params.name}
              {proposal.params.role === null ? '' : `, ${proposal.params.role}`}
              <span className="block text-xs text-muted-foreground">Add them from the firm’s page; there is no way to add a contact from here.</span>
            </p>
          ) : null}

          {proposal.kind === 'outcome_unclear' ? (
            <Button variant="outline" data-testid="review-set-outcome" className={cn(dense.md, 'self-start')} onClick={logIt}>
              Set the outcome
            </Button>
          ) : null}

          <Button variant="ghost" data-testid="review-item-dismiss" className={cn(dense.md, 'self-start text-muted-foreground')} onClick={dismiss}>
            Dismiss
          </Button>
        </>
      )}
      {note === null ? null : (
        <p data-testid={`review-item-note`} data-item={key} role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
    </li>
  );
}

/** The open firm's Needs review items, in full, inside the call panel. */
export function ReviewPanel({
  items,
  firm,
  onChanged,
  onLog,
}: {
  readonly items: readonly ReviewItem[];
  readonly firm: ReviewFirm;
  onChanged(): void;
  /** Log this item's call, by its own session: never "the last call". */
  onLog(callSessionId: string): void;
}): JSX.Element | null {
  const mine = items.filter(item => itemFirmId(item) === firm.firmId);
  if (mine.length === 0) return null;
  return (
    <Block data-testid="review-panel" className="py-0">
      <Label>Needs review</Label>
      <ul className="flex flex-col">
        {mine.map(item => (
          <ItemCard key={itemKey(item)} item={item} firm={firm} onChanged={onChanged} onLog={onLog} />
        ))}
      </ul>
    </Block>
  );
}
