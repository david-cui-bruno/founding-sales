import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import {
  crmCommitmentReviewPayloadSchema,
  crmCommitmentReviewStatusResultSchema,
  crmCommitmentQueuedSchema,
  type CrmEvidenceClaimTarget,
} from "@fss/contracts";
import type { z } from "zod";
import { Button } from "../ui/button.tsx";
export interface CommitmentReviewPorts {
  status(
    input: CrmEvidenceClaimTarget,
  ): Promise<z.infer<typeof crmCommitmentReviewStatusResultSchema>>;
  review(
    input: z.infer<typeof crmCommitmentReviewPayloadSchema>,
  ): Promise<z.infer<typeof crmCommitmentQueuedSchema>>;
}
export function CommitmentReview({
  target,
  quote,
  index,
  ports,
  enabled,
  privacyKey,
  onUnavailable,
}: {
  target: CrmEvidenceClaimTarget;
  quote: string;
  index: number;
  ports: CommitmentReviewPorts;
  enabled: boolean;
  privacyKey: string | object | null;
  onUnavailable?: () => void;
}): JSX.Element {
  const [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState<number | null>(null),
    [notice, setNotice] = useState("");
  const [basis, setBasis] = useState<"human" | "verified_original" | null>(
    null,
  );
  const [classification, setClassification] = useState<
    "internal_promise" | "commercial" | "ambiguous"
  >("ambiguous");
  const [actor, setActor] = useState<"self" | "counterparty" | "unknown">(
    "unknown",
  );
  const [action, setAction] = useState(""),
    [precision, setPrecision] = useState<"unknown" | "date" | "instant">(
      "unknown",
    );
  const [deadline, setDeadline] = useState(""),
    [zone, setZone] = useState(""),
    [expression, setExpression] = useState("");
  const epoch = useRef(0),
    targetIdentity = JSON.stringify(target);
  const invalidate = useCallback(() => ++epoch.current, []);
  const reset = useCallback(() => {
    setOpened(false);
    setBusy(false);
    setRevision(null);
    setBasis(null);
    setNotice("");
    setClassification("ambiguous");
    setActor("unknown");
    setAction("");
    setPrecision("unknown");
    setDeadline("");
    setZone("");
    setExpression("");
  }, []);
  useLayoutEffect(() => {
    invalidate();
    reset();
    return () => {
      invalidate();
    };
  }, [
    targetIdentity,
    quote,
    privacyKey,
    enabled,
    ports.status,
    ports.review,
    invalidate,
    reset,
  ]);
  const open = async () => {
    if (!enabled || busy) return;
    const ticket = invalidate();
    reset();
    setBusy(true);
    try {
      const result = crmCommitmentReviewStatusResultSchema.parse(
        await ports.status(target),
      );
      if (ticket !== epoch.current) return;
      setRevision(result.current?.revision ?? 0);
      setBasis(result.current?.basis ?? null);
      setOpened(true);
    } catch {
      if (ticket === epoch.current) {
        setNotice(
          "Promise review is unavailable. Refresh the evidence and current access.",
        );
        onUnavailable?.();
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const parsed = crmCommitmentReviewPayloadSchema.safeParse({
    ...target,
    expectedCommitmentRevision: revision ?? 0,
    classification,
    actor,
    actionLabel: action,
    due:
      precision === "unknown"
        ? null
        : precision === "date"
          ? { kind: "date", date: deadline, zone, expression }
          : { kind: "instant", at: deadline, zone, expression },
  });
  const save = async () => {
    if (!enabled || busy || revision === null || !parsed.success) return;
    const ticket = invalidate();
    setBusy(true);
    setNotice("");
    try {
      const saved = crmCommitmentQueuedSchema.parse(
        await ports.review(parsed.data),
      );
      if (ticket !== epoch.current) return;
      if (saved.revision <= revision) throw new Error("stale_review");
      reset();
      setNotice("Promise review saved.");
    } catch {
      if (ticket === epoch.current) {
        reset();
        setNotice(
          "Promise review could not be confirmed. Refresh its current revision before trying again.",
        );
        onUnavailable?.();
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  return (
    <section aria-label={`Promise review ${index}`}>
      <Button
        disabled={!enabled || busy}
        onClick={() => {
          void open();
        }}
      >
        Review promise {index}
      </Button>
      {opened ? (
        <div className="mt-2 rounded-md border border-border p-3">
          {basis === null ? null : (
            <p className="text-sm">
              Current review basis:{" "}
              {basis === "human"
                ? "human attestation"
                : "verified original authored promise"}
            </p>
          )}
          <p className="text-sm">
            Review the actor, action and deadline explicitly. Ambiguous or
            commercial interpretations remain suggestions.
          </p>
          <blockquote className="mt-2 whitespace-pre-wrap text-sm">
            {quote}
          </blockquote>
          <label className="mt-2 block text-sm">
            Promise classification
            <select
              className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Promise classification"
              value={classification}
              onChange={(event) => {
                const value =
                  crmCommitmentReviewPayloadSchema.shape.classification.safeParse(
                    event.target.value,
                  );
                if (value.success) setClassification(value.data);
              }}
            >
              <option value="ambiguous">Ambiguous</option>
              <option value="internal_promise">Internal promise</option>
              <option value="commercial">Commercial interpretation</option>
            </select>
          </label>
          <label className="mt-2 block text-sm">
            Promising actor
            <select
              className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Promising actor"
              value={actor}
              onChange={(event) => {
                const value =
                  crmCommitmentReviewPayloadSchema.shape.actor.safeParse(
                    event.target.value,
                  );
                if (value.success) setActor(value.data);
              }}
            >
              <option value="unknown">Unknown actor</option>
              <option value="self">Me</option>
              <option value="counterparty">Counterparty</option>
            </select>
          </label>
          <label className="mt-2 block text-sm">
            Promised action
            <input
              className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Promised action"
              value={action}
              maxLength={300}
              onChange={(event) => setAction(event.target.value)}
            />
          </label>
          <label className="mt-2 block text-sm">
            Deadline precision
            <select
              className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Deadline precision"
              value={precision}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === "unknown" ||
                  value === "date" ||
                  value === "instant"
                ) {
                  setPrecision(value);
                  setDeadline("");
                  setZone("");
                  setExpression("");
                }
              }}
            >
              <option value="unknown">Unknown deadline</option>
              <option value="date">Date only</option>
              <option value="instant">Exact instant</option>
            </select>
          </label>
          {precision === "unknown" ? null : (
            <>
              <label className="mt-2 block text-sm">
                {precision === "date"
                  ? "Deadline date"
                  : "Deadline UTC instant"}
                <input
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  aria-label={
                    precision === "date"
                      ? "Deadline date"
                      : "Deadline UTC instant"
                  }
                  type={precision === "date" ? "date" : "text"}
                  placeholder={
                    precision === "instant"
                      ? "2026-10-12T15:00:00.000Z"
                      : undefined
                  }
                  value={deadline}
                  maxLength={40}
                  onChange={(event) => setDeadline(event.target.value)}
                />
              </label>
              <label className="mt-2 block text-sm">
                Deadline time zone
                <input
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  aria-label="Deadline time zone"
                  placeholder="America/Chicago"
                  value={zone}
                  maxLength={100}
                  onChange={(event) => setZone(event.target.value)}
                />
              </label>
              <label className="mt-2 block text-sm">
                Original deadline wording
                <input
                  className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  aria-label="Original deadline wording"
                  value={expression}
                  maxLength={200}
                  onChange={(event) => setExpression(event.target.value)}
                />
              </label>
            </>
          )}
          <Button
            disabled={busy || revision === null || !parsed.success}
            onClick={() => {
              void save();
            }}
          >
            Save promise review
          </Button>
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              invalidate();
              reset();
            }}
          >
            Cancel promise review
          </Button>
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}
