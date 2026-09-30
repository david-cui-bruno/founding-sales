import { useState, type JSX } from 'react';
import type { BoardCard as BoardCardData, FirmIdentityDto } from '@fss/contracts';
import type { PipelineStageDto } from '@fss/contracts';
import type { StageChange, ValueChange } from '../firmWorkspaceContract.ts';
import { stageChangeSubmittable } from '../firmWorkspaceView.ts';
import { Button } from '../ui/button.tsx';
import { Input } from '../ui/input.tsx';
import { Select } from '../ui/select.tsx';
import { Tag } from '../ui/layout.tsx';
import { evidencePhrase, fullTimeOf, meetingLabel, nextActionLabel, valueLabel } from './cardText.ts';
import { ValueDialog } from './ValueDialog.tsx';

/**
 * One card on the board (slice K): the firm, the next action, the meeting, the value; the
 * evidence of an automatic move; a Pinned marker for a manual one. Its actions are quiet
 * until the card is under the pointer or has focus.
 */

/** What an automatic move looks like on the card: "Moved to Demo booked \u00b7 booking on Oct 3 (Cal.com)". */
export function evidenceLine(card: BoardCardData, stageName: string): string | null {
  if (card.evidence === null) return null;
  return `Moved to ${stageName} \u00b7 ${evidencePhrase(card.evidence.kind, card.evidence.occurredAt)}`;
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
      >
        {line}
      </button>
      {open ? (
        <dl data-testid="card-evidence-popover" className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded-md border border-border bg-background p-2 text-xs shadow-sm">
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
  const [toStageKey, setToStageKey] = useState('');
  const [reason, setReason] = useState('');
  const terminalKindOf = (key: string): 'won' | 'lost' | null => stages.find(s => s.key === key)?.terminalKind ?? null;
  const losing = terminalKindOf(toStageKey) === 'lost';
  const submittable = stageChangeSubmittable({ toStageKey, terminalKindOf, reason, actionsEnabled });
  return (
    <div data-testid="move-to-panel" className="mt-2 flex flex-col gap-1 rounded-md border border-border bg-background p-2 shadow-sm">
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
          Cancel
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

export function BoardCard({
  firm,
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
}: {
  readonly firm: FirmIdentityDto;
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
}): JSX.Element {
  const [panel, setPanel] = useState<'none' | 'move' | 'value'>('none');
  const nameOf = (key: string): string => stages.find(s => s.key === key)?.displayName ?? key;
  const line = card === undefined ? null : evidenceLine(card, stage.displayName);
  const fromKey = card?.evidence?.fromStageKey ?? null;
  // A Lost card's reason is what matters on it; the closed opportunity has no actions.
  const lost = stage.terminalKind === 'lost';
  const canAct = opportunityId !== undefined;

  return (
    <li
      data-testid="pipeline-firm"
      data-firm-id={firm.id}
      className="group flex flex-col gap-1 border-b border-border px-2 py-2 last:border-b-0 hover:bg-accent/40 focus-within:bg-accent/40"
    >
      <div className="flex items-start justify-between gap-2">
        <Button
          variant="link"
          size="sm"
          data-testid="pipeline-open-firm"
          className="h-auto min-w-0 justify-start px-0 text-left text-sm font-medium whitespace-normal"
          onClick={() => {
            onOpenFirm(firm.id);
          }}
        >
          {firm.name}
        </Button>
        {card?.pinned === true ? (
          <Tag data-testid="card-pinned" title="A person placed this card here; automatic moves only go forward from it.">
            Pinned
          </Tag>
        ) : null}
      </div>
      {card?.nextAction == null ? null : (
        <p
          data-testid="card-next-action"
          {...(Date.parse(card.nextAction.dueAt) < now.getTime() ? { 'data-overdue': 'true' } : {})}
          className={Date.parse(card.nextAction.dueAt) < now.getTime() ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
        >
          {nextActionLabel(card.nextAction, firm.timeZone)}
        </p>
      )}
      {card?.meeting == null ? null : (
        <p data-testid="card-meeting" className="text-xs text-muted-foreground">
          {meetingLabel(card.meeting)}
        </p>
      )}
      <p data-testid="card-value" className="text-xs">
        {card?.value == null ? <span className="text-muted-foreground">No value yet</span> : valueLabel(card.value)}
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
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Button
            size="sm"
            variant="quiet"
            data-testid="card-move"
            disabled={!actionsEnabled}
            onClick={() => {
              setPanel(panel === 'move' ? 'none' : 'move');
            }}
          >
            Move to…
          </Button>
          <Button
            size="sm"
            variant="quiet"
            data-testid="card-set-value"
            disabled={!actionsEnabled}
            onClick={() => {
              setPanel(panel === 'value' ? 'none' : 'value');
            }}
          >
            Set value…
          </Button>
        </div>
      ) : null}
      {canAct && panel === 'move' ? (
        <MoveTo
          opportunityId={opportunityId}
          stages={stages}
          currentStageKey={firm.stageKey}
          actionsEnabled={actionsEnabled}
          busy={stageBusy}
          onChangeStage={onChangeStage}
          onDone={() => {
            setPanel('none');
          }}
        />
      ) : null}
      {canAct && panel === 'value' ? (
        <ValueDialog
          opportunityId={opportunityId}
          firmName={firm.name}
          initial={card?.value ?? null}
          busy={valueBusy}
          onSave={change => {
            onSetValue(change);
            setPanel('none');
          }}
          onCancel={() => {
            setPanel('none');
          }}
        />
      ) : null}
    </li>
  );
}
