import type { JSX } from 'react';
import type { FeedbackZone, TodayScreenView } from '../todayView.ts';

/** An answer to a command, drawn beside the control that sent it (slice 3a, C0). */
export function Feedback({
  feedback,
  zone,
  testId,
}: {
  readonly feedback: TodayScreenView['feedback'];
  readonly zone: FeedbackZone;
  readonly testId?: string;
}): JSX.Element | null {
  if (feedback === null || feedback.zone !== zone) return null;
  return (
    <div data-testid={testId ?? `feedback-${zone}`} data-code={feedback.code} role="status" className="flex flex-col gap-0.5 py-1 text-sm text-muted-foreground">
      <span>{feedback.text}</span>
      {feedback.agreement === null ? null : <span>{feedback.agreement}</span>}
    </div>
  );
}
