import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  crmCommitmentCompletedSchema,
  crmCommitmentPageSchema,
  todayActionsV2ResponseSchema,
  todayActionOpenV2ResponseSchema,
  reasonSentence,
  type TodayActionsV2Response,
  type TodayActionV2,
} from "@fss/contracts";
import { navigate, routeForAction } from "../routes.ts";
import type { z } from "zod";
import type {
  crmCommitmentReadSchema,
  crmCommitmentCompleteSchema,
  TodayPromiseTarget,
  TodayCommitmentBlockerTarget,
} from "@fss/contracts";
import { promiseActionPorts } from "./promiseActionPorts.ts";
import { Button } from "../ui/button.tsx";

export interface PromiseActionPorts {
  read(
    input: z.infer<typeof crmCommitmentReadSchema>,
  ): Promise<z.infer<typeof crmCommitmentPageSchema>>;
  complete(
    input: Omit<
      z.infer<typeof crmCommitmentCompleteSchema>,
      "commandId" | "clientVersion"
    >,
  ): Promise<z.infer<typeof crmCommitmentCompletedSchema>>;
}
type PromiseItem = z.infer<typeof crmCommitmentPageSchema>["items"][number];
/** Current metadata in mounted React state only; no cache or message content. */
export function ActionQueue({
  refreshKey,
  enabled,
  promisePorts = promiseActionPorts,
}: {
  readonly refreshKey: string | null;
  readonly enabled: boolean;
  readonly promisePorts?: PromiseActionPorts;
}): JSX.Element {
  const [read, setRead] = useState<TodayActionsV2Response | null | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [promise, setPromise] = useState<{
    target: TodayPromiseTarget | TodayCommitmentBlockerTarget;
    item: PromiseItem;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const issued = useRef(0);
  const alive = useRef(true);
  const invalidate = useCallback(() => ++issued.current, []);
  const refresh = useCallback(() => {
    const number = invalidate();
    setPromise(null);
    setBusy(null);
    const pending = enabled
      ? globalThis.callieApi?.read("today.actionsV2", {})
      : undefined;
    if (pending === undefined) {
      setRead(null);
      return;
    }
    void pending.then(
      (value) => {
        if (alive.current && number === issued.current) {
          const parsed = todayActionsV2ResponseSchema.safeParse(value);
          setRead(parsed.success ? parsed.data : null);
        }
      },
      () => {
        if (alive.current && number === issued.current) setRead(null);
      },
    );
  }, [enabled, invalidate]);
  useLayoutEffect(() => {
    alive.current = true;
    setRead(undefined);
    setPromise(null);
    setNotice(null);
    setBusy(null);
    refresh();
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      alive.current = false;
      invalidate();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh, refreshKey, promisePorts, invalidate]);
  const open = async (action: TodayActionV2): Promise<void> => {
    if (!enabled) return;
    const ticket = invalidate();
    setPromise(null);
    setBusy(action.actionId);
    setNotice(null);
    try {
      const answer = await globalThis.callieApi?.read("today.openActionV2", {
        actionId: action.actionId,
        target: action.target,
      });
      if (!alive.current || ticket !== issued.current) return;
      const parsed = todayActionOpenV2ResponseSchema.safeParse(answer);
      const target = parsed.success ? parsed.data.target : null;
      if (target == null) {
        setRead(undefined);
        setPromise(null);
        setNotice(
          answer === null || answer === undefined
            ? "Actions are unavailable. Try again."
            : "This action changed. Today has been refreshed.",
        );
        refresh();
        return;
      }
      if (target.kind === "internal_task" || target.kind === "commitment_blocker") {
        if (
          action.target.kind !== target.kind ||
          JSON.stringify(target) !== JSON.stringify(action.target) ||
          promisePorts === undefined
        )
          throw new Error("promise_unavailable");
        const page = crmCommitmentPageSchema.parse(
          await promisePorts.read({
            scope: {
              kind: "source",
              sourceId: target.support.sourceId,
              sourceKind: target.support.sourceKind,
            },
            limit: 50,
          }),
        );
        if (!alive.current || ticket !== issued.current) return;
        const item = page.items.find(
          (item) =>
            item.commitmentId === target.review.commitmentId &&
            item.revision === target.review.revision,
        );
        if (
          item === undefined ||
          item.todayEligibility !== "current" ||
          (target.kind === "internal_task"
            ? item.state !== "applied" || item.task?.taskId !== target.taskId || item.task.version !== target.expectedVersion || item.task.status !== "open"
            : item.state !== "pending") ||
          item.source === null ||
          item.source.workspaceId !== read?.workspaceId ||
          item.source.kind !== target.support.sourceKind ||
          item.source.sourceId !== target.support.sourceId ||
          item.source.revision !== target.support.sourceRevision ||
          item.source.contentHash !== target.support.sourceHash ||
          item.quote === null
        )
          throw new Error("promise_changed");
        setPromise({ target, item });
        return;
      }
      navigate(routeForAction(target));
    } catch {
      if (alive.current && ticket === issued.current) {
        setRead(undefined);
        setPromise(null);
        setNotice("Actions are unavailable. Try again.");
        refresh();
      }
    } finally {
      if (alive.current && ticket === issued.current) setBusy(null);
    }
  };
  const complete = async (): Promise<void> => {
    if (
      !enabled ||
      promise === null ||
      promise.target.kind !== "internal_task" ||
      promisePorts === undefined ||
      busy !== null
    )
      return;
    const current = promise,
      ticket = invalidate();
    setBusy(current.target.taskId);
    setNotice(null);
    try {
      const result = crmCommitmentCompletedSchema.parse(
        await promisePorts.complete({
          taskId: current.target.taskId,
          expectedVersion: current.target.expectedVersion,
        }),
      );
      if (!alive.current || ticket !== issued.current) return;
      if (
        result.taskId !== current.target.taskId ||
        result.version <= current.target.expectedVersion
      )
        throw new Error("promise_changed");
      setPromise(null);
      setNotice("Promise completed.");
      refresh();
    } catch {
      if (alive.current && ticket === issued.current) {
        setPromise(null);
        setNotice(
          "Completion could not be confirmed. Check current work before trying again.",
        );
        refresh();
      }
    } finally {
      if (alive.current && ticket === issued.current) setBusy(null);
    }
  };
  return (
    <section
      aria-label="Actions"
      className="shrink-0 border-b border-border px-5 py-3"
      data-testid="today-actions"
    >
      {read === undefined ? (
        <p className="text-sm text-muted-foreground">Loading actions…</p>
      ) : read === null ? (
        <p className="text-sm text-muted-foreground">
          Actions are unavailable.{" "}
          <Button variant="quiet" size="sm" onClick={refresh}>
            Retry actions
          </Button>
        </p>
      ) : read.actions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {read.promiseCoverage.truncated
            ? "No actions on this page."
            : "No actions need you."}
        </p>
      ) : (
        <ul className="flex max-h-[40vh] flex-col gap-2 overflow-y-auto">
          {read.actions.map((action) => (
            <li key={action.actionId} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{action.subject}</p>
                <p className="text-xs text-muted-foreground">
                  {action.kind === "promise"
                    ? `${action.state === "overdue" ? "Overdue promise" : "Promise"} · ${action.due === null ? "Date unknown" : action.due.kind === "date" ? `${action.due.date} (${action.due.zone})` : new Date(action.due.at).toLocaleString(undefined, { timeZone: action.due.zone })}`
                    : action.kind === "reply"
                      ? action.reason === "reply_review"
                        ? action.state === "overdue"
                          ? "Overdue reply review"
                          : "Reply needs review"
                        : action.state === "overdue"
                          ? "Overdue reply"
                          : "Substantive reply"
                      : action.kind === "call"
                        ? `Upcoming call · ${new Date(action.dueAt).toLocaleString(undefined, { timeZone: read.businessTimeZone })}`
                        : action.reason === "commitment_projection_failed" ? "Promise processing failed" : reasonSentence(action.reason)}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  void open(action);
                }}
              >
                {action.target.kind === "commitment_blocker"
                  ? "Open blocked promise"
                  : action.kind === "promise"
                  ? "Open promise"
                  : action.kind === "reply"
                    ? "Open reply"
                    : action.kind === "call"
                      ? "Open call"
                      : "Open settings"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {read?.promiseCoverage.truncated ? (
        <p className="mt-2 text-sm text-muted-foreground">
          More promise work exists beyond this bounded Today page. Open the
          relevant record for its current source promises.
        </p>
      ) : null}
      {promise === null ? null : (
        <section
          aria-label="Current promise"
          className="mt-3 rounded-md border border-border p-3"
        >
          <p className="text-sm font-medium">{promise.item.actionLabel}</p>
          <p className="text-sm">
            {promise.item.basis === "human"
              ? "Human attestation"
              : "Verified original authored promise"}
          </p>
          <blockquote className="mt-2 whitespace-pre-wrap text-sm">
            {promise.item.quote}
          </blockquote>
          <p className="text-xs text-muted-foreground">
            Supporting {promise.item.source?.kind.replaceAll("_", " ")} ·
            revision {promise.item.source?.revision}
          </p>
          {promise.target.kind === "commitment_blocker" ? (
            <p className="text-sm">This promise remains pending after processing failed.</p>
          ) : <Button
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              void complete();
            }}
          >
            Mark promise complete
          </Button>}
          <Button variant="quiet" size="sm" onClick={() => setPromise(null)}>
            Close promise
          </Button>
        </section>
      )}
      {notice === null ? null : (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {notice}
        </p>
      )}
    </section>
  );
}
