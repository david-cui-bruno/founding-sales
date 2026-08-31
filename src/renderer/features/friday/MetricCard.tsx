import type { Metric, MetricId } from '../../../shared/contracts/fridayContract';

const USD_METRICS: ReadonlySet<MetricId> = new Set(['new_mrr']);
const RATE_METRICS: ReadonlySet<MetricId> = new Set([
  'offer_rate', 'win_rate', 'fill_rate',
]);

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
});
const usdSigned = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', signDisplay: 'always',
});
const percent = new Intl.NumberFormat('en-US', {
  style: 'percent', maximumFractionDigits: 0,
});
const percentSigned = new Intl.NumberFormat('en-US', {
  style: 'percent', maximumFractionDigits: 0, signDisplay: 'always',
});
const count = new Intl.NumberFormat('en-US');
const countSigned = new Intl.NumberFormat('en-US', { signDisplay: 'always' });

function formatValue(metric: Metric, value: number, signed: boolean): string {
  if (USD_METRICS.has(metric.id)) {
    return (signed ? usdSigned : usd).format(value);
  }
  if (RATE_METRICS.has(metric.id)) {
    return (signed ? percentSigned : percent).format(value);
  }
  return (signed ? countSigned : count).format(value);
}

/**
 * Exact evidence display. The domain sends numerator and denominator; the
 * renderer never divides them.
 */
export function formatMetricEvidence(metric: Metric): string | null {
  if (metric.numerator === null || metric.denominator === null) {
    return null;
  }
  return `${count.format(metric.numerator)} / ${count.format(metric.denominator)}`;
}

export function formatMetricTarget(metric: Metric): string | null {
  return metric.target === null ? null : formatValue(metric, metric.target, false);
}

export function formatPriorDelta(metric: Metric): string | null {
  return metric.priorDelta === null
    ? null
    : formatValue(metric, metric.priorDelta, true);
}

export type MetricCardProps = {
  metric: Metric;
  onOpenMetric(metricId: MetricId): void;
};

/**
 * One scoreboard tile. It becomes a drilldown button only when the domain
 * reports drilldown evidence; otherwise it stays a static surface.
 */
export function MetricCard({ metric, onOpenMetric }: MetricCardProps) {
  const evidence = formatMetricEvidence(metric);
  const target = formatMetricTarget(metric);
  const delta = formatPriorDelta(metric);

  const body = (
    <>
      <span className="metric-card__label">{metric.label}</span>
      <span className="metric-card__value">{metric.displayValue}</span>
      {evidence !== null && (
        <span className="metric-card__evidence">{evidence}</span>
      )}
      {target !== null && (
        <span className="metric-card__target">Target {target}</span>
      )}
      {delta !== null && (
        <span className="metric-card__delta">{delta} vs prior week</span>
      )}
    </>
  );

  if (metric.drilldownCount > 0) {
    return (
      <button
        type="button"
        className="metric-card metric-card--interactive"
        onClick={() => onOpenMetric(metric.id)}
      >
        {body}
      </button>
    );
  }

  return <div className="metric-card">{body}</div>;
}
