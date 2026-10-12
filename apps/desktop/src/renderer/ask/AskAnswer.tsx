import { askResponseSchema } from "@fss/contracts";
import { AskFollowOn, type AskFollowOnPorts } from "./AskFollowOn.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type {
  askAnswerRequestPayloadSchema,
  askAnswerAcknowledgmentSchema,
  askAnswerReadSchema,
  AskAnswerReadResult,
  askAnswerSourceReadSchema,
  askAnswerSourceResultSchema,
  askAnswerCancelPayloadSchema,
  askAnswerCancelledSchema,
  askAnswerInvestigationPreviewSchema,
  askAnswerInvestigationPreviewResultSchema,
  askAnswerInvestigationCommitSchema,
} from "@fss/contracts";
export interface AskAnswerPorts {
  answerCancel(
    input: z.infer<typeof askAnswerCancelPayloadSchema>,
  ): Promise<z.infer<typeof askAnswerCancelledSchema>>;
  investigationPreview(
    input: z.infer<typeof askAnswerInvestigationPreviewSchema>,
  ): Promise<z.infer<typeof askAnswerInvestigationPreviewResultSchema>>;
  investigationCommit(
    input: Omit<
      z.infer<typeof askAnswerInvestigationCommitSchema>,
      "commandId" | "clientVersion"
    >,
  ): Promise<z.infer<typeof askAnswerAcknowledgmentSchema>>;
  answerRequest(
    input: z.infer<typeof askAnswerRequestPayloadSchema>,
  ): Promise<z.infer<typeof askAnswerAcknowledgmentSchema>>;
  answerRead(
    input: z.infer<typeof askAnswerReadSchema>,
  ): Promise<AskAnswerReadResult>;
  answerSourceRead(
    input: z.infer<typeof askAnswerSourceReadSchema>,
  ): Promise<z.infer<typeof askAnswerSourceResultSchema>>;
}
const reasons = {
  processing_cancelled:
    "Investigation cancelled; already dispatched calls still settle. No further calls will be started.",
  identity_clarification_required:
    "Several identities or contexts are plausible. Choose the intended record before continuing.",
  purpose_unavailable:
    "Explanations are unavailable until processing is configured.",
  evaluation_unavailable:
    "Explanations are unavailable until evaluation is verified.",
  processing_authority_unavailable: "Processing permission is unavailable.",
  budget_held: "Processing budget is held.",
  input_bound_reached: "The selected input exceeds the processing limit.",
  step_bound_reached: "The investigation reached its model-step limit before producing an answer.",
  source_unavailable:
    "Selected sources are unavailable. Select current source versions again.",
  source_changed:
    "Source evidence changed. Select current source versions again.",
  purpose_changed:
    "Processing configuration changed. Check current availability.",
  provider_acceptance_unknown:
    "Processing acceptance is unknown. Check this request; do not submit it again.",
  processing_failed:
    "Processing failed. Original evidence may still be available below.",
  unsupported_answer: "No supported explanation could be established.",
  deleted: "This explanation was deleted.",
};
const missingEvidence = {
  identity_unresolved:
    "No permitted record matched this name. Refine the name or select a CRM record.",
  exact_state_changed:
    "Exact CRM state changed after this answer. Changed observations are withheld; request a fresh investigation.",
  no_supported_answer: "No supported answer was established.",
  inference_unverified: "An inference could not be verified.",
  conflict_unresolved: "Conflicting evidence remains unresolved.",
  input_partial: "Some input evidence was not processed.",
  semantic_coverage_unverified: "Semantic coverage is unverified.",
  no_relevant_passages: "No relevant passages were established.",
};
function resultNotice(result: AskAnswerReadResult) {
  if (result.state === "stale")
    return "This explanation is stale. Select current source versions again.";
  if (result.state === "deleted") return reasons.deleted;
  if (result.state === "unknown_acceptance")
    return reasons.provider_acceptance_unknown;
  return result.reason === null ? null : reasons[result.reason];
}
type AskAnswerProps = {
  ports: Partial<AskAnswerPorts> & Partial<AskFollowOnPorts>;
  enabled: boolean;
  onUnavailable?: () => void;
} & (
  | (z.infer<typeof askAnswerRequestPayloadSchema> & {
      existingRequestId?: never;
    })
  | { existingRequestId: string; question?: never; scope?: never }
);
export function AskAnswer({
  ports,
  enabled,
  question,
  scope,
  existingRequestId,
  onUnavailable,
}: AskAnswerProps) {
  const [controlBusy, setControlBusy] = useState(false);
  const [preview, setPreview] = useState<{
    input: z.infer<typeof askAnswerInvestigationPreviewSchema>;
    value: z.infer<typeof askAnswerInvestigationPreviewResultSchema>;
  } | null>(null);
  const [finding, setFinding] = useState<{
    kind: "answer_claim" | "keyword_passage";
    index: number;
  } | null>(null);
  const [result, setResult] = useState<AskAnswerReadResult | null>(null);
  const [opened, setOpened] = useState<z.infer<
    typeof askAnswerSourceResultSchema
  > | null>(null);
  const sourceEpoch = useRef(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(
    existingRequestId ?? null,
  );
  const [requested, setRequested] = useState(existingRequestId !== undefined);
  const [reading, setReading] = useState(false);
  const epoch = useRef(0);
  const invalidate = useCallback(() => ++epoch.current, []);
  const answerRead = ports.answerRead;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const readAnswer = useCallback(
    async function readCurrent(id: string, captured: number, remaining = 10) {
      if (!answerRead || captured !== epoch.current) return;
      setReading(true);
      setPreview(null);
      setFinding(null);
      setOpened(null);
      sourceEpoch.current++;
      try {
        const fresh = await answerRead({ requestId: id, includeExactResultCitations: true });
        if (captured !== epoch.current) return;
        if (fresh.requestId !== id) throw new Error("request_changed");
        setResult(fresh);
        if (
          fresh.state === "stale" ||
          fresh.state === "deleted" ||
          fresh.reason === "source_unavailable"
        )
          onUnavailable?.();
        if (fresh.state === "pending") {
          setNotice(
            remaining > 1
              ? "Explanation pending."
              : "Still pending. Automatic checks stopped; check this request again when ready.",
          );
          if (remaining > 1)
            timer.current = setTimeout(() => {
              void readCurrent(id, captured, remaining - 1);
            }, 2000);
        } else setNotice(null);
      } catch {
        if (captured === epoch.current) {
          setResult(null);
          onUnavailable?.();
          setNotice(
            "Explanation unavailable. Search selected copies for original evidence.",
          );
        }
      } finally {
        if (captured === epoch.current) setReading(false);
      }
    },
    [answerRead, onUnavailable],
  );
  useEffect(() => {
    if (existingRequestId !== undefined && enabled)
      void readAnswer(existingRequestId, invalidate());
    return () => {
      invalidate();
      clearTimeout(timer.current);
    };
  }, [existingRequestId, enabled, readAnswer, invalidate]);
  async function explain() {
    if (
      !enabled ||
      existingRequestId !== undefined ||
      question === undefined ||
      scope === undefined ||
      !ports.answerRequest ||
      !ports.answerRead
    )
      return;
    const captured = ++epoch.current;
    setRequested(true);
    setResult(null);
    setNotice("Requesting explanation…");
    try {
      const ack = await ports.answerRequest({
        question: question.trim(),
        scope,
      });
      if (captured !== epoch.current) return;
      setRequestId(ack.requestId);
      await readAnswer(ack.requestId, captured);
    } catch {
      if (captured === epoch.current)
        setNotice(
          "Explanation unavailable. Search selected copies for original evidence.",
        );
    }
  }
  async function cancelInvestigation() {
    if (
      !enabled ||
      !result ||
      result.state !== "pending" ||
      !ports.answerCancel
    )
      return;
    const captured = epoch.current;
    setControlBusy(true);
    setPreview(null);
    clearTimeout(timer.current);
    try {
      await ports.answerCancel({
        requestId: result.requestId,
        expectedVersion: result.version,
      });
      if (captured === epoch.current)
        await readAnswer(result.requestId, captured);
    } catch {
      if (captured === epoch.current)
        setNotice(
          "Cancellation could not be confirmed. Check this investigation.",
        );
    } finally {
      if (captured === epoch.current) setControlBusy(false);
    }
  }
  async function previewInvestigation(
    mode: "further" | "retry",
    agentScope?: z.infer<
      typeof askAnswerInvestigationPreviewSchema
    >["agentScope"],
  ) {
    if (!enabled || !result || !ports.investigationPreview) return;
    const captured = epoch.current;
    setControlBusy(true);
    setPreview(null);
    const input = {
      requestId: result.requestId,
      expectedVersion: result.version,
      mode,
      ...(agentScope === undefined ? {} : { agentScope }),
    };
    try {
      const value = await ports.investigationPreview(input);
      if (captured === epoch.current) {
        setPreview({ input, value });
        setNotice(
          value.available
            ? null
            : `Investigation unavailable: ${value.reason ?? "permission unavailable"}.`,
        );
      }
    } catch {
      if (captured === epoch.current)
        setNotice("Current allowance could not be verified.");
    } finally {
      if (captured === epoch.current) setControlBusy(false);
    }
  }
  async function confirmInvestigation() {
    if (
      !enabled ||
      !preview?.value.available ||
      !preview.value.previewHash ||
      !ports.investigationCommit
    )
      return;
    const captured = epoch.current;
    setControlBusy(true);
    try {
      const ack = await ports.investigationCommit({
        ...preview.input,
        previewHash: preview.value.previewHash,
      });
      if (captured !== epoch.current) return;
      setPreview(null);
      setRequestId(ack.requestId);
      setResult(null);
      await readAnswer(ack.requestId, ++epoch.current);
    } catch {
      if (captured === epoch.current) {
        setPreview(null);
        setNotice(
          "Investigation could not be confirmed. Obtain a current preview before trying again.",
        );
      }
    } finally {
      setControlBusy(false);
    }
  }
  async function openCitation(windowId: string) {
    if (!enabled || !ports.answerSourceRead || result?.state !== "complete")
      return;
    const captured = epoch.current,
      selected = ++sourceEpoch.current;
    setOpened(null);
    setNotice("Reading current source…");
    try {
      const next = await ports.answerSourceRead({
        requestId: result.requestId,
        expectedVersion: result.version,
        windowId,
      });
      if (captured !== epoch.current || selected !== sourceEpoch.current)
        return;
      if (
        next.requestId !== result.requestId ||
        next.version !== result.version ||
        next.windowId !== windowId
      )
        throw new Error("source_changed");
      setOpened(next);
      setNotice(null);
    } catch {
      if (captured === epoch.current && selected === sourceEpoch.current) {
        setOpened(null);
        setResult(null);
        onUnavailable?.();
        setNotice(
          "Citation unavailable. Check this explanation again before using it.",
        );
      }
    }
  }
  return (
    <div>
      {existingRequestId === undefined && (
        <button
          disabled={
            requested ||
            !enabled ||
            !question?.trim() ||
            !ports.answerRequest ||
            !ports.answerRead
          }
          onClick={() => {
            void explain();
          }}
        >
          Explain selected copies
        </button>
      )}
      {requestId !== null && (
        <button
          disabled={!enabled || reading}
          onClick={() => {
            clearTimeout(timer.current);
            setResult(null);
            void readAnswer(requestId, ++epoch.current);
          }}
        >
          Check explanation
        </button>
      )}
      {result?.progress && (
        <p role="status">
          Investigation: {result.progress.stage}; completed steps:{" "}
          {result.progress.completedSteps}.
        </p>
      )}
      {result?.execution === "agent_v1" &&
        result.state === "pending" &&
        ports.answerCancel && (
          <button
            disabled={!enabled || controlBusy}
            onClick={() => {
              void cancelInvestigation();
            }}
          >
            Cancel investigation
          </button>
        )}
      {result?.execution === "agent_v1" &&
        ["complete", "unavailable"].includes(result.state) &&
        ports.investigationPreview && (
          <button
            disabled={!enabled || controlBusy}
            onClick={() => {
              void previewInvestigation(
                result.state === "complete" ? "further" : "retry",
              );
            }}
          >
            {result.state === "complete"
              ? "Preview further investigation"
              : "Preview retry"}
          </button>
        )}
      {result?.reason === "identity_clarification_required" &&
        result.clarification && (
          <section aria-label="Possible identity matches">
            <h3>Choose the intended record</h3>
            <p>
              Matches for “{result.clarification.query}” are separate records.
              Selecting one previews a new investigation before any processing
              begins.
            </p>
            {result.clarification.scope.from && (
              <p>From: {result.clarification.scope.from}</p>
            )}
            {result.clarification.scope.to && (
              <p>Until (exclusive): {result.clarification.scope.to}</p>
            )}
            {result.clarification.matches.map((match) => (
              <div key={`${match.kind}:${match.recordId}`}>
                <p>
                  {match.name} · {match.kind} · {match.recordId}
                </p>
                {match.relationships?.map((relationship) => (
                  <p key={relationship.relationshipId}>
                    {relationship.firmName} · {relationship.status}
                    {relationship.startDate
                      ? ` from ${relationship.startDate}`
                      : ""}
                    {relationship.endDate
                      ? ` until ${relationship.endDate}`
                      : ""}
                    {relationship.sourceState === "unavailable"
                      ? " · evidence unavailable"
                      : ""}
                    {relationship.contextReview === "required"
                      ? " · context review required"
                      : ""}
                  </p>
                ))}
                {match.relationshipsComplete === false && (
                  <p>Relationship history is partial.</p>
                )}
                <button
                  disabled={
                    !enabled || controlBusy || !ports.investigationPreview
                  }
                  onClick={() => {
                    const original = result.clarification!.scope;
                    const dates = {
                      ...(original.from === undefined
                        ? {}
                        : { from: original.from }),
                      ...(original.to === undefined ? {} : { to: original.to }),
                    };
                    void previewInvestigation(
                      "retry",
                      match.kind === "firm"
                        ? { kind: "firm", firmId: match.recordId, ...dates }
                        : {
                            kind: "person",
                            personId: match.recordId,
                            ...dates,
                          },
                    );
                  }}
                >
                  Preview {match.name}
                </button>
              </div>
            ))}
            {result.clarification.truncated && (
              <p>
                These matches are partial. Refine the name or select a specific
                CRM record.
              </p>
            )}
            {result.clarification.matches.length === 0 && (
              <p>
                No current permitted matches remain. Select a current CRM
                record.
              </p>
            )}
          </section>
        )}
      {preview?.value.available && preview.value.additionalAllowance && (
        <section aria-label="New investigation allowance">
          <p>
            Scope: {preview.value.scope?.kind}. Configured ceiling:{" "}
            {preview.value.additionalAllowance.ceilingCents} cents; at most{" "}
            {preview.value.additionalAllowance.maxSteps} steps,{" "}
            {preview.value.additionalAllowance.maxInputBytes} input bytes and{" "}
            {preview.value.additionalAllowance.maxOutputTokens} output tokens
            per step, within{" "}
            {preview.value.additionalAllowance.deadlineMs / 1000} seconds. This
            preview does not reserve funds or grant processing permission.
          </p>
          <button
            disabled={!enabled || controlBusy || !ports.investigationCommit}
            onClick={() => {
              void confirmInvestigation();
            }}
          >
            Confirm new investigation
          </button>
          <button disabled={controlBusy} onClick={() => setPreview(null)}>
            Dismiss allowance preview
          </button>
        </section>
      )}
      {existingRequestId !== undefined && result?.question != null && (
        <p>{result.question}</p>
      )}
      {notice !== null && <p role="status">{notice}</p>}
      {result !== null && resultNotice(result) !== null && (
        <p role="status">{resultNotice(result)}</p>
      )}
      {result?.state === "complete" && result.answer !== null && (
        <div>
          <h2>{result.answer.resultVersion === "agent_v1" ? "AI answer" : "Explanation from selected copies"}</h2>
          {result.answer.resultVersion === "agent_v1" && <p>AI-generated interpretation · Provisional quality. Check original evidence and dated CRM observations before relying on it.</p>}
          <p>
            Input coverage: {result.answer.coverage.input}. Semantic coverage:{" "}
            {result.answer.coverage.semantic}. Acquisition coverage:{" "}
            {result.answer.coverage.acquisition}.
          </p>
          <p>
            Bounded to at most 10 selected copies; this does not establish
            complete business history.
          </p>
          {result.answer.abstained && (
            <p>No supported explanation could be established.</p>
          )}
          {result.answer.conflicts.length > 0 && (
            <p>
              {result.answer.conflicts.length} unresolved conflict. Evidence may
              disagree.
            </p>
          )}
          {result.answer.missingEvidence.map((reason) => (
            <p key={reason}>{missingEvidence[reason]}</p>
          ))}
        </div>
      )}
      {(
        result?.answer?.exactResults ?? result?.supportedWork?.exactResults
      )?.map((proof) => {
        const exact = askResponseSchema.safeParse(proof.value);
        if (!exact.success)
          return <p key={proof.toolCallId}>Exact result unavailable.</p>;
        const value = exact.data;
        return (
          <section
            key={proof.toolCallId}
            id={`ask-exact-${result.requestId}-${encodeURIComponent(proof.toolCallId)}`}
            aria-label={`Exact ${proof.operation}`}
          >
            <h3>Exact {proof.operation.replace("_", " ")}</h3>
            <p>
              Observed during this investigation
              {result?.answer
                ? ` completed at ${result.answer.answeredAt}`
                : ""}
              . This exact observation does not establish a completed generated
              answer.
            </p>
            {"count" in value && <p>Count: {value.count}</p>}
            {value.operation === "opportunities" && value.records.map(record => (
              <article key={record.opportunityId}>
                <h4>{record.name ?? "Unnamed opportunity"}</h4>
                <p>Status: {record.status} · Stage: {record.stageKey}</p>
                <p>Opened: {record.openedAt}</p>
              </article>
            ))}
            {value.operation === "tasks" &&
              value.countBasis === "lower_bound" && (
                <p>
                  This count is a lower bound: additional current task records
                  exceeded the inspection ceiling.
                </p>
              )}
            {value.operation === "reply_status" && (
              <p>
                Verified outgoing: {value.verifiedOutgoingCount}. Without a
                verified reply: {value.withoutVerifiedReplyCount}. Missing
                evidence does not establish unanswered mail.
              </p>
            )}
            {"truncated" in value && value.truncated && (
              <p>Displayed records are partial.</p>
            )}
          </section>
        );
      })}
      {result?.state === "complete" &&
        result.answer?.claims.map((claim, index) => (
          <div key={index}>
            {(claim.kind === "inferred" || claim.kind === "inference" || claim.kind === "conflict" || result.answer?.resultVersion !== "agent_v1") && <p>
              {claim.kind === "inferred" || claim.kind === "inference"
                ? result.answer?.resultVersion === "agent_v1" ? "Inference" : "Inference from source evidence"
                : claim.kind === "conflict"
                  ? "Conflicting evidence"
                  : claim.verification === "cited_unverified"
                    ? "Cited interpretation; verify against original evidence"
                    : "Supported by source evidence"}
            </p>}
            <p>{claim.text}</p>
            <button
              disabled={!enabled || !ports.actionCreate || (claim.exactResultToolCallIds?.length ?? 0) > 0}
              onClick={() => {
                if ((claim.exactResultToolCallIds?.length ?? 0) === 0) setFinding({ kind: "answer_claim", index });
              }}
            >
              Act on claim {index + 1}
            </button>
            {(claim.exactResultToolCallIds?.length ?? 0) > 0 && (
              <p>{claim.citationWindowIds.length > 0
                ? "This claim combines original evidence with a dated CRM observation. Use manual work to choose the next action."
                : "This answer uses a dated CRM observation. Use manual work to choose the next action."}</p>
            )}
            {claim.citationWindowIds.length > 0 && <p>Original evidence</p>}
            {claim.citationWindowIds.map((id, citation) => (
              <button
                key={id}
                disabled={!enabled || !ports.answerSourceRead}
                onClick={() => {
                  void openCitation(id);
                }}
              >
                Open citation {citation + 1} for claim {index + 1}
              </button>
            ))}
            {claim.exactResultToolCallIds?.map(id => {
              const proof = result.answer?.exactResults?.find(item => item.toolCallId === id);
              if (!proof || !askResponseSchema.safeParse(proof.value).success) return <p key={id}>Exact CRM observation unavailable.</p>;
              return <p key={id}><a href={`#ask-exact-${result.requestId}-${encodeURIComponent(id)}`}>Exact CRM observation: {proof.operation.replace("_", " ")}</a></p>;
            })}
          </div>
        ))}
      {result?.fallback !== null && result?.fallback !== undefined && (
        <section aria-label="Keyword evidence">
          <h2>Keyword evidence from the same selected copies</h2>
          <p>
            Keyword matching only. Acquisition and semantic coverage are
            unverified.
          </p>
          {result.fallback.passages.length === 0 && (
            <p>No matching keyword passages in the inspected copies.</p>
          )}
          {(result.fallback.truncated ||
            !result.fallback.coverage.scanComplete) && (
            <p>Keyword coverage is partial; some evidence was not inspected.</p>
          )}
          {result.fallback.passages.map((passage, index) => (
            <div key={index}>
              <pre className="whitespace-pre-wrap break-words">
                {passage.text}
              </pre>
              <button
                disabled={!enabled || index > 19 || !ports.actionCreate}
                onClick={() => setFinding({ kind: "keyword_passage", index })}
              >
                Act on keyword passage {index + 1}
              </button>
              {passage.sources.map((item) => (
                <p key={`${item.kind}:${item.sourceId}:${item.locator}`}>
                  Source {item.sourceId} · Version {item.revision} ·{" "}
                  {item.occurredAt ?? "Date unknown"} · {item.completeness}
                </p>
              ))}
            </div>
          ))}
        </section>
      )}
      {finding !== null && result !== null && (
        <AskFollowOn
          key={`${result.requestId}:${result.version}:${finding.kind}:${finding.index}`}
          ports={ports}
          enabled={enabled}
          requestId={result.requestId}
          expectedVersion={result.version}
          finding={finding}
          onUnavailable={() => {
            setResult(null);
            setOpened(null);
            setFinding(null);
            onUnavailable?.();
            setNotice(
              "Action could not be confirmed. Check current evidence before trying again.",
            );
          }}
        />
      )}
      {opened !== null && (
        <section aria-label="Current citation">
          <h3>Current original evidence</h3>
          <p>
            {
              {
                selected_note: "Selected note",
                call_transcript: "Call transcript",
                meeting_transcript: "Meeting transcript",
                mail: "Email",
              }[opened.source.source.kind]
            }{" "}
            · Version {opened.source.source.revision} ·{" "}
            {opened.source.source.occurredAt ?? "Date unknown"} ·{" "}
            {opened.source.passage?.speaker ?? "Speaker unknown"}
          </p>
          <pre className="whitespace-pre-wrap break-words">
            {opened.source.passage?.text ?? "No quote is available."}
          </pre>
          <p>
            {opened.source.source.completeness} ·{" "}
            {opened.source.passage?.locator ??
              opened.source.source.locator ??
              "Locator unavailable"}
          </p>
        </section>
      )}
    </div>
  );
}
