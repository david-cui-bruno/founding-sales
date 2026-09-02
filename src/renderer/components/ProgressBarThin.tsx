export type ProgressBarThinProps = {
  /** Accessible name announced for the indeterminate progress bar. */
  label: string;
};

/**
 * Thin top-of-content indeterminate progress bar (2px accent sweep) for
 * route-level fetches. Motion lives in CSS behind prefers-reduced-motion:
 * reduced-motion users see a static accent bar instead of the sweep.
 */
export function ProgressBarThin({ label }: ProgressBarThinProps) {
  return (
    <div
      className="progress-bar-thin"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="progress-bar-thin__fill" />
    </div>
  );
}
