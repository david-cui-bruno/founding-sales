import type { JSX } from 'react';
import { CALL_SIDE_LABELS, type CallSessionDto, type CallSummaryDto } from '@fss/contracts';

/**
 * A call's after-call summary (slice C3b): a few grey sentences, then "Next steps" and
 * "Heard" as quiet lists. Suggestions only — there is no button here, and nothing is sent
 * or scheduled from it; David decides what to do with each line.
 *
 * Shown under the call on the firm page (`CallHistory.tsx`) and, for the firm's most recent
 * summarized call, on the Today call card (`LatestCallSummary`).
 */
export function CallSummaryBlock({ summary }: { readonly summary: CallSummaryDto }): JSX.Element {
  return (
    <div data-testid="call-summary" className="flex flex-col gap-1.5 py-1 text-xs">
      <p data-testid="call-summary-text" className="leading-relaxed text-muted-foreground">
        {summary.summary}
      </p>
      {summary.nextSteps.length === 0 ? null : (
        <div>
          <p className="font-medium tracking-wide text-muted-foreground uppercase">Next steps</p>
          <ul data-testid="call-summary-steps" className="flex flex-col gap-0.5">
            {summary.nextSteps.map((step, index) => (
              <li key={index} data-testid="call-summary-step" className="flex gap-2">
                <span className="text-muted-foreground">·</span>
                <span className="min-w-0 flex-1">
                  {step.action}
                  {step.due === null ? null : <span className="text-muted-foreground"> — {step.due}</span>}
                </span>
                {step.owner === null ? null : (
                  <span data-testid="call-summary-step-owner" className="shrink-0 text-muted-foreground">
                    {CALL_SIDE_LABELS[step.owner]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.commitments.length === 0 ? null : (
        <div>
          <p className="font-medium tracking-wide text-muted-foreground uppercase">Heard</p>
          <ul data-testid="call-summary-commitments" className="flex flex-col gap-0.5">
            {summary.commitments.map((commitment, index) => (
              <li key={index} data-testid="call-summary-commitment" className="flex gap-2">
                <span className="w-10 shrink-0 font-medium">{CALL_SIDE_LABELS[commitment.speaker]}</span>
                <span className="min-w-0 flex-1 text-muted-foreground">“{commitment.quote}”</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The firm's most recent call that has a summary, or null. The history is newest first. */
export function latestSummarized(calls: readonly CallSessionDto[]): (CallSessionDto & { readonly summary: CallSummaryDto }) | null {
  for (const call of calls) {
    if (call.summary !== undefined) return call as CallSessionDto & { readonly summary: CallSummaryDto };
  }
  return null;
}
