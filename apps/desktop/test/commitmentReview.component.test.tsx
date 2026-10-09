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
  EvidenceReview,
  type EvidenceReviewPorts,
} from "../src/renderer/firms/EvidenceReview.tsx";
const id = "11111111-1111-4111-8111-111111111111";
const source = {
  workspaceId: id,
  sourceId: id,
  kind: "selected_note" as const,
  revision: 1,
  contentHash: "a".repeat(64),
  locator: null,
  speaker: null,
  occurredAt: null,
  observedAt: "2026-10-09T14:00:00.000Z",
  completeness: "selected_excerpt" as const,
  availability: "available" as const,
};
const claim = {
  claimId: id,
  claimRevision: 1 as const,
  claimHash: "b".repeat(64),
  contextHash: "c".repeat(64),
  context: {
    personId: id,
    firmIds: [],
    relationships: [],
    review: "current" as const,
  },
  kind: "commitment" as const,
  interpretation: "AI suggested promise",
  status: "inferred" as const,
  quote: "I will send the outline on Monday.",
  source: { ...source, locator: "text:0:33" },
  anchorId: null,
  semanticHash: "d".repeat(64),
  decisionRevision: 0,
  reviewRequired: false,
  effectiveState: "unreviewed" as const,
  decision: null,
  decisionHistory: [],
  decisionHistoryTruncated: false,
};
const target = {
  source: {
    workspaceId: id,
    sourceId: id,
    kind: "selected_note" as const,
    revision: 1,
    contentHash: "a".repeat(64),
    locator: null,
  },
  claimId: id,
  claimRevision: 1,
  claimHash: "b".repeat(64),
  contextHash: "c".repeat(64),
  expectedDecisionRevision: 0,
};
const evidencePage = {
  source,
  claims: [claim],
  reviewedHistory: [],
  nextAfterClaimId: null,
  nextAfterReviewedAnchorId: null,
  projection: {
    scope: "bounded_source_page" as const,
    counts: {
      current: 1,
      reviewedHistory: 0,
      confirmed: 0,
      dismissed: 0,
      corrected: 0,
      unreviewed: 1,
      reviewRequired: 0,
    },
    truncated: false,
    revisionFingerprint: "e".repeat(64),
  },
};
afterEach(cleanup);
it("attests a structured promise with the current server review revision and explicit date-only zone", async () => {
  const review = vi.fn(async () => ({
    commitmentId: id,
    revision: 8,
    status: "queued" as const,
  }));
  const status = vi.fn(async () => ({
    current: {
      commitmentId: id,
      revision: 7,
      basis: "human" as const,
      state: "suggestion" as const,
    },
  }));
  const ports: EvidenceReviewPorts = {
    read: async () => evidencePage,
    commitmentStatus: status,
    commitmentReview: review,
  };
  render(
    <EvidenceReview
      sources={[source]}
      ports={ports}
      enabled
      recordId={id}
      privacyKey="first"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review evidence 1" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Review promise 1" }),
  );
  await screen.findByLabelText("Promised action");
  expect(
    screen.getByText("Current review basis: human attestation"),
  ).toBeTruthy();
  expect(status).toHaveBeenCalledExactlyOnceWith(target);
  expect(review).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Promise classification"), {
    target: { value: "internal_promise" },
  });
  fireEvent.change(screen.getByLabelText("Promising actor"), {
    target: { value: "self" },
  });
  fireEvent.change(screen.getByLabelText("Promised action"), {
    target: { value: "Send the maintenance outline" },
  });
  fireEvent.change(screen.getByLabelText("Deadline precision"), {
    target: { value: "date" },
  });
  fireEvent.change(screen.getByLabelText("Deadline date"), {
    target: { value: "2026-10-12" },
  });
  fireEvent.change(screen.getByLabelText("Deadline time zone"), {
    target: { value: "America/Chicago" },
  });
  fireEvent.change(screen.getByLabelText("Original deadline wording"), {
    target: { value: "Monday" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save promise review" }));
  await waitFor(() =>
    expect(review).toHaveBeenCalledExactlyOnceWith({
      ...target,
      expectedCommitmentRevision: 7,
      classification: "internal_promise",
      actor: "self",
      actionLabel: "Send the maintenance outline",
      due: {
        kind: "date",
        date: "2026-10-12",
        zone: "America/Chicago",
        expression: "Monday",
      },
    }),
  );
  expect(await screen.findByText("Promise review saved.")).toBeTruthy();
});
it("removes the copied evidence page when promise status is denied", async () => {
  const review = vi.fn();
  const ports: EvidenceReviewPorts = {
    read: async () => evidencePage,
    commitmentStatus: async () => {
      throw new Error("access denied");
    },
    commitmentReview: review,
  };
  render(
    <EvidenceReview
      sources={[source]}
      ports={ports}
      enabled
      recordId={id}
      privacyKey="first"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review evidence 1" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Review promise 1" }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("I will send the outline on Monday.")).toBeNull();
  expect(screen.queryByLabelText("Promised action")).toBeNull();
  expect(review).not.toHaveBeenCalled();
});
it("drops a late promise status response after the record privacy identity changes", async () => {
  let settle: ((value: { current: null }) => void) | undefined;
  const pending = new Promise<{ current: null }>((resolve) => {
    settle = resolve;
  });
  const ports: EvidenceReviewPorts = {
    read: async () => evidencePage,
    commitmentStatus: async () => pending,
    commitmentReview: vi.fn(),
  };
  const view = render(
    <EvidenceReview
      sources={[source]}
      ports={ports}
      enabled
      recordId={id}
      privacyKey="first"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review evidence 1" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Review promise 1" }),
  );
  view.rerender(
    <EvidenceReview
      sources={[source]}
      ports={ports}
      enabled
      recordId={id}
      privacyKey="second"
    />,
  );
  settle?.({ current: null });
  await vi.waitFor(() =>
    expect(screen.queryByLabelText("Promised action")).toBeNull(),
  );
  expect(screen.queryByText("I will send the outline on Monday.")).toBeNull();
});
