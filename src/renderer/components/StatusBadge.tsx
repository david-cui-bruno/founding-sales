export type StatusBadgeTone = 'success' | 'warning' | 'danger' | 'neutral';

export type StatusBadgeProps = {
  tone: StatusBadgeTone;
  label: string;
};

/**
 * Audit status pattern: a filled 8px dot carries the color while the label
 * text stays neutral, so statuses never compete with the single accent CTA.
 */
export function StatusBadge({ tone, label }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${tone}`}>
      <span className="status-badge__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
