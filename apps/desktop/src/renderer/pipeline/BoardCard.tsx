import { CalendarDays, CircleDot } from 'lucide-react';
import { useState, type JSX } from 'react';
import type { BoardCard as BoardCardData, FirmIdentityDto } from '@fss/contracts';
import type { PipelineStageDto } from '@fss/contracts';
import { useKeptText, type CardEditor, type CardFeedback } from '../firms/crmMemory.ts';
import type { StageChange, ValueChange } from '../firmWorkspaceContract.ts';
import { noticeText, stageChangeSubmittable } from '../firmWorkspaceView.ts';
import { cn } from '../lib/utils.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Select } from '../ui/select.tsx';
import { Chip } from '../v2/parts.tsx';
import { evidencePhrase, fullTimeOf, meetingLabel, nextActionLabel, valueLabel } from './cardText.ts';
import { ValueDialog } from './ValueDialog.tsx';

/**
 * One card on the board (slice K, re-skinned for S4): the firm and its place, the next
 * action, the meeting, the value; the evidence of an automatic move; a Pinned marker for a
 * manual one. Its actions are quiet until the card is under the pointer or has focus.
 *
 * Which editor is open is kept by the caller (`CardEditor`), and what was typed in it is
 * kept text above the route, so closing an editor - a second click on its button, or
 * Escape - never discards the draft, and a refusal is said on the card it belongs to.
 */

/** What an automatic move looks like on the card: "Moved to Demo booked · booking on Oct 3 (Cal.com)". */
export function evidenceLine(card: BoardCardData, stageName: string): string | null {
  if (card.evidence === null) return null;
  return `Moved to ${stageName} · ${evidencePhrase(card.evidence.kind, card.evidence.occurredAt)}`;
}

