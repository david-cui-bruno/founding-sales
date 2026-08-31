import type { MetricDrilldown } from '../../../shared/contracts/fridayContract';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { Panel } from '../../components/Panel';

const occurred = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZone: 'UTC',
});

export type MetricDrilldownPanelProps = {
  drilldown: MetricDrilldown;
  onOpenLead(personId: string): void;
  onClose(): void;
};

/**
 * Provenance rows behind one metric. Rows with a person open the global
 * inspector through `onOpenLead`.
 */
export function MetricDrilldownPanel({
  drilldown,
  onOpenLead,
  onClose,
}: MetricDrilldownPanelProps) {
  return (
    <Panel
      title={`${drilldown.label} evidence`}
      actions={(
        <Button variant="quiet" onClick={onClose}>
          Close
        </Button>
      )}
    >
      {drilldown.rows.length === 0 ? (
        <EmptyState
          title="No evidence rows"
          description="This metric has no drilldown events this week."
        />
      ) : (
        <ul className="friday-drilldown">
          {drilldown.rows.map((row) => (
            <li key={row.id} className="friday-drilldown__row">
              {row.personId === null ? (
                <span className="friday-drilldown__label">{row.label}</span>
              ) : (
                <button
                  type="button"
                  className="friday-drilldown__open"
                  onClick={() => {
                    if (row.personId !== null) {
                      onOpenLead(row.personId);
                    }
                  }}
                >
                  {row.label}
                </button>
              )}
              {row.occurredAt !== null && (
                <span className="friday-drilldown__time">
                  {occurred.format(new Date(row.occurredAt))}
                </span>
              )}
              {row.detail !== null && (
                <span className="friday-drilldown__detail">{row.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
