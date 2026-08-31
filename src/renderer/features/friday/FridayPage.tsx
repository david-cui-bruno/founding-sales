import type {
  CancelJobRequest,
  CreateJobRequest,
  FillJobRequest,
  FridayReport,
  MetricDrilldown,
  MetricId,
} from '../../../shared/contracts/fridayContract';
import { Panel } from '../../components/Panel';
import { JobRequestForm } from './JobRequestForm';
import { MetricCard } from './MetricCard';
import { MetricDrilldownPanel } from './MetricDrilldown';
import { ScoreboardHeader } from './ScoreboardHeader';
import { SourceFunnelTable } from './SourceFunnelTable';

export type FridayPageProps = {
  report: FridayReport;
  onOpenMetric(metricId: MetricId): void;
  onCreateJob(input: CreateJobRequest): void;
  onFillJob(input: FillJobRequest): void;
  onCancelJob(input: CancelJobRequest): void;
  drilldown?: MetricDrilldown | null;
  onOpenLead?(personId: string): void;
  onCloseDrilldown?(): void;
};

/**
 * Presentational scoreboard. Every metric value, rate, and window bound is
 * domain-calculated; this page only lays the strict report out.
 */
export function FridayPage({
  report,
  onOpenMetric,
  onCreateJob,
  onFillJob,
  onCancelJob,
  drilldown = null,
  onOpenLead,
  onCloseDrilldown,
}: FridayPageProps) {
  return (
    <div className="friday">
      <ScoreboardHeader report={report} />

      <div className="friday__metrics">
        {report.metrics.map((metric) => (
          <MetricCard
            key={metric.id}
            metric={metric}
            onOpenMetric={onOpenMetric}
          />
        ))}
      </div>

      {drilldown !== null && onOpenLead !== undefined
        && onCloseDrilldown !== undefined && (
        <MetricDrilldownPanel
          drilldown={drilldown}
          onOpenLead={onOpenLead}
          onClose={onCloseDrilldown}
        />
      )}

      <Panel title="Source funnel">
        <SourceFunnelTable rows={report.sourceRows} />
      </Panel>

      <Panel title="Job requests">
        <JobRequestForm
          jobs={report.jobs}
          onCreateJob={onCreateJob}
          onFillJob={onFillJob}
          onCancelJob={onCancelJob}
        />
      </Panel>
    </div>
  );
}
