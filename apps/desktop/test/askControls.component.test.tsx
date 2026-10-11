// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  AskAnswer,
  type AskAnswerPorts,
} from "../src/renderer/ask/AskAnswer.tsx";
afterEach(cleanup);
const requestId = "11111111-1111-4111-8111-111111111111";
it("cancels the current version without resubmitting or implying refunded dispatch", async () => {
  let cancelled = false;
  const answerRead = vi.fn<AskAnswerPorts["answerRead"]>(async () => ({
    requestId,
    version: 1,
    createdAt: "2026-10-10T12:00:00.000Z",
    execution: "agent_v1",
    state: cancelled ? "unavailable" : "pending",
    reason: cancelled ? "processing_cancelled" : null,
    question: "What changed?",
    answer: null,
    fallback: null,
    progress: {
      completedSteps: 2,
      stage: cancelled ? "cancelled" : "calling",
      cancelledAt: cancelled ? "2026-10-10T12:01:00.000Z" : null,
    },
  }));
  const answerCancel = vi.fn(async () => {
    cancelled = true;
    return { requestId, version: 1, outcome: "cancelled" as const };
  });
  render(
    <AskAnswer
      ports={{ answerRead, answerCancel }}
      enabled
      existingRequestId={requestId}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel investigation" }),
  );
  await screen.findByText(/already dispatched calls still settle/u);
  expect(answerCancel).toHaveBeenCalledWith({ requestId, expectedVersion: 1 });
});
it("requires a dated allowance preview and separate human confirmation before new investigation", async () => {
  const answerRead = vi.fn<AskAnswerPorts["answerRead"]>(async () => ({
    requestId,
    version: 1,
    createdAt: "2026-10-10T12:00:00.000Z",
    execution: "agent_v1",
    state: "unavailable",
    reason: "processing_failed",
    question: "What changed?",
    answer: null,
    fallback: null,
  }));
  const investigationPreview = vi.fn(async () => ({
    available: true,
    reason: null,
    previewHash: "a".repeat(64),
    scope: { kind: "business" as const },
    question: "What changed?",
    additionalAllowance: {
      maxSteps: 4,
      maxInputBytes: 10000,
      maxOutputTokens: 500,
      deadlineMs: 10000,
      ceilingCents: 8,
    },
  }));
  const investigationCommit = vi.fn(async () => ({
    requestId,
    version: 1,
    state: "unavailable" as const,
  }));
  render(
    <AskAnswer
      ports={{ answerRead, investigationPreview, investigationCommit }}
      enabled
      existingRequestId={requestId}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Preview retry" }));
  await screen.findByText(/Configured ceiling: 8 cents/u);
  expect(investigationCommit).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Confirm new investigation" }),
  );
  await waitFor(() =>
    expect(investigationCommit).toHaveBeenCalledWith({
      requestId,
      expectedVersion: 1,
      mode: "retry",
      previewHash: "a".repeat(64),
    }),
  );
});
it("shows distinct possible identity matches and requires scoped preview before selection can run", async () => {
  const firmId = "22222222-2222-4222-8222-222222222222";
  const otherId = "33333333-3333-4333-8333-333333333333";
  const answerRead = vi.fn<AskAnswerPorts["answerRead"]>(async () => ({
    requestId,
    version: 1,
    createdAt: "2026-10-10T12:00:00.000Z",
    execution: "agent_v1",
    state: "unavailable",
    reason: "identity_clarification_required",
    question: "What changed at Acme?",
    answer: null,
    fallback: null,
    clarification: {
      kind: "identity_ambiguous",
      query: "Acme",
      recordKind: "firms",
      scope: {
        kind: "business",
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-10T00:00:00.000Z",
      },
      matches: [
        { recordId: firmId, kind: "firm", name: "Acme", firmId },
        { recordId: otherId, kind: "firm", name: "Acme", firmId: otherId },
      ],
      truncated: false,
    },
  }));
  const investigationPreview = vi.fn<AskAnswerPorts["investigationPreview"]>(
    async (input) => ({
      available: true,
      reason: null,
      previewHash: "a".repeat(64),
      scope: input.agentScope ?? null,
      question: "What changed at Acme?",
      additionalAllowance: {
        maxSteps: 4,
        maxInputBytes: 10000,
        maxOutputTokens: 500,
        deadlineMs: 10000,
        ceilingCents: 8,
      },
    }),
  );
  const investigationCommit = vi.fn(async () => ({
    requestId,
    version: 1,
    state: "unavailable" as const,
  }));
  render(
    <AskAnswer
      ports={{ answerRead, investigationPreview, investigationCommit }}
      enabled
      existingRequestId={requestId}
    />,
  );
  const choices = await screen.findAllByRole("button", {
    name: "Preview Acme",
  });
  expect(choices).toHaveLength(2);
  expect(investigationPreview).not.toHaveBeenCalled();
  fireEvent.click(choices[0]!);
  await waitFor(() =>
    expect(investigationPreview).toHaveBeenCalledWith({
      requestId,
      expectedVersion: 1,
      mode: "retry",
      agentScope: {
        kind: "firm",
        firmId,
        from: "2026-10-01T00:00:00.000Z",
        to: "2026-10-10T00:00:00.000Z",
      },
    }),
  );
  expect(investigationCommit).not.toHaveBeenCalled();
});
it("shows dated historical relationship context for possible people without assuming current employment", async () => {
  const personId = "22222222-2222-4222-8222-222222222222",
    firmId = "33333333-3333-4333-8333-333333333333";
  const answerRead = vi.fn<AskAnswerPorts["answerRead"]>(async () => ({
    requestId,
    version: 1,
    createdAt: "2026-10-10T12:00:00.000Z",
    execution: "agent_v1",
    state: "unavailable",
    reason: "identity_clarification_required",
    question: "Which Alex?",
    answer: null,
    fallback: null,
    clarification: {
      kind: "identity_ambiguous",
      query: "Alex",
      recordKind: "people",
      scope: { kind: "business" },
      matches: [
        {
          recordId: personId,
          kind: "person",
          name: "Alex",
          firmId: null,
          relationships: [
            {
              relationshipId: firmId,
              revision: 2,
              firmId,
              firmName: "Former Firm",
              status: "historical",
              startDate: "2020-01-01",
              endDate: "2026-09-30",
              sourceState: "available",
              contextReview: "current",
            },
          ],
          relationshipsComplete: false,
        },
      ],
      truncated: false,
    },
  }));
  render(
    <AskAnswer ports={{ answerRead }} enabled existingRequestId={requestId} />,
  );
  await screen.findByText(
    "Former Firm · historical from 2020-01-01 until 2026-09-30",
  );
  await screen.findByText("Relationship history is partial.");
  expect(
    screen
      .getByRole("button", { name: "Preview Alex" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
