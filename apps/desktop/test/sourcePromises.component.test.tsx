// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SourcePromises } from "../src/renderer/firms/SourcePromises.tsx";
const id = "11111111-1111-4111-8111-111111111111";
const source = {
  workspaceId: id,
  sourceId: id,
  kind: "selected_note" as const,
  revision: 1,
  contentHash: "a".repeat(64),
  locator: "text:0:15",
  speaker: null,
  occurredAt: null,
  observedAt: "2026-10-09T15:00:00.000Z",
  completeness: "selected_excerpt" as const,
  availability: "available" as const,
};
const page = {
  items: [
    {
      commitmentId: id,
      revision: 1,
      state: "suggestion" as const,
      todayEligibility: "unknown" as const,
      actor: "unknown" as const,
      actionLabel: "Discuss the proposal",
      due: null,
      quote: "Maybe next week",
      source,
      task: null,
    },
  ],
  nextAfterId: null,
};
afterEach(cleanup);
it("loads bounded protected source promises and keeps uncertain evidence a suggestion", async () => {
  const read = vi.fn(async () => page),
    complete = vi.fn();
  render(
    <SourcePromises
      source={source}
      enabled={true}
      privacyKey="first"
      ports={{ read, complete }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "View source promises" }));
  expect(await screen.findByText("Discuss the proposal")).toBeTruthy();
  expect(screen.getByText("Maybe next week")).toBeTruthy();
  expect(read).toHaveBeenCalledWith({
    scope: { kind: "source", sourceId: id, sourceKind: "selected_note" },
    limit: 50,
  });
  expect(screen.getByText(/Suggestion.*unknown/u)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Complete this promise" }),
  ).toBeNull();
  expect(complete).not.toHaveBeenCalled();
});

it("clears prior private evidence while a new source read is pending and after refusal", async () => {
  const read = vi.fn(async () => page),
    ports = { read, complete: vi.fn() };
  render(
    <SourcePromises
      source={source}
      enabled={true}
      privacyKey="first"
      ports={ports}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "View source promises" }));
  await screen.findByText("Maybe next week");
  let rejectRead: (reason: Error) => void = () => {
    throw new Error("not pending");
  };
  read.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectRead = reject;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "View source promises" }));
  expect(screen.queryByText("Maybe next week")).toBeNull();
  rejectRead(new Error("access refused"));
  expect(
    await screen.findByText(/Source promises are unavailable/u),
  ).toBeTruthy();
  expect(screen.queryByText("Discuss the proposal")).toBeNull();
});
it("does not republish a late source response after privacy identity changes", async () => {
  let resolveRead: (value: typeof page) => void = () => {
    throw new Error("not pending");
  };
  const read = vi.fn(
      () =>
        new Promise<typeof page>((resolve) => {
          resolveRead = resolve;
        }),
    ),
    ports = { read, complete: vi.fn() };
  const view = render(
    <SourcePromises
      source={source}
      enabled={true}
      privacyKey="first"
      ports={ports}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "View source promises" }));
  view.rerender(
    <SourcePromises
      source={source}
      enabled={false}
      privacyKey="second"
      ports={ports}
    />,
  );
  resolveRead(page);
  await Promise.resolve();
  expect(screen.queryByText("Maybe next week")).toBeNull();
  expect(screen.queryByText("Discuss the proposal")).toBeNull();
});

it("completes supported internal work only through an explicit version-bound command", async () => {
  const applied = {
    items: [
      {
        ...page.items[0]!,
        state: "applied" as const,
        actor: "self" as const,
        todayEligibility: "current" as const,
        due: {
          kind: "date" as const,
          date: "2026-10-12",
          zone: "America/Chicago",
          expression: "Monday",
        },
        task: {
          taskId: id,
          status: "open" as const,
          version: 4,
          completedAt: null,
        },
      },
    ],
    nextAfterId: null,
  };
  const read = vi.fn(async () => applied),
    complete = vi.fn(async () => ({
      taskId: id,
      version: 5,
      completedAt: "2026-10-09T15:00:00.000Z",
    }));
  render(
    <SourcePromises
      source={source}
      enabled={true}
      privacyKey="first"
      ports={{ read, complete }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "View source promises" }));
  const button = await screen.findByRole("button", {
    name: "Complete this promise",
  });
  expect(complete).not.toHaveBeenCalled();
  expect(screen.getByText(/2026-10-12.*America\/Chicago/u)).toBeTruthy();
  fireEvent.click(button);
  expect(await screen.findByText(/Promise completed/u)).toBeTruthy();
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    taskId: id,
    expectedVersion: 4,
  });
  expect(screen.queryByText("Maybe next week")).toBeNull();
});
