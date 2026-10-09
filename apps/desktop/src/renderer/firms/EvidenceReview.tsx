import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
} from "react";
import type { z } from "zod";
import type {
  CanonicalSourceReference,
  CrmEvidencePage,
  crmEvidenceReadSchema,
  crmEvidenceDecidePayloadSchema,
  crmEvidenceDecidedSchema,
  crmDecisionHistoryListSchema,
  crmDecisionHistoryListPageSchema,
  crmDecisionHistoryReadSchema,
  crmDecisionHistoryPageSchema,
  crmConflictListSchema,
  crmConflictListPageSchema,
  crmConflictReadSchema,
  crmConflictPageSchema,
  crmConflictResolvePayloadSchema,
  crmConflictSavedSchema,
  crmConflictSavePayloadSchema,
  crmEvidenceWorkListSchema,
  crmEvidenceWorkListPageSchema,
  crmEvidenceWorkReadSchema,
  crmEvidenceWorkPageSchema,
  crmEvidenceWorkIdentitySchema,
  crmEvidenceWorkBindPayloadSchema,
  crmEvidenceWorkBoundSchema,
} from "@fss/contracts";
import {
  CommitmentReview,
  type CommitmentReviewPorts,
} from "./CommitmentReview.tsx";
import { Button } from "../ui/button.tsx";
export type EvidenceWorkIdentity = z.infer<
  typeof crmEvidenceWorkIdentitySchema
>;
export type EvidenceSource = Pick<
  CanonicalSourceReference,
  | "workspaceId"
  | "sourceId"
  | "kind"
  | "revision"
  | "contentHash"
  | "locator"
  | "availability"