function EvidencePopover({
  card,
  line,
  fromName,
}: {
  readonly card: BoardCardData;
  readonly line: string;
  readonly fromName: string | null;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (card.evidence === null) return null;
  return (
    <div className="relative">
      <button
        type="button"
        data-testid="card-evidence"
        aria-expanded={open}
        className="text-left text-xs text-muted-foreground underline-offset-2 hover:underline"
        onClick={() => {
          setOpen(!open);
        }}
        onKeyDown={event => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {line}
      </button>
      {open ? (
        <dl data-testid="card-evidence-popover" className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 border-t border-border pt-1.5 text-xs">
          <dt className="text-muted-foreground">Kind</dt>
          <dd data-testid="evidence-kind">{card.evidence.kind}</dd>
          <dt className="text-muted-foreground">When</dt>
          <dd data-testid="evidence-when">{fullTimeOf(card.evidence.occurredAt)}</dd>
          {fromName === null ? null : (
            <>
              <dt className="text-muted-foreground">From</dt>
              <dd>{fromName}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Evidence id</dt>
          <dd data-testid="evidence-id" className="break-all">
            {card.evidence.evidenceId}
          </dd>
        </dl>
      ) : null}
    </div>
  );
}

function MoveTo({
  opportunityId,
  stages,
  currentStageKey,
  actionsEnabled,
  busy,
  onChangeStage,
  onDone,
}: {
  readonly opportunityId: string;
  readonly stages: readonly PipelineStageDto[];
  readonly currentStageKey: string | null;
  readonly actionsEnabled: boolean;
  readonly busy: boolean;
  onChangeStage(change: StageChange): void;
  onDone(): void;
}): JSX.Element {
  const [toStageKey, setToStageKey] = useKeptText(`move:${opportunityId}:to`);
  const [reason, setReason] = useKeptText(`move:${opportunityId}:reason`);
  const terminalKindOf = (key: string): 'won' | 'lost' | null => stages.find(s => s.key === key)?.terminalKind ?? null;
  const losing = terminalKindOf(toStageKey) === 'lost';
  const submittable = stageChangeSubmittable({ toStageKey, terminalKindOf, reason, actionsEnabled });
  return (
    <div data-testid="move-to-panel" className="mt-1 flex flex-col gap-1 border-t border-border pt-2">
      <Select
        data-testid="stage-select"
        aria-label="Move to"
        disabled={!actionsEnabled}
        value={toStageKey}
        onChange={event => {
          setToStageKey(event.target.value);
        }}
        className="h-7 text-xs"
      >
        <option value="">Move to…</option>
        {stages
          // Retired stages are never a destination; the stage it is already in is not one either.
          .filter(s => !s.retired && s.key !== currentStageKey)
          .map(s => (
            <option key={s.key} value={s.key}>
              {s.displayName}
            </option>
          ))}
      </Select>
      {losing ? (
        <Input
          data-testid="stage-reason"
          placeholder="Why was it lost?"
          autoComplete="off"
          disabled={!actionsEnabled || busy}
          value={reason}
          onChange={event => {
            setReason(event.target.value);
          }}
          className="h-7 text-xs"
        />
      ) : null}
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="quiet" data-testid="stage-cancel" onClick={onDone}>
          Close
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid="stage-submit"
          disabled={!submittable || busy}
          onClick={() => {
            onChangeStage({ opportunityId, toStageKey, reason: reason.trim() === '' ? null : reason.trim() });
            onDone();
          }}
        >
          Move
        </Button>
      </div>
    </div>
  );
}

/** "Chicago, TX" from what the board knows; nothing when it knows neither. */
export const placeOf = (firm: Pick<FirmIdentityDto, 'locality' | 'regionCode'>): string | null => {
  const text = [firm.locality, firm.regionCode].filter((part): part is string => part !== null && part !== '').join(', ');
  return text === '' ? null : text;
};

/** The sentence next to a card for its last command: a refusal, or the quiet success. */
export const feedbackText = (feedback: CardFeedback): string => noticeText(feedback.code);

export function BoardCard({
  firm,
  dealLabel,
  card,
  stage,
  stages,
  opportunityId,
  actionsEnabled,
  stageBusy,
  valueBusy,
  onChangeStage,
  onSetValue,
  onOpenFirm,
  now = new Date(),
  selected = false,
  editor,
  onEditor,
  feedback,
}: {
  readonly firm: FirmIdentityDto;
  readonly dealLabel?:string;
  readonly card: BoardCardData | undefined;
  readonly stage: PipelineStageDto;
  readonly stages: readonly PipelineStageDto[];
  /** Present only for a firm this caller may change, and only while it is open. */
  readonly opportunityId: string | undefined;
  readonly actionsEnabled: boolean;
  readonly stageBusy: boolean;
  readonly valueBusy: boolean;
  onChangeStage(change: StageChange): void;
  onSetValue(change: ValueChange): void;
  onOpenFirm(firmId: string): void;
  /** The instant "overdue" is judged against; the clock unless a test says otherwise. */
  readonly now?: Date;
  /** This card's firm is open in the side panel. */
  readonly selected?: boolean;
  /** Which editor is open on this card. Absent: the card keeps it itself (a standalone card). */
  readonly editor?: CardEditor | null;
  onEditor?(next: CardEditor | null): void;
  /** What this card's last stage or value command answered. */
  readonly feedback?: CardFeedback | undefined;
}): JSX.Element {
  const [ownEditor, setOwnEditor] = useState<CardEditor | null>(null);
  const panel = editor !== undefined ? editor : ownEditor;
  const setPanel = (next: CardEditor | null): void => {
    if (onEditor !== undefined) onEditor(next);
    else setOwnEditor(next);
  };
  const nameOf = (key: string): string => stages.find(s => s.key === key)?.displayName ?? key;
  const line = card === undefined ? null : evidenceLine(card, stage.displayName);
  const fromKey = card?.evidence?.fromStageKey ?? null;
  // A Lost card's reason is what matters on it; the closed opportunity has no actions.
  const lost = stage.terminalKind === 'lost';
  const canAct = opportunityId !== undefined;
  const place = placeOf(firm);
  const overdue = card?.nextAction != null && Date.parse(card.nextAction.dueAt) < now.getTime();
  const suggestion = card?.stageSuggestion ?? null;
  const suggested =
    suggestion !== null && !lost && opportunityId !== undefined && suggestion.opportunityId === opportunityId
      ? { opportunityId, stageKey: suggestion.stageKey, expectedStageKey: suggestion.fromStageKey ?? stage.key }
      : null;

  return (
    <li
      data-testid="pipeline-firm"
      data-firm-id={firm.id}
      {...(selected ? { 'aria-current': 'true' as const } : {})}
      onKeyDown={event => {
        // Escape closes the editor and keeps what was typed; it never discards (criterion 2).
        if (event.key === 'Escape' && panel !== null) {
          event.stopPropagation();
          setPanel(null);
        }
      }}
      className={cn(
        'group relative flex flex-col gap-1.5 rounded-lg border bg-background p-2.5 transition-[box-shadow,border-color]',
        selected ? 'border-link/60 shadow-md' : 'border-border hover:border-strong hover:shadow-sm focus-within:border-strong',
      )}
    >
      {dealLabel===undefined?null:<p className="text-sm font-medium">{dealLabel}</p>}
      <div className="flex items-start justify-between gap-2">
        <Button
          variant="link"
          size="sm"
          data-testid="pipeline-open-firm"
          title={firm.name}
          className="h-auto min-w-0 justify-start px-0 text-left text-sm font-medium whitespace-normal"
          onClick={() => {
            onOpenFirm(firm.id);
          }}
        >
          <span className="line-clamp-2">{firm.name}</span>
        </Button>
        {card?.pinned === true ? (
          <Chip tone="outline" data-testid="card-pinned" title="A person placed this card here. Only a person moves it on.">
            Pinned
          </Chip>
        ) : null}
      </div>
      {place === null ? null : (
        <p data-testid="card-place" className="-mt-1 text-xs text-faint">
          {place}
        </p>
      )}
      {card?.nextAction == null ? null : (
        <p
          data-testid="card-next-action"
          {...(overdue ? { 'data-overdue': 'true' } : {})}
          className={cn('flex min-w-0 items-center gap-1.5 text-xs', overdue ? 'text-destructive' : 'text-muted-foreground')}
        >
          <CircleDot className="size-3 shrink-0 text-faint" aria-hidden />
          <span className="min-w-0 truncate">{nextActionLabel(card.nextAction, firm.timeZone)}</span>
        </p>
      )}
      {card?.meeting == null ? null : (
        <p data-testid="card-meeting" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarDays className="size-3 shrink-0 text-faint" aria-hidden />
          <span className="min-w-0 truncate">{meetingLabel(card.meeting)}</span>
        </p>
      )}
      {/* Lane M1: a booking no longer moves the deal; the move is offered, one click, through
          the ordinary stage command (and its per-card pending answer). Only for the deal this
          person may move. */}
      {suggested !== null ? (
        <Button
          size="sm"
          variant="quiet"
          data-testid="card-stage-suggestion"
          className="-ml-2 h-6 justify-start text-xs text-muted-foreground hover:text-foreground"
          disabled={!actionsEnabled || stageBusy}
          {...(stageBusy ? { 'aria-busy': true } : {})}
          onClick={() => {
            // The stage the card was read at goes with it: a deal moved since is refused (lane M1).
            onChangeStage({ opportunityId: suggested.opportunityId, toStageKey: suggested.stageKey, reason: null, expectedStageKey: suggested.expectedStageKey });
          }}
        >
          Move to {nameOf(suggested.stageKey)}
        </Button>
      ) : null}
      <p data-testid="card-value" className="border-t border-border pt-1.5 text-xs tabular-nums">
        {card?.value == null ? <span className="text-faint">No value yet</span> : valueLabel(card.value)}
      </p>
      {lost ? (
        <p data-testid="card-close-reason" className="text-xs text-muted-foreground">
          {card?.closeReason == null || card.closeReason === '' ? 'No reason recorded' : card.closeReason}
        </p>
      ) : null}
      {card !== undefined && line !== null ? (
        <EvidencePopover card={card} line={line} fromName={fromKey === null ? null : nameOf(fromKey)} />
      ) : null}
      {canAct && !lost ? (
        <div
          className={cn(
            'flex items-center gap-0.5 transition-opacity',
            // At rest the actions float over the card's corner so it keeps its height; with an
            // editor open they sit in the flow above it, so nothing is covered.
            panel === null
              ? 'absolute right-1.5 bottom-1.5 rounded-md bg-background/95 opacity-0 shadow-sm group-hover:opacity-100 group-focus-within:opacity-100'
              : '-ml-2',
          )}
        >
          <Button
            size="sm"
            variant="quiet"
            data-testid="card-move"
            aria-expanded={panel === 'move'}
            disabled={!actionsEnabled}
            onClick={() => {
              setPanel(panel === 'move' ? null : 'move');
            }}
          >
            Move to…
          </Button>
          <Button
            size="sm"
            variant="quiet"
            data-testid="card-set-value"
            aria-expanded={panel === 'value'}
            disabled={!actionsEnabled}
            onClick={() => {
              setPanel(panel === 'value' ? null : 'value');
            }}
          >
            Set value…
          </Button>
        </div>
      ) : null}
      {canAct && !lost && panel === 'move' ? (
        <MoveTo
          opportunityId={opportunityId}
          stages={stages}
          currentStageKey={firm.stageKey}
          actionsEnabled={actionsEnabled}
          busy={stageBusy}
          onChangeStage={onChangeStage}
          onDone={() => {
            setPanel(null);
          }}
        />
      ) : null}
      {canAct && !lost && panel === 'value' ? (
        <ValueDialog
          opportunityId={opportunityId}
          firmName={firm.name}
          initial={card?.value ?? null}
          busy={valueBusy}
          onSave={change => {
            onSetValue(change);
            setPanel(null);
          }}
          onCancel={() => {
            setPanel(null);
          }}
        />
      ) : null}
      {feedback === undefined ? null : (
        <p
          data-testid="card-feedback"
          role="status"
          className={cn('text-xs', feedback.code === 'stage_changed' || feedback.code === 'value_recorded' ? 'text-muted-foreground' : 'text-destructive')}
        >
          {feedbackText(feedback)}
        </p>
      )}
    </li>
  );
}
