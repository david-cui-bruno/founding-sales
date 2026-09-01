import type { LifecycleStage } from '../../../shared/contracts/commonContract';

/** Optional per-stage row counts; 'all' is the unfiltered total. */
export type LeadStageCounts = Partial<Record<LifecycleStage | 'all', number>>;

export type LeadsFilterChipsProps = {
  stages: LifecycleStage[];
  /** Null while counts are unknown (loading, or the page is incomplete). */
  counts: LeadStageCounts | null;
  onStagesChange(stages: LifecycleStage[]): void;
};

const STAGE_CHIPS: readonly { stage: LifecycleStage; label: string }[] = [
  { stage: 'unreviewed', label: 'Unreviewed' },
  { stage: 'ready', label: 'Ready' },
  { stage: 'contacted', label: 'Contacted' },
  { stage: 'interviewed', label: 'Interviewed' },
  { stage: 'offered', label: 'Offered' },
  { stage: 'won', label: 'Won' },
  { stage: 'lost_nurture', label: 'Lost' },
];

type FilterChipProps = {
  label: string;
  count: number | undefined;
  pressed: boolean;
  onClick(): void;
};

/**
 * A small multi-select toggle chip. SegmentedControl is single-select by
 * design, so stage filtering gets its own primitive with aria-pressed state.
 */
function FilterChip({ label, count, pressed, onClick }: FilterChipProps) {
  return (
    <button
      type="button"
      className={pressed ? 'leads-chip leads-chip--on' : 'leads-chip'}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {label}
      {count !== undefined && (
        <>
          {' '}
          <span className="leads-chip__count numeric">{count}</span>
        </>
      )}
    </button>
  );
}

/**
 * Stage filter chips under the page header. Multi-select drives the existing
 * stages[] list param; the All chip resets to the unfiltered list.
 */
export function LeadsFilterChips({
  stages,
  counts,
  onStagesChange,
}: LeadsFilterChipsProps) {
  const toggle = (stage: LifecycleStage) => {
    onStagesChange(
      stages.includes(stage)
        ? stages.filter((current) => current !== stage)
        : [...stages, stage],
    );
  };

  return (
    <div className="leads-chips" role="group" aria-label="Filter by stage">
      <FilterChip
        label="All"
        count={counts === null ? undefined : counts.all}
        pressed={stages.length === 0}
        onClick={() => onStagesChange([])}
      />
      {STAGE_CHIPS.map(({ stage, label }) => (
        <FilterChip
          key={stage}
          label={label}
          count={counts === null ? undefined : counts[stage]}
          pressed={stages.includes(stage)}
          onClick={() => toggle(stage)}
        />
      ))}
    </div>
  );
}