>;
export interface EvidenceReviewPorts {
  commitmentStatus?: CommitmentReviewPorts["status"];
  commitmentReview?: CommitmentReviewPorts["review"];
  workBind?(
    input: z.infer<typeof crmEvidenceWorkBindPayloadSchema>,
  ): Promise<z.infer<typeof crmEvidenceWorkBoundSchema>>;
  workList?(
    input: z.infer<typeof crmEvidenceWorkListSchema>,
  ): Promise<z.infer<typeof crmEvidenceWorkListPageSchema>>;
  workRead?(
    input: z.infer<typeof crmEvidenceWorkReadSchema>,
  ): Promise<z.infer<typeof crmEvidenceWorkPageSchema>>;
  conflictSave?(
    input: z.infer<typeof crmConflictSavePayloadSchema>,
  ): Promise<z.infer<typeof crmConflictSavedSchema>>;
  conflictResolve?(
    input: z.infer<typeof crmConflictResolvePayloadSchema>,
  ): Promise<z.infer<typeof crmConflictSavedSchema>>;
  conflictList?(
    input: z.infer<typeof crmConflictListSchema>,
  ): Promise<z.infer<typeof crmConflictListPageSchema>>;
  conflictRead?(
    input: z.infer<typeof crmConflictReadSchema>,
  ): Promise<z.infer<typeof crmConflictPageSchema>>;
  read(input: z.infer<typeof crmEvidenceReadSchema>): Promise<CrmEvidencePage>;
  historyList?(
    input: z.infer<typeof crmDecisionHistoryListSchema>,
  ): Promise<z.infer<typeof crmDecisionHistoryListPageSchema>>;
  historyRead?(
    input: z.infer<typeof crmDecisionHistoryReadSchema>,
  ): Promise<z.infer<typeof crmDecisionHistoryPageSchema>>;
  decide?(
    input: z.infer<typeof crmEvidenceDecidePayloadSchema>,
  ): Promise<z.infer<typeof crmEvidenceDecidedSchema>>;
}
function claimTarget(claim: CrmEvidencePage["claims"][number]) {
  return {
    source: {
      workspaceId: claim.source.workspaceId,
      sourceId: claim.source.sourceId,
      kind: claim.source.kind,
      revision: claim.source.revision,
      contentHash: claim.source.contentHash,
      locator: null,
    },
    claimId: claim.claimId,
    claimRevision: claim.claimRevision,
    claimHash: claim.claimHash,
    contextHash: claim.contextHash,
    expectedDecisionRevision: claim.decisionRevision,
  };
}
export function EvidenceReview({
  sources,
  ports,
  enabled,
  recordId,
  privacyKey,
  sourceVersion,
  workContexts = [],
}: {
  sources: readonly EvidenceSource[];
  ports: EvidenceReviewPorts;
  enabled: boolean;
  recordId: string;
  privacyKey: string | object | null;
  sourceVersion?: string | undefined;
  workContexts?: readonly z.infer<typeof crmEvidenceWorkIdentitySchema>[];
}): JSX.Element {
  const [comparisonMembers, setComparisonMembers] = useState<
    CrmEvidencePage["claims"]
  >([]);
  const selectedClaims = comparisonMembers.map((claim) => claim.claimId);
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState<CrmEvidencePage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<
    CrmEvidencePage["claims"][number] | null
  >(null);
  const [correction, setCorrection] = useState("");
  const [rationale, setRationale] = useState("");
  const [historyRefs, setHistoryRefs] = useState<z.infer<
    typeof crmDecisionHistoryListPageSchema
  > | null>(null);
  const [historySource, setHistorySource] = useState<Pick<
    CanonicalSourceReference,
    "kind" | "sourceId"
  > | null>(null);
  const [history, setHistory] = useState<z.infer<
    typeof crmDecisionHistoryPageSchema
  > | null>(null);
  const [discoverySource, setDiscoverySource] = useState<EvidenceSource | null>(
    null,
  );
  const [conflictRefs, setConflictRefs] = useState<z.infer<
    typeof crmConflictListPageSchema
  > | null>(null);
  const [conflict, setConflict] = useState<z.infer<
    typeof crmConflictPageSchema
  > | null>(null);
  const [workRefs, setWorkRefs] = useState<z.infer<
    typeof crmEvidenceWorkListPageSchema
  > | null>(null);
  const [work, setWork] = useState<z.infer<
    typeof crmEvidenceWorkPageSchema
  > | null>(null);
  const workIdentity = JSON.stringify(workContexts);
  const sourceIdentity = JSON.stringify(
    sources.map((source) => [
      source.workspaceId,
      source.sourceId,
      source.kind,
      source.revision,
      source.contentHash,
      source.availability,
    ]),
  );
  const epoch = useRef(0);
  const invalidate = useCallback(() => ++epoch.current, []);
  const clearSource = useCallback((preserveComparison = false) => {
    setDiscoverySource(null);
    setPage(null);
    if (!preserveComparison) setComparisonMembers([]);
    setNotice("");
    setEditing(null);
    setCorrection("");
    setRationale("");
    setHistoryRefs(null);
    setHistorySource(null);
    setHistory(null);
    setConflictRefs(null);
    setConflict(null);
    setWorkRefs(null);
    setWork(null);
  }, []);
  useLayoutEffect(() => {
    invalidate();
    clearSource();
    setError("");
    setBusy(false);
    return () => {
      invalidate();
    };
  }, [
    ports,
    enabled,
    recordId,
    privacyKey,
    sourceVersion,
    sourceIdentity,
    workIdentity,
    invalidate,
    clearSource,
  ]);
  const read = async (
    source: EvidenceSource,
    cursors?: { afterClaimId?: string; afterReviewedAnchorId?: string },
  ) => {
    const ticket = invalidate();
    clearSource(true);
    setBusy(true);
    setError("");
    try {
      const value = await ports.read({
        source: {
          workspaceId: source.workspaceId,
          sourceId: source.sourceId,
          kind: source.kind,
          revision: source.revision,
          contentHash: source.contentHash,
          locator: null,
        },
        ...cursors,
        limit: 50,
      });
      if (ticket !== epoch.current) return;
      if (
        value.source.workspaceId !== source.workspaceId ||
        value.source.sourceId !== source.sourceId ||
        value.source.kind !== source.kind ||
        value.source.revision !== source.revision ||
        value.source.contentHash !== source.contentHash
      )
        throw new Error("source_changed");
      const contextHashes = new Set(
        [...value.claims, ...value.reviewedHistory].map(
          (claim) => claim.contextHash,
        ),
      );
      setComparisonMembers((members) =>
        members.filter(
          (claim) =>
            claim.source.kind !== source.kind ||
            claim.source.sourceId !== source.sourceId ||
            contextHashes.has(claim.contextHash),
        ),
      );
      setPage(value);
    } catch {
      if (ticket === epoch.current) {
        setPage(null);
        setComparisonMembers([]);
        setNotice("");
        setError(
          "Evidence is unavailable. Refresh the source and check current access.",
        );
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const listHistory = async (source: EvidenceSource, afterId?: string) => {
    if (!ports.historyList) return;
    const ticket = invalidate();
    setDiscoverySource(null);
    setPage(null);
    setComparisonMembers([]);
    setNotice("");
    setEditing(null);
    setCorrection("");
    setRationale("");
    setHistoryRefs(null);
    setHistory(null);
    setConflictRefs(null);
    setConflict(null);
    setWorkRefs(null);
    setWork(null);
    setBusy(true);
    setError("");
    const selected = { kind: source.kind, sourceId: source.sourceId };
    setHistorySource(selected);
    try {
      const value = await ports.historyList({
        ...selected,
        ...(afterId === undefined ? {} : { afterId }),
        limit: 50,
      });
      if (ticket === epoch.current) setHistoryRefs(value);
    } catch {
      if (ticket === epoch.current) {
        setHistorySource(null);
        setError(
          "Decision history is unavailable. Check current source access.",
        );
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const openHistory = async (anchorId: string, beforeRevision?: number) => {
    if (!ports.historyRead || historySource === null) return;
    const selected = historySource,
      ticket = invalidate();
    setPage(null);
    setComparisonMembers([]);
    setNotice("");
    setHistory(null);
    setConflictRefs(null);
    setConflict(null);
    setWorkRefs(null);
    setWork(null);
    setBusy(true);
    setError("");
    try {
      const value = await ports.historyRead({
        ...selected,
        anchorId,
        ...(beforeRevision === undefined ? {} : { beforeRevision }),
        limit: 50,
      });
      if (ticket !== epoch.current) return;
      if (
        value.kind !== selected.kind ||
        value.sourceId !== selected.sourceId ||
        value.anchorId !== anchorId
      )
        throw new Error("source_changed");
      setHistory(value);
    } catch {
      if (ticket === epoch.current) {
        setHistoryRefs(null);
        setHistorySource(null);
        setError(
          "Decision history is unavailable. Check current source access.",
        );
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const listConflicts = async (source: EvidenceSource, afterId?: string) => {
    if (!ports.conflictList) return;
    const ticket = invalidate();
    clearSource();
    setBusy(true);
    setError("");
    setDiscoverySource(source);
    try {
      const value = await ports.conflictList({
        kind: source.kind,
        sourceId: source.sourceId,
        ...(afterId === undefined ? {} : { afterId }),
        limit: 50,
      });
      if (ticket === epoch.current) setConflictRefs(value);
    } catch {
      if (ticket === epoch.current)
        setError("Conflicts are unavailable. Check current source access.");
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const openConflict = async (conflictId: string, afterRevision?: number) => {
    if (!ports.conflictRead) return;
    const ticket = invalidate();
    setConflict(null);
    setWorkRefs(null);
    setWork(null);
    setBusy(true);
    setError("");
    try {
      const value = await ports.conflictRead({
        conflictId,
        ...(afterRevision === undefined ? {} : { afterRevision }),
        limit: 50,
      });
      if (ticket !== epoch.current) return;
      if (
        value.conflictId !== conflictId ||
        value.members.some(
          (member) =>
            member.source.availability !== "available" ||
            member.source.contentHash === null,
        )
      )
        throw new Error("source_changed");
      setConflict(value);
    } catch {
      if (ticket === epoch.current) {
        setConflictRefs(null);
        setError(
          "Conflict evidence is unavailable. Refresh current source access.",
        );
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const resolveConflict = async (preferredAnchorId?: string) => {
    if (!ports.conflictResolve || conflict === null) return;
    const selected = conflict,
      ticket = invalidate();
    setConflict(null);
    setWorkRefs(null);
    setWork(null);
    setBusy(true);
    setError("");
    try {
      await ports.conflictResolve({
        conflictId: selected.conflictId,
        expectedConflictRevision: selected.revision,
        ...(preferredAnchorId
          ? { resolution: "prefer_claim" as const, preferredAnchorId }
          : { resolution: "keep_both" as const }),
      });
      if (ticket === epoch.current) await openConflict(selected.conflictId);
    } catch {
      if (ticket === epoch.current) {
        setConflictRefs(null);
        setError(
          "Resolution could not be saved. Reload the current conflict before trying again.",
        );
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const saveConflict = async () => {
    if (!ports.conflictSave) return;
    const members = comparisonMembers.filter((claim) =>
      sources.some(
        (source) =>
          source.availability === "available" &&
          source.workspaceId === claim.source.workspaceId &&
          source.kind === claim.source.kind &&
          source.sourceId === claim.source.sourceId &&
          source.revision === claim.source.revision &&
          source.contentHash === claim.source.contentHash,
      ),
    );
    if (members.length < 2 || members.length > 10) return;
    const ticket = invalidate();
    setDiscoverySource(null);
    setPage(null);
    setComparisonMembers([]);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await ports.conflictSave({
        expectedConflictRevision: 0,
        members: members.map(claimTarget),
      });
      if (ticket === epoch.current)
        setNotice(
          "Conflict saved. Reload conflicts to review the current group.",
        );
    } catch {
      if (ticket === epoch.current)
        setError(
          "Conflict could not be saved. Reload current evidence before trying again.",
        );
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const listWork = async (
    source: EvidenceSource,
    after?: EvidenceWorkIdentity,
  ) => {
    if (!ports.workList) return;
    const ticket = invalidate();
    clearSource();
    setBusy(true);
    setError("");
    setDiscoverySource(source);
    try {
      const value = await ports.workList({
        kind: source.kind,
        sourceId: source.sourceId,
        ...(after === undefined ? {} : { after }),
        limit: 50,
      });
      if (ticket === epoch.current) setWorkRefs(value);
    } catch {
      if (ticket === epoch.current)
        setError("Dependent work is unavailable. Check current source access.");
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const openWork = async (
    identity: z.infer<typeof crmEvidenceWorkIdentitySchema>,
    afterDependencyId?: string,
  ) => {
    if (!ports.workRead) return;
    const ticket = invalidate();
    setWork(null);
    setBusy(true);
    setError("");
    try {
      const value = await ports.workRead({
        work: identity,
        ...(afterDependencyId === undefined ? {} : { afterDependencyId }),
        limit: 50,
      });
      if (ticket !== epoch.current) return;
      if (value.work.kind !== identity.kind || value.work.id !== identity.id)
        throw new Error("work_changed");
      setWork(value);
    } catch {
      if (ticket === epoch.current) {
        setWorkRefs(null);
        setError("Dependent work is unavailable. Reload current access.");
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const bindWork = async (
    claim: CrmEvidencePage["claims"][number],
    identity: z.infer<typeof crmEvidenceWorkIdentitySchema>,
  ) => {
    if (
      !ports.workRead ||
      !ports.workBind ||
      !workContexts.some(
        (item) => item.kind === identity.kind && item.id === identity.id,
      ) ||
      !supported(claim)
    )
      return;
    const ticket = invalidate();
    setDiscoverySource(null);
    setPage(null);
    setComparisonMembers([]);
    setEditing(null);
    setCorrection("");
    setRationale("");
    setNotice("");
    setBusy(true);
    setError("");
    try {
      const current = await ports.workRead({ work: identity, limit: 50 });
      if (ticket !== epoch.current) return;
      if (
        current.work.kind !== identity.kind ||
        current.work.id !== identity.id
      )
        throw new Error("work_changed");
      await ports.workBind({
        ...claimTarget(claim),
        work: { ...identity, expectedVersion: current.work.version },
      });
      if (ticket === epoch.current)
        setNotice("Evidence dependency saved. Task status is unchanged.");
    } catch {
      if (ticket === epoch.current)
        setError(
          "Task support could not be saved. Reload current evidence and task context.",
        );
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const decide = async (
    claim: CrmEvidencePage["claims"][number],
    action: "confirm" | "dismiss" | "correct",
  ) => {
    if (!ports.decide || page === null) return;
    const selected = page.source,
      ticket = invalidate();
    setPage(null);
    setComparisonMembers([]);
    setNotice("");
    setBusy(true);
    setError("");
    try {
      await ports.decide({
        ...claimTarget(claim),
        ...(action === "correct"
          ? {
              action,
              correctedInterpretation: correction.trim(),
              ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
            }
          : { action }),
      });
      if (ticket === epoch.current) {
        setEditing(null);
        setCorrection("");
        setRationale("");
      }
      if (ticket === epoch.current) await read(selected);
    } catch {
      if (ticket === epoch.current) {
        setPage(null);
        setComparisonMembers([]);
        setNotice("");
        setEditing(null);
        setCorrection("");
        setRationale("");
        setError(
          "Review could not be saved. Refresh the source and current decision before trying again.",
        );
      }
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };
  const supported = (claim: CrmEvidencePage["claims"][number]) =>
    page !== null &&
    claim.source.availability === "available" &&
    claim.source.workspaceId === page.source.workspaceId &&
    claim.source.sourceId === page.source.sourceId &&
    claim.source.kind === page.source.kind &&
    claim.source.revision === page.source.revision &&
    claim.source.contentHash === page.source.contentHash;
  const interpretation = (
    claim: CrmEvidencePage["claims"][number],
    historical: boolean,
    index: number,
  ) => (
    <article key={`${historical ? "history" : "current"}:${claim.claimId}`}>
      {historical ? <p>Previously reviewed interpretation</p> : null}
      {!historical && ports.conflictSave ? (
        <label>
          <input
            type="checkbox"
            aria-label={`Conflict member interpretation ${index + 1}`}
            disabled={
              busy ||
              (!selectedClaims.includes(claim.claimId) &&
                selectedClaims.length >= 10)
            }
            checked={selectedClaims.includes(claim.claimId)}
            onChange={(event) =>
              setComparisonMembers((members) =>
                event.target.checked
                  ? [...members, claim]
                  : members.filter(
                      (member) => member.claimId !== claim.claimId,
                    ),
              )
            }
          />
          Include in evidence conflict
        </label>
      ) : null}
      <p>
        AI interpretation · {claim.status} · {claim.effectiveState}
      </p>
      <p>{claim.interpretation}</p>
      <blockquote>{claim.quote}</blockquote>
      <p>
        Source revision {claim.source.revision} ·{" "}
        {claim.source.locator ?? "Passage location unavailable"} ·{" "}
        {claim.source.speaker ?? "Speaker unknown"}
      </p>
      {claim.reviewRequired ? (
        <p>Material evidence changed. Human review is required.</p>
      ) : null}
      {claim.decision ? (
        <div>
          <p>
            Human {claim.decision.action} · {claim.decision.decisionAt}
          </p>
          {claim.decision.correctedInterpretation ? (
            <p>Human correction: {claim.decision.correctedInterpretation}</p>
          ) : null}
          {claim.decision.rationale ? <p>{claim.decision.rationale}</p> : null}
        </div>
      ) : null}
      {ports.decide ? (
        <Button disabled={busy} onClick={() => void decide(claim, "confirm")}>
          Confirm{" "}
          {historical ? "previously reviewed interpretation" : "interpretation"}{" "}
          {index + 1}
        </Button>
      ) : null}
      {ports.decide ? (
        <Button disabled={busy} onClick={() => void decide(claim, "dismiss")}>
          Dismiss{" "}
          {historical ? "previously reviewed interpretation" : "interpretation"}{" "}
          {index + 1}
        </Button>
      ) : null}
      {ports.decide ? (
        <Button
          disabled={busy}
          onClick={() => {
            setEditing(claim);
            setCorrection("");
            setRationale("");
          }}
        >
          Correct{" "}
          {historical ? "previously reviewed interpretation" : "interpretation"}{" "}
          {index + 1}
        </Button>
      ) : null}
      {ports.workBind && ports.workRead
        ? workContexts.map((identity, taskIndex) => (
            <Button
              key={`${identity.kind}:${identity.id}`}
              disabled={busy}
              onClick={() => void bindWork(claim, identity)}
            >
              Support existing task {taskIndex + 1} with interpretation{" "}
              {index + 1}
            </Button>
          ))
        : null}
      {!historical &&
      claim.kind === "commitment" &&
      ports.commitmentStatus &&
      ports.commitmentReview ? (
        <CommitmentReview
          target={claimTarget(claim)}
          quote={claim.quote}
          index={index + 1}
          ports={{
            status: ports.commitmentStatus,
            review: ports.commitmentReview,
          }}
          enabled={!busy && enabled}
          privacyKey={privacyKey}
          onUnavailable={() => {
            invalidate();
            clearSource();
            setError(
              "Promise evidence is unavailable. Refresh current source access before reviewing it again.",
            );
          }}
        />
      ) : null}
      {claim.decisionHistoryTruncated ? (
        <p>More dated decisions exist.</p>
      ) : null}
    </article>
  );
  return (
    <section aria-label="Evidence review">
      <h4>Evidence review</h4>
      <p>
        AI interpretations are proposals. Human review preserves original
        evidence and dated decisions.
      </p>
      {enabled ? (
        <>
          {error ? <p role="alert">{error}</p> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {sources.map((source, index) => (
            <div key={source.sourceId}>
              <Button
                disabled={
                  busy ||
                  source.availability !== "available" ||
                  source.contentHash === null
                }
                onClick={() => void read(source)}
              >
                Review evidence {index + 1}
              </Button>
              {ports.historyList && ports.historyRead ? (
                <Button
                  disabled={busy}
                  onClick={() => void listHistory(source)}
                >
                  Review decision history {index + 1}
                </Button>
              ) : null}
              {ports.conflictList && ports.conflictRead ? (
                <Button
                  disabled={busy}
                  onClick={() => void listConflicts(source)}
                >
                  Review conflicts for evidence {index + 1}
                </Button>
              ) : null}
              {ports.workList && ports.workRead ? (
                <Button disabled={busy} onClick={() => void listWork(source)}>
                  Review dependent work for evidence {index + 1}
                </Button>
              ) : null}
            </div>
          ))}
          {comparisonMembers.length > 0 ? (
            <section aria-label="Selected evidence comparison">
              <p>
                Compare selected interpretations from current record sources.
                Saving preserves both original passages.
              </p>
              {comparisonMembers.map((member, index) => (
                <article
                  key={`${member.source.kind}:${member.source.sourceId}:${member.claimId}`}
                >
                  <p>
                    Comparison member {index + 1}: {member.interpretation}
                  </p>
                  <blockquote>{member.quote}</blockquote>
                  <p>
                    Source {member.source.kind} · revision{" "}
                    {member.source.revision} · Original event{" "}
                    {member.source.occurredAt ?? "unknown"} · observed{" "}
                    {member.source.observedAt}
                  </p>
                  <p>
                    {member.source.locator ?? "Passage location unavailable"} ·{" "}
                    {member.source.speaker ?? "Speaker unknown"}
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      setComparisonMembers((members) =>
                        members.filter(
                          (claim) => claim.claimId !== member.claimId,
                        ),
                      )
                    }
                  >
                    Remove comparison member {index + 1}
                  </Button>
                </article>
              ))}
            </section>
          ) : null}
          {workRefs?.nextAfter && discoverySource ? (
            <Button
              disabled={busy}
              onClick={() =>
                void listWork(discoverySource, workRefs.nextAfter ?? undefined)
              }
            >
              More dependent work references
            </Button>
          ) : null}
          {conflictRefs?.nextAfterId && discoverySource ? (
            <Button
              disabled={busy}
              onClick={() =>
                void listConflicts(
                  discoverySource,
                  conflictRefs.nextAfterId ?? undefined,
                )
              }
            >
              More conflict references
            </Button>
          ) : null}
          {historyRefs?.nextAfterId && historySource ? (
            <Button
              disabled={busy}
              onClick={() => {
                const selected = sources.find(
                  (source) =>
                    source.kind === historySource.kind &&
                    source.sourceId === historySource.sourceId,
                );
                if (selected)
                  void listHistory(
                    selected,
                    historyRefs.nextAfterId ?? undefined,
                  );
              }}
            >
              More decision history references
            </Button>
          ) : null}
          {workRefs?.works.map((ref, index) => (
            <Button
              key={`${ref.work.kind}:${ref.work.id}`}
              disabled={busy}
              onClick={() => void openWork(ref.work)}
            >
              Open dependent work {index + 1}
            </Button>
          ))}
          {work ? (
            <section aria-label="Evidence dependent work">
              <p>
                Actual action: {work.work.status} ·{" "}
                {work.work.completedAt
                  ? `completed ${work.work.completedAt}`
                  : "completion date unknown"}
              </p>
              <p>
                Evidence review does not reopen or alter a completed action.
              </p>
              {work.dependencies.map((item) => (
                <article key={item.dependencyId}>
                  <p>
                    {item.reviewRequired
                      ? `Evidence review required: ${item.reason ?? "reason unknown"}`
                      : "Evidence dependency unchanged"}
                  </p>
                  <p>
                    Observed decision revision {item.observedDecisionRevision} ·
                    dependency revision {item.revision}
                  </p>
                </article>
              ))}
              {work.nextAfterDependencyId ? (
                <>
                  <p>
                    More evidence dependencies exist beyond this bounded page.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void openWork(
                        { kind: work.work.kind, id: work.work.id },
                        work.nextAfterDependencyId ?? undefined,
                      )
                    }
                  >
                    More evidence dependencies
                  </Button>
                </>
              ) : null}
            </section>
          ) : null}
          {conflictRefs?.conflicts.map((ref, index) => (
            <Button
              key={ref.conflictId}
              disabled={busy}
              onClick={() => void openConflict(ref.conflictId)}
            >
              Open conflict {index + 1}
            </Button>
          ))}
          {conflict ? (
            <section aria-label="Conflicting evidence">
              <p>Import time does not decide which interpretation is true.</p>
              <p>
                Current group revision {conflict.revision} · {conflict.state}
              </p>
              {conflict.resolution ? (
                <p>
                  Human resolution: {conflict.resolution} · {conflict.decidedAt}
                </p>
              ) : null}
              {conflict.preferredAnchorId !== null ? (
                <p>
                  Human preferred interpretation:{" "}
                  {conflict.members.findIndex(
                    (member) => member.anchorId === conflict.preferredAnchorId,
                  ) + 1}
                </p>
              ) : null}
              {ports.conflictResolve ? (
                <Button disabled={busy} onClick={() => void resolveConflict()}>
                  Keep both interpretations
                </Button>
              ) : null}
              {conflict.members.map((member) => (
                <article key={member.anchorId}>
                  <p>AI interpretation · {member.status}</p>
                  <p>{member.interpretation}</p>
                  <blockquote>{member.quote}</blockquote>
                  {ports.conflictResolve ? (
                    <Button
                      disabled={busy}
                      onClick={() => void resolveConflict(member.anchorId)}
                    >
                      Prefer interpretation{" "}
                      {conflict.members.indexOf(member) + 1}
                    </Button>
                  ) : null}
                  <p>
                    {member.source.occurredAt === null
                      ? "Original event date unknown"
                      : `Original event date: ${member.source.occurredAt}`}
                  </p>
                  <p>Source observed: {member.source.observedAt}</p>
                  <p>
                    Source revision {member.source.revision} ·{" "}
                    {member.source.locator ?? "Passage location unavailable"} ·{" "}
                    {member.source.speaker ?? "Speaker unknown"}
                  </p>
                </article>
              ))}
              {conflict.history.map((item) => (
                <p key={item.revision}>
                  Group revision {item.revision} · {item.state} ·{" "}
                  {item.decidedAt} · {item.memberAnchorIds.length} members
                </p>
              ))}
              {conflict.nextAfterRevision !== null ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void openConflict(
                      conflict.conflictId,
                      conflict.nextAfterRevision ?? undefined,
                    )
                  }
                >
                  More conflict revisions
                </Button>
              ) : null}
            </section>
          ) : null}
          {historyRefs?.anchors.map((anchor, index) => (
            <Button
              key={anchor.anchorId}
              disabled={busy}
              onClick={() => void openHistory(anchor.anchorId)}
            >
              Open decision history {index + 1}
            </Button>
          ))}
          {history ? (
            <section aria-label="Dated decision history">
              {history.basis !== "deleted_redacted" ? (
                <>
                  <p>
                    Recorded original event:{" "}
                    {history.originalEventAt ?? "unknown"}
                  </p>
                  <p>
                    Recorded source observation:{" "}
                    {history.originalObservedAt ?? "unknown"}
                  </p>
                </>
              ) : null}
              <p>
                {history.basis === "deleted_redacted"
                  ? "Source content and original dates have been removed. Dated review actions remain."
                  : history.basis === "source_unavailable"
                    ? "Original source is unavailable; these are dated review actions."
                    : "Dated human review actions"}
              </p>
              {history.decisions.map((decision) => (
                <article key={decision.revision}>
                  <p>
                    Human {decision.action} · {decision.decisionAt} · revision{" "}
                    {decision.revision}
                  </p>
                  {decision.redacted ? (
                    <p>Correction and rationale redacted</p>
                  ) : (
                    <>
                      {decision.correctedInterpretation ? (
                        <p>
                          Human correction: {decision.correctedInterpretation}
                        </p>
                      ) : null}
                      {decision.rationale ? <p>{decision.rationale}</p> : null}
                    </>
                  )}
                </article>
              ))}
              {history.nextBeforeRevision !== null ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void openHistory(
                      history.anchorId,
                      history.nextBeforeRevision ?? undefined,
                    )
                  }
                >
                  Older decision actions
                </Button>
              ) : null}
            </section>
          ) : null}
          {editing ? (
            <section aria-label="Human correction editor">
              <label>
                Human interpretation correction
                <textarea
                  aria-label="Human interpretation correction"
                  value={correction}
                  maxLength={1000}
                  onChange={(event) => setCorrection(event.target.value)}
                />
              </label>
              <label>
                Decision rationale
                <textarea
                  aria-label="Decision rationale"
                  value={rationale}
                  maxLength={1000}
                  onChange={(event) => setRationale(event.target.value)}
                />
              </label>
              <Button
                disabled={busy || !correction.trim()}
                onClick={() => void decide(editing, "correct")}
              >
                Save human correction
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setCorrection("");
                  setRationale("");
                }}
              >
                Cancel human correction
              </Button>
            </section>
          ) : null}
          {page ? (
            <section aria-label="Selected source interpretations">
              <p>
                {page.source.occurredAt === null
                  ? "Original event date unknown"
                  : `Original event date: ${page.source.occurredAt}`}
              </p>
              <p>Source observed: {page.source.observedAt}</p>
              <p>
                This source page: {page.projection.counts.current} current
                interpretations, {page.projection.counts.reviewedHistory}{" "}
                previously reviewed interpretations.
              </p>
              {page.projection.truncated ? (
                <>
                  <p>More evidence exists beyond this bounded page.</p>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void read(page.source, {
                        ...(page.nextAfterClaimId === null
                          ? {}
                          : { afterClaimId: page.nextAfterClaimId }),
                        ...(page.nextAfterReviewedAnchorId === null
                          ? {}
                          : {
                              afterReviewedAnchorId:
                                page.nextAfterReviewedAnchorId,
                            }),
                      })
                    }
                  >
                    Next evidence page
                  </Button>
                </>
              ) : null}
              {ports.conflictSave ? (
                <Button
                  disabled={busy || selectedClaims.length < 2}
                  onClick={() => void saveConflict()}
                >
                  Save evidence conflict
                </Button>
              ) : null}
              {page.claims.length === 0 ? (
                <p>No current interpretations on this page.</p>
              ) : null}
              {page.claims
                .filter(supported)
                .map((claim, index) => interpretation(claim, false, index))}
              {page.reviewedHistory
                .filter(supported)
                .map((claim, index) => interpretation(claim, true, index))}
            </section>
          ) : null}
        </>
      ) : (
        <p>Evidence unavailable.</p>
      )}
    </section>
  );
}
