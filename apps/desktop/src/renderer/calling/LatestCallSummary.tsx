import { useEffect, useRef, useState, type JSX } from 'react';
import { registryHistoryPorts, type CallHistoryPorts } from './CallHistory.tsx';
import { CallSummaryBlock, latestSummarized } from './CallSummary.tsx';

/**
 * The Today call card's "Last call" line: the firm's most recent summarized call, read with
 * the history. Nothing at all when there is none, or the read did not answer.
 */
export function LatestCallSummary({
  firmId,
  ports = registryHistoryPorts(),
}: {
  readonly firmId: string;
  readonly ports?: Pick<CallHistoryPorts, 'history'> | null;
}): JSX.Element | null {
  const [latest, setLatest] = useState<ReturnType<typeof latestSummarized>>(null);
  const portsRef = useRef(ports);
  portsRef.current = ports;
  useEffect(() => {
    let current = true;
    setLatest(null);
    void portsRef.current?.history(firmId).then(
      answer => {
        if (current) setLatest(answer.calls === null ? null : latestSummarized(answer.calls));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [firmId]);
  if (latest === null) return null;
  const when = latest.startedAt ?? latest.endedAt;
  return (
    <section data-testid="today-last-call" className="border-y border-border py-1.5">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Last call
        {when === null ? null : (
          <span className="font-normal normal-case">
            {' · '}
            {new Date(when).toLocaleString(undefined, { month: 'short', day: 'numeric' })}
          </span>
        )}
      </p>
      <CallSummaryBlock summary={latest.summary} />
    </section>
  );
}
