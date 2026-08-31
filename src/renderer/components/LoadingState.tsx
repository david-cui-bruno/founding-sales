import { LoaderCircle } from 'lucide-react';

export type LoadingStateProps = {
  label: string;
};

/** Polite loading announcement with a reduced-motion-aware spinner. */
export function LoadingState({ label }: LoadingStateProps) {
  return (
    <div className="loading-state" role="status">
      <LoaderCircle
        className="loading-state__spinner"
        aria-hidden="true"
        size={20}
      />
      <span>{label}</span>
    </div>
  );
}
