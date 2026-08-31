import { TriangleAlert } from 'lucide-react';

import { Button } from './Button';

export type ErrorStateProps = {
  title: string;
  description?: string;
  onRetry?: () => void;
};

/**
 * Safe failure surface. Callers pass human copy only; raw exceptions and
 * internal paths must never reach this component.
 */
export function ErrorState({ title, description, onRetry }: ErrorStateProps) {
  return (
    <div className="error-state" role="alert">
      <TriangleAlert className="error-state__icon" aria-hidden="true" size={22} />
      <h3 className="error-state__title">{title}</h3>
      {description !== undefined && (
        <p className="error-state__description">{description}</p>
      )}
      {onRetry !== undefined && (
        <Button variant="quiet" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
