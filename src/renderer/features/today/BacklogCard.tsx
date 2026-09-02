import { Button } from '../../components/Button';

export type BacklogCardProps = {
  count: number;
  cloudSignalCount: number;
  onReview(): void;
};

/**
 * The unreviewed-backlog card (audit 4.5): one count line plus the single
 * [Review] entry into triage mode. Never renders backlog rows; hidden
 * entirely at zero (zero-badge honesty).
 */
export function BacklogCard({ count, cloudSignalCount, onReview }: BacklogCardProps) {
  if (count === 0) {
    return null;
  }
  return (
    <section className="today-backlog-card" aria-label="Unreviewed backlog">
      <p className="today-backlog-card__line">
        <span className="today-backlog-card__count">
          {`${count} unreviewed ${count === 1 ? 'lead' : 'leads'}`}
        </span>
        <span className="today-backlog-card__signal">
          {` · ${cloudSignalCount} ${cloudSignalCount === 1 ? 'has' : 'have'} cloud signal`}
        </span>
      </p>
      <Button variant="quiet" onClick={onReview}>
        Review
      </Button>
    </section>
  );
}
