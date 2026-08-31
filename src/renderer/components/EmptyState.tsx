import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

export type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
};

/** Calm empty state that explains the condition and offers the next step. */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <Inbox className="empty-state__icon" aria-hidden="true" size={28} />
      <h3 className="empty-state__title">{title}</h3>
      {description !== undefined && (
        <p className="empty-state__description">{description}</p>
      )}
      {action !== undefined && (
        <div className="empty-state__action">{action}</div>
      )}
    </div>
  );
}
