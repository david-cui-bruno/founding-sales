export type UnreviewedBacklogBandProps = {
  count: number;
  onReviewInLeads(): void;
};

/**
 * One collapsed line summarizing the unreviewed backlog. Never renders rows;
 * reviewing happens in Leads. Hidden entirely at zero.
 */
export function UnreviewedBacklogBand({
  count,
  onReviewInLeads,
}: UnreviewedBacklogBandProps) {
  if (count === 0) {
    return null;
  }
  return (
    <div className="today-backlog">
      <span className="today-backlog__label">
        {`Unreviewed backlog · ${count}`}
      </span>
      <button
        type="button"
        className="today-backlog__link"
        onClick={onReviewInLeads}
      >
        Review in Leads
      </button>
    </div>
  );
}
