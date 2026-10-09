import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  crmCommitmentPageSchema,
  crmCommitmentCompletedSchema,
  type CanonicalSourceReference,
} from "@fss/contracts";
import type { z } from "zod";
import type { PromiseActionPorts } from "../today/ActionQueue.tsx";
import { promiseActionPorts } from "../today/promiseActionPorts.ts";
import { Button } from "../ui/button.tsx";
type Page = z.infer<typeof crmCommitmentPageSchema>;
export function SourcePromises({
  source,
  enabled,
  privacyKey,
  ports = promiseActionPorts,
  onUnavailable,
}: {
  source: CanonicalSourceReference;
  enabled: boolean;
  privacyKey: string | object | null;
  ports?: PromiseActionPorts;
  onUnavailable?: () => void;
}): JSX.Element {
  const [page, setPage] = useState<Page | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const epoch = useRef(0),
    identity = JSON.stringify(source);
  const invalidate = useCallback(() => ++epoch.current, []);
  useLayoutEffect(() => {
    invalidate();
    setPage(null);
    setBusy(false);
    setNotice("");
    return () => {
      invalidate();
    };
  }, [identity, privacyKey, enabled, ports.read, ports.complete, invalidate]);
  const read = async (afterId?: string) => {
    if (!enabled || busy) return;
    const ticket = ++epoch.current;
    setPage(null);
    setBusy(true);
    setNotice("");
    try {
      const value = crmCommitmentPageSchema.parse(
        await ports.read({
          scope: {
            kind: "source",
            sourceId: source.sourceId,
            sourceKind: source.kind,
          },
          limit: 50,
          ...(afterId === undefined ? {} : { afterId }),
        }),
      );
      if (ticket !== epoch.current) return;
      if (
        value.items.some(
          (item) =>
            item.source !== null &&
            (item.source.workspaceId !== source.workspaceId ||
              item.source.sourceId !== source.sourceId ||
              item.source.kind !== source.kind ||
              item.source.revision !== source.revision ||
              item.source.contentHash !== source.contentHash),
        )
      )
        throw new Error("changed_source");
      setPage(value);
    } catch {
      if (ticket === epoch.current) {
        setPage(null);
        setNotice(
          "Source promises are unavailable. Refresh current access and evidence.",
        );
        onUnavailable?.();
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const complete = async (item: Page["items"][number]) => {
    if (
      !enabled ||
      busy ||
      item.state !== "applied" ||
      item.task?.status !== "open" ||
      item.quote === null ||
      item.source === null
    )
      return;
    const task = item.task,
      ticket = ++epoch.current;
    setPage(null);
    setBusy(true);
    setNotice("");
    try {
      const result = crmCommitmentCompletedSchema.parse(
        await ports.complete({
          taskId: task.taskId,
          expectedVersion: task.version,
        }),
      );
      if (ticket !== epoch.current) return;
      if (result.taskId !== task.taskId || result.version <= task.version)
        throw new Error("changed_task");
      setNotice("Promise completed. Read current source promises to refresh.");
    } catch {
      if (ticket === epoch.current) {
        setNotice(
          "Completion could not be confirmed. Read current work before trying again.",
        );
        onUnavailable?.();
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  return (
    <section
      aria-label="Source promises"
      className="mt-3 rounded-md border border-border p-3"
    >
      <Button
        disabled={!enabled || busy}
        onClick={() => {
          void read();
        }}
      >
        View source promises
      </Button>
      {notice ? (
        <p role="status" className="mt-2 text-sm">
          {notice}
        </p>
      ) : null}
      {page ? (
        <>
          <p className="mt-2 text-sm">
            Current evidence-backed promises from this source. Commercial and
            uncertain interpretations remain suggestions.
          </p>
          {page.items.length === 0 ? (
            <p>No source promises on this page.</p>
          ) : null}
          {page.items.map((item) => (
            <article
              key={item.commitmentId}
              className="mt-3 border-t border-border pt-3"
            >
              <p className="text-sm">
                {item.basis === null
                  ? "Basis removed"
                  : item.basis === "human"
                    ? "Human attestation"
                    : "Verified original authored promise"}
              </p>
              <p className="font-medium">
                {item.actionLabel ?? "Removed promise evidence"}
              </p>
              <p className="text-sm">
                {item.state === "suggestion"
                  ? "Suggestion"
                  : item.state === "review_required"
                    ? "Review required"
                    : item.state === "pending"
                      ? "Awaiting projection"
                      : item.state === "redacted"
                        ? "Evidence removed"
                        : "Internal work"}{" "}
                — actor {item.actor ?? "unknown"}; event eligibility{" "}
                {item.todayEligibility ?? "unknown"}
              </p>
              {item.due === null ? (
                <p className="text-sm">Deadline unknown</p>
              ) : (
                <p className="text-sm">
                  {item.due.kind === "date" ? item.due.date : item.due.at} (
                  {item.due.zone}) — {item.due.expression}
                </p>
              )}
              {item.quote === null ? null : (
                <blockquote className="mt-2 whitespace-pre-wrap text-sm">
                  {item.quote}
                </blockquote>
              )}
              {item.state === "applied" &&
              item.task?.status === "open" &&
              item.quote !== null &&
              item.source !== null ? (
                <Button
                  disabled={!enabled || busy}
                  onClick={() => {
                    void complete(item);
                  }}
                >
                  Complete this promise
                </Button>
              ) : item.task ? (
                <p className="text-sm">Work status: {item.task.status}</p>
              ) : null}
            </article>
          ))}
          {page.nextAfterId === null ? null : (
            <>
              <p className="mt-2 text-sm">
                More source promises exist beyond this bounded page.
              </p>
              <Button
                disabled={!enabled || busy}
                onClick={() => {
                  void read(page.nextAfterId ?? undefined);
                }}
              >
                Next source promises page
              </Button>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
