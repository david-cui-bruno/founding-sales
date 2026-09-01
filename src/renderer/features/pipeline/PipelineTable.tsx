import type {
  PipelineCard,
  PipelineSnapshot,
} from '../../../shared/contracts/pipelineContract';
import { humanizeEnumLabel, titleCaseDisplayName } from '../../../shared/displayText';
import {
  lostReasonLabel,
  stageLabel,
  wonOutcomeLabel,
} from './pipelineStageMeta';

export type PipelineTableProps = {
  snapshot: PipelineSnapshot;
  onOpenLead(personId: string): void;
};

const cardStatus = (card: PipelineCard): string | null =>
  wonOutcomeLabel(card) ?? lostReasonLabel(card);

/**
 * Table view over the exact same snapshot DTO as the board. Fit and
 * Timing stay separate columns; there is no blended score column.
 */
export function PipelineTable({ snapshot, onOpenLead }: PipelineTableProps) {
  const rows = snapshot.stages.flatMap((lane) => lane.cards);

  return (
    <table className="pipeline-table">
      <thead>
        <tr>
          <th scope="col">Person</th>
          <th scope="col">Stage</th>
          <th scope="col">Context</th>
          <th scope="col">Priority</th>
          <th scope="col">Fit</th>
          <th scope="col">Timing</th>
          <th scope="col">Next action</th>
          <th scope="col">Entered stage</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td className="pipeline-table__empty" colSpan={8}>
              No leads
            </td>
          </tr>
        ) : (
          rows.map((card) => {
            const status = cardStatus(card);

            return (
              <tr key={card.salesCycleId}>
                <td>
                  <button
                    type="button"
                    className="pipeline-table__person"
                    onClick={() => onOpenLead(card.personId)}
                  >
                    {titleCaseDisplayName(card.personName)}
                  </button>
                </td>
                <td>
                  {stageLabel(card.stage)}
                  {status !== null && (
                    <span className="pipeline-table__status">{status}</span>
                  )}
                </td>
                <td>
                  {card.contextLabel ?? (
                    <span className="pipeline-table__absent" aria-hidden="true">
                      —
                    </span>
                  )}
                </td>
                {card.priorityContext === null ? (
                  <td className="pipeline-table__muted" colSpan={3}>
                    No priority data
                  </td>
                ) : (
                  <>
                    <td>{card.priorityContext.priority}</td>
                    <td>
                      {`${humanizeEnumLabel(card.priorityContext.fitBand)} · ${card.priorityContext.fitPoints}/30`}
                    </td>
                    <td>
                      {`${humanizeEnumLabel(card.priorityContext.timingBand)} · ${card.priorityContext.timingValue}/40`}
                    </td>
                  </>
                )}
                <td>
                  {card.nextAction === null ? (
                    '—'
                  ) : (
                    <>
                      {card.nextAction.label}
                      {card.nextAction.overdue && (
                        <span className="pipeline-table__overdue">
                          Overdue
                        </span>
                      )}
                    </>
                  )}
                </td>
                <td>{card.stageEnteredAt.slice(0, 10)}</td>
              </tr>
            );
          })
        )}
      </tbody>
    </table>
  );
}
