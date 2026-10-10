import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { operations } from "../app/bridges.ts";
import type { z } from "zod";
import type { crmCapabilityReadResponseSchema } from "@fss/contracts";
export type Capability =
  "metadata_review" | "mail_capture" | "crm_extraction" | "ask_answer";
export interface CapabilityTarget {
  capability: Capability;
  mailboxId?: string;
}
export interface CapabilityChange {
  revision: number;
  enabled: boolean;
  authorityReceiptId: string | null;
}
export interface CrmCapabilityPorts {
  read(
    input: CapabilityTarget,
  ): Promise<z.infer<typeof crmCapabilityReadResponseSchema>>;
  activate(
    input: CapabilityTarget & {
      expectedRevision: number;
      authorityReceiptId: string;
    },
  ): Promise<CapabilityChange>;
  disable(
    input: CapabilityTarget & { expectedRevision: number },
  ): Promise<CapabilityChange>;
}

const descriptions = {
  metadata_review: {
    name: "metadata review",
    detail:
      "Retain business email metadata for your private review. This does not copy message bodies.",
  },
  mail_capture: {
    name: "original email capture",
    detail:
      "Copy approved business email, including incoming messages and your sent replies. Personal and excluded mail stays excluded. Hosted AI requires separate approval.",
  },
  crm_extraction: {
    name: "evidence extraction",
    detail:
      "Use separately approved hosted AI to identify evidence in your authorized originals. Source ownership, deletion and spending limits still apply.",
  },
  ask_answer: {
    name: "Ask answers",
    detail:
      "Use separately approved hosted AI for answers grounded in your authorized originals. Keyword and record search remain available while answers are off.",
  },
} as const;
function api() {
  const value = operations();
  if (!value) throw new Error("unavailable");
  return value;
}
export const crmCapabilityPorts: CrmCapabilityPorts = {
  read: (input) => api().read("crm.capabilityRead", input),
  activate: (input) => {
    switch (input.capability) {
      case "metadata_review":
        return api().command("crm.metadataReviewActivate", {
          ...input,
          capability: "metadata_review",
        });
      case "mail_capture":
        return api().command("crm.mailCaptureActivate", {
          ...input,
          capability: "mail_capture",
        });
      case "crm_extraction":
        return api().command("crm.extractionActivate", {
          ...input,
          capability: "crm_extraction",
        });
      case "ask_answer":
        return api().command("crm.askAnswerActivate", {
          ...input,
          capability: "ask_answer",
        });
    }
  },
  disable: (input) => {
    switch (input.capability) {
      case "metadata_review":
        return api().command("crm.metadataReviewDisable", {
          ...input,
          capability: "metadata_review",
        });
      case "mail_capture":
        return api().command("crm.mailCaptureDisable", {
          ...input,
          capability: "mail_capture",
        });
      case "crm_extraction":
        return api().command("crm.extractionDisable", {
          ...input,
          capability: "crm_extraction",
        });
      case "ask_answer":
        return api().command("crm.askAnswerDisable", {
          ...input,
          capability: "ask_answer",
        });
    }
  },
};
type View = z.infer<typeof crmCapabilityReadResponseSchema>;
type Snapshot = { key: string; rows: Partial<Record<Capability, View>> };
export function CrmCapabilitiesSection({
  scope,
  available,
  privacyKey,
  mailboxId,
  ports = crmCapabilityPorts,
  refreshVersion = 0,
  onChange,
}: {
  scope: "mail" | "ai";
  available: boolean;
  privacyKey: string;
  mailboxId?: string;
  ports?: CrmCapabilityPorts;
  refreshVersion?: number;
  onChange?: () => void;
}) {
  const targets = useMemo<CapabilityTarget[]>(
    () =>
      scope === "ai"
        ? [{ capability: "crm_extraction" }, { capability: "ask_answer" }]
        : mailboxId
          ? [
              { capability: "metadata_review", mailboxId },
              { capability: "mail_capture", mailboxId },
            ]
          : [],
    [scope, mailboxId],
  );
  const key = `${privacyKey}:${scope}:${mailboxId ?? ""}`;
  const latest = useRef({ key, available });
  latest.current = { key, available };
  const issuance = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [busy, setBusy] = useState<Capability | null>(null),
    [error, setError] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const current = useCallback(
    (ticket: number) =>
      issuance.current === ticket &&
      latest.current.key === key &&
      latest.current.available,
    [key],
  );
  const readTargets = useCallback(async () => {
    const results = await Promise.allSettled(
      targets.map(async (target) => ports.read(target)),
    );
    const rows: Partial<Record<Capability, View>> = {};
    results.forEach((result, index) => {
      const target = targets[index];
      if (
        target &&
        result.status === "fulfilled" &&
        result.value.capability === target.capability &&
        result.value.mailboxId === (target.mailboxId ?? null)
      )
        rows[target.capability] = result.value;
    });
    return rows;
  }, [ports, targets]);
  useEffect(() => {
    const sequence = issuance;
    const ticket = ++sequence.current;
    setSnapshot(null);
    setBusy(null);
    setError(null);
    void refresh;
    void refreshVersion;
    if (available)
      void readTargets().then((rows) => {
        if (current(ticket)) {
          setSnapshot({ key, rows });
          if (Object.keys(rows).length !== targets.length)
            setError(
              "Some controls could not be checked. Refresh before activating.",
            );
        }
      });
    return () => {
      sequence.current++;
    };
  }, [available, key, current, readTargets, targets, refresh, refreshVersion]);
  async function perform(target: CapabilityTarget, view: View) {
    if (!available || busy !== null || snapshot?.key !== key) return;
    if (!view.enabled && (!view.ready || view.authorityReceiptId === null))
      return;
    const ticket = ++issuance.current;
    setBusy(target.capability);
    setError(null);
    try {
      if (view.enabled)
        await ports.disable({ ...target, expectedRevision: view.revision });
      else
        await ports.activate({
          ...target,
          expectedRevision: view.revision,
          authorityReceiptId: view.authorityReceiptId!,
        });
      if (!current(ticket)) return;
      const rows = await readTargets();
      if (!current(ticket)) return;
      setSnapshot({ key, rows });
      onChange?.();
      if (Object.keys(rows).length !== targets.length)
        setError(
          "Saved, but some current controls could not be checked. Refresh before another action.",
        );
    } catch {
      if (current(ticket)) {
        setSnapshot(null);
        setError(
          "The action could not be confirmed. Refresh before another action.",
        );
      }
    } finally {
      if (current(ticket)) setBusy(null);
    }
  }
  const rows = snapshot?.key === key ? snapshot.rows : {};
  if (!available) return null;
  return (
    <section
      aria-label={
        scope === "mail"
          ? "Business email controls"
          : "Evidence and Ask controls"
      }
    >
      <h3>{scope === "mail" ? "Business email" : "Evidence and Ask"}</h3>
      <p>
        These controls do not authorize sending or change sending safeguards.
      </p>
      {scope === "mail" && !mailboxId ? (
        <p>Connect your own mailbox to prepare conversation capture.</p>
      ) : null}
      {targets.map((target) => {
        const description = descriptions[target.capability],
          view = rows[target.capability];
        const active = view?.enabled === true;
        return (
          <article key={target.capability}>
            <h4>
              {description.name[0]!.toUpperCase() + description.name.slice(1)}
            </h4>
            <p>{description.detail}</p>
            <p>
              {!view
                ? "Current availability has not been verified."
                : active
                  ? view.ready
                    ? "On."
                    : "On, but processing is blocked until current verification passes."
                  : !view.configured
                    ? "Not prepared. Independent review is required before activation."
                    : view.ready
                      ? "Ready to activate."
                      : "Off. Current verification is still required."}
            </p>
            <button
              type="button"
              disabled={
                busy !== null ||
                !view ||
                (!active && (!view.ready || view.authorityReceiptId === null))
              }
              onClick={() => {
                if (view) void perform(target, view);
              }}
            >
              {active ? "Disable" : "Activate"} {description.name}
            </button>
          </article>
        );
      })}
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh controls
      </button>
    </section>
  );
}
