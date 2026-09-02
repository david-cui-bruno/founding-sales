import type {
  CancelJobRequest,
  CreateJobRequest,
  FillJobRequest,
  FridayReport,
  Metric,
  MetricDrilldown,
  MetricId,
} from '../../../shared/contracts/fridayContract';
import { Panel } from '../../components/Panel';
import { JobRequestForm } from './JobRequestForm';
import { MetricCard } from './MetricCard';
import { MetricDrilldownPanel } from './MetricDrilldown';
import { ScoreboardHeader } from './ScoreboardHeader';
import { SourceFunnelTable } from './SourceFunnelTable';

import './friday.css';

/**
 * The audit's three themed bands. Membership is fixed by metric ID so a new
 * metric must be placed deliberately; all thirteen contract metrics are
 * assigned and an unassigned one simply would not render. The slug drives
 * the band's 12-column card layout so no row ends with a lonely card.
 */
const BANDS: readonly {
  title: string;
  slug: string;
  metricIds: readonly MetricId[];
}[] = [
  {
    title: 'Funnel',
    slug: 'funnel',
    metricIds: ['interviews', 'offers', 'wins', 'offer_rate', 'win_rate'],
  },
  {
    title: 'Revenue',
    slug: 'revenue',
    metricIds: ['new_mrr', 'founding_customers'],
  },
  {
    title: 'Health',
    slug: 'health',
    metricIds: [
      'jobs_requested', 'jobs_filled', 'fill_rate',
      'design_partner_fitness', 'cycles_without_next_step', 'invalid_action_cycles',
    ],
  },
];

function bandMetrics(
  report: FridayReport,
  metricIds: readonly MetricId[],
): Metric[] {
  const byId = new Map(report.metrics.map((metric) => [metric.id, metric]));
  return metricIds.flatMap((id) => {
    const metric = byId.get(id);
    return metric === undefined ? [] : [metric];
  });
}

export type FridayPageProps = {
  report: FridayReport;
  weekOffset?: number;
  onPreviousWeek?(): void;
  onNextWeek?(): void;
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
 * domain-calculated; this page only lays the strict report out in the three
 * audit bands.
 */
export function FridayPage({
  report,
  weekOffset = 0,
  onPreviousWeek = () => undefined,
  onNextWeek = () => undefined,
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
      <ScoreboardHeader
        report={report}
        weekOffset={weekOffset}
        onPreviousWeek={onPreviousWeek}
        onNextWeek={onNextWeek}
      />

      {BANDS.map((band) => {
        const metrics = bandMetrics(report, band.metricIds);
        if (metrics.length === 0) {
          return null;
        }
        return (
          <section
            key={band.title}
            className={`friday__band friday__band--${band.slug}`}
            aria-label={band.title}
          >
            <h2 className="friday__band-title">{band.title}</h2>
            <div className="friday__metrics">
              {metrics.map((metric) => (
                <MetricCard
                  key={metric.id}
                  metric={metric}
                  onOpenMetric={onOpenMetric}
                />
              ))}
            </div>
          </section>
        );
      })}

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
