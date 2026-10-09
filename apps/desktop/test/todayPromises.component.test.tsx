// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TodayActionsV2Response } from "@fss/contracts";
import type { OperationApi } from "../src/shared/operations.ts";
import { ActionQueue } from "../src/renderer/today/ActionQueue.tsx";
const id = "11111111-1111-4111-8111-111111111111";
const response: TodayActionsV2Response = {
  version: 2,
  workspaceId: id,
  businessTimeZone: "Etc/UTC",
  asOf: "2026-10-09T14:00:00.000Z",
  promiseCoverage: {
    scope: "current_authorized_work",
    truncated: false,
    nextAfterId: null,
  },
  actions: [
    {
      actionId: `crm-promise:${id}:1`,
      kind: "promise",
      subject: "Send the maintenance outline",
      reason: "dated_promise",
      state: "open",
      due: {
        kind: "date",
        date: "2026-10-12",
        zone: "America/Chicago",
        expression: "Monday",
      },
      target: {
        kind: "internal_task",
        taskId: id,
        expectedVersion: 1,
        review: { commitmentId: id, revision: 1, projectionVersion: 1 },
        support: {
          sourceKind: "selected_note",
          sourceId: id,
          sourceRevision: 1,
          sourceHash: "a".repeat(64),
          contextHash: "b".repeat(64),
          decisionRevision: 1,
        },
      },
    },
  ],
};
const promisePage = {
  items: [
    {
      commitmentId: id,
      revision: 1,
      supersededOpenTasks: [],
      supersededOpenTasksTruncated: false,
      basis: "human" as const,
      state: "applied" as const,
      todayEligibility: "current" as const,
      actor: "self" as const,
      actionLabel: response.actions[0]!.subject,
      due:
        response.actions[0]!.kind === "promise"
          ? response.actions[0]!.due
          : null,
      quote: "I will send the outline on Monday.",
      source: {
        workspaceId: id,
        sourceId: id,
        kind: "selected_note" as const,
        revision: 1,
        contentHash: "a".repeat(64),
        locator: "text:0:33",
        speaker: null,
        occurredAt: "2026-10-09T14:00:00.000Z",
        observedAt: "2026-10-09T14:00:00.000Z",
        completeness: "selected_excerpt" as const,
        availability: "available" as const,
      },
      task: {
        taskId: id,
        status: "open" as const,
        version: 1,
        completedAt: null,
      },
    },
  ],
  nextAfterId: null,
};
afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});
it("shows a current dated promise from explicit V2 without inventing a time", async () => {
  globalThis.callieApi = {
    read: async (operation: string) =>
      operation === "today.actionsV2" ? response : null,
    command: async () => {
      throw new Error("Read-only promise display");
    },
  } as unknown as OperationApi;
  render(<ActionQueue refreshKey="first" enabled={true} />);
  expect(await screen.findByText("Send the maintenance outline")).toBeTruthy();
  expect(screen.getByText(/2026-10-12.*America\/Chicago/u)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open promise" })).toBeTruthy();
  expect(screen.queryByText(/12:00|00:00/u)).toBeNull();
});

it("opens the exact promise evidence without completing it or guessing a firm", async () => {
  const action = response.actions[0]!;
  if (action.kind !== "promise") throw new Error("fixture");
  const complete = vi.fn();
  const read = vi.fn(async () => promisePage);
  globalThis.callieApi = {
    read: async (operation: string) =>
      operation === "today.actionsV2"
        ? response
        : operation === "today.openActionV2"
          ? { version: 2, target: action.target }
          : null,
    command: async () => {
      throw new Error("Opening has no command");
    },
  } as unknown as OperationApi;
  render(
    <ActionQueue
      refreshKey="first"
      enabled={true}
      promisePorts={{ read, complete }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open promise" }));
  expect(
    await screen.findByText("I will send the outline on Monday."),
  ).toBeTruthy();
  expect(read).toHaveBeenCalledWith({
    scope: { kind: "source", sourceId: id, sourceKind: "selected_note" },
    limit: 50,
  });
  expect(complete).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Mark promise complete" }),
  ).toBeTruthy();
});

it("completes only after the explicit promise completion action with its exact version", async () => {
  let current: TodayActionsV2Response = response;
  const action = response.actions[0]!;
  const complete = vi.fn(
    async (input: { taskId: string; expectedVersion: number }) => {
      current = { ...response, actions: [] };
      return {
        taskId: input.taskId,
        version: 2,
        completedAt: "2026-10-09T14:05:00.000Z",
      };
    },
  );
  globalThis.callieApi = {
    read: async (operation: string) =>
      operation === "today.actionsV2"
        ? current
        : operation === "today.openActionV2"
          ? { version: 2, target: action.target }
          : null,
    command: async () => {
      throw new Error("Only explicit promise port completes");
    },
  } as unknown as OperationApi;
  render(
    <ActionQueue
      refreshKey="first"
      enabled={true}
      promisePorts={{ read: async () => promisePage, complete }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open promise" }));
  const button = await screen.findByRole("button", {
    name: "Mark promise complete",
  });
  expect(complete).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(await screen.findByText("No actions need you.")).toBeTruthy();
  expect(complete).toHaveBeenCalledExactlyOnceWith({
    taskId: id,
    expectedVersion: 1,
  });
  expect(screen.queryByText("I will send the outline on Monday.")).toBeNull();
});
it("refuses a V1 response rather than falling back and hiding promise coverage", async () => {
  const read = vi.fn(async () => ({ ...response, version: 1 }));
  globalThis.callieApi = { read, command: vi.fn() } as unknown as OperationApi;
  render(<ActionQueue refreshKey="first" enabled={true} />);
  expect(await screen.findByText(/Actions are unavailable/u)).toBeTruthy();
  expect(screen.queryByText("Send the maintenance outline")).toBeNull();
  expect(read).toHaveBeenCalledExactlyOnceWith("today.actionsV2", {});
});
it("discards a late protected open after Today is disabled without fetching private evidence", async () => {
  let settle: ((value: unknown) => void) | undefined;
  const pending = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  const read = vi.fn(async () => promisePage),
    complete = vi.fn();
  globalThis.callieApi = {
    read: async (operation: string) =>
      operation === "today.actionsV2" ? response : pending,
    command: vi.fn(),
  } as unknown as OperationApi;
  const ports = { read, complete };
  const view = render(
    <ActionQueue refreshKey="first" enabled={true} promisePorts={ports} />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Open promise" }));
  view.rerender(
    <ActionQueue refreshKey="second" enabled={false} promisePorts={ports} />,
  );
  settle?.({ version: 2, target: response.actions[0]!.target });
  await vi.waitFor(() =>
    expect(screen.queryByText("Send the maintenance outline")).toBeNull(),
  );
  expect(read).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});
it("drops private action labels immediately when the current open is denied while refresh waits", async () => {
  let reads = 0;
  const never = new Promise<unknown>(() => undefined);
  globalThis.callieApi = {
    read: async (operation: string) =>
      operation === "today.actionsV2"
        ? ++reads === 1
          ? response
          : never
        : null,
    command: vi.fn(),
  } as unknown as OperationApi;
  render(<ActionQueue refreshKey="first" enabled={true} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open promise" }));
  await screen.findByRole("status");
  expect(screen.queryByText("Send the maintenance outline")).toBeNull();
});

it("discloses a bounded incomplete promise page without inventing total work", async () => {
  globalThis.callieApi = {
    read: async () => ({
      ...response,
      promiseCoverage: {
        scope: "current_authorized_work",
        truncated: true,
        nextAfterId: id,
      },
    }),
    command: async () => {
      throw new Error("no command");
    },
  } as unknown as OperationApi;
  render(<ActionQueue refreshKey="partial" enabled={true} />);
  await screen.findByText("Send the maintenance outline");
  expect(
    screen.getByText(
      /More promise work exists beyond this bounded Today page/u,
    ),
  ).toBeTruthy();
});
it("opens an exhausted projection blocker as protected evidence without a completion or retry control", async () => {
  const original = response.actions[0]!;
  if(original.kind !== "promise") throw new Error("fixture");
  const target = {kind: "commitment_blocker" as const, review: {commitmentId:id,revision:1},support:original.target.support};
  const blocked: TodayActionsV2Response = {...response,actions:[{actionId:`crm-promise-blocker:${id}:1`,kind:"problem",subject:"Prepare the maintenance outline",reason:"commitment_projection_failed",dueAt:response.asOf,state:"open",target}]};
  const complete = vi.fn();
  globalThis.callieApi={read:async(operation:string)=>operation==="today.actionsV2"?blocked:operation==="today.openActionV2"?{version:2,target}:null,command:async()=>{throw new Error("No implicit retry");}} as unknown as OperationApi;
  render(<ActionQueue refreshKey="blocked" enabled={true} promisePorts={{read:async()=>({...promisePage,items:[{...promisePage.items[0]!,state:"pending",task:null}]}),complete}}/>);
  fireEvent.click(await screen.findByRole("button",{name:"Open blocked promise"}));
  expect(await screen.findByText("I will send the outline on Monday.")).toBeTruthy();
  expect(screen.getByText("This promise remains pending after processing failed.")).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Mark promise complete"})).toBeNull();
  expect(screen.queryByRole("button",{name:/Retry/u})).toBeNull();
  expect(complete).not.toHaveBeenCalled();
});
