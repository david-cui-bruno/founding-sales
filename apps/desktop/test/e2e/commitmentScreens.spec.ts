import { expect, test } from "playwright/test";
import { startAppServer } from "./support/appServer.ts";
const id = "11111111-1111-4111-8111-111111111111";
const target = {
  kind: "internal_task",
  taskId: id,
  expectedVersion: 4,
  review: { commitmentId: id, revision: 2, projectionVersion: 1 },
  support: {
    sourceKind: "selected_note",
    sourceId: id,
    sourceRevision: 1,
    sourceHash: "a".repeat(64),
    contextHash: "b".repeat(64),
    decisionRevision: 1,
  },
};
const due = {
  kind: "date",
  date: "2026-10-12",
  zone: "America/Chicago",
  expression: "Monday",
};
const source = {
  workspaceId: id,
  sourceId: id,
  kind: "selected_note",
  revision: 1,
  contentHash: "a".repeat(64),
  locator: "text:0:33",
  speaker: null,
  occurredAt: "2026-10-09T15:00:00.000Z",
  observedAt: "2026-10-09T15:00:00.000Z",
  completeness: "selected_excerpt",
  availability: "available",
};
test("opens promise proof in the shipped shell without completing it", async ({
  page,
}) => {
  const server = await startAppServer({
    operations: {
      "today.actionsV2": () => ({
        version: 2,
        workspaceId: id,
        businessTimeZone: "Etc/UTC",
        asOf: "2026-10-09T15:00:00.000Z",
        actions: [
          {
            actionId: `crm-promise:${id}:4`,
            kind: "promise",
            subject: "Prepare the example outline",
            reason: "dated_promise",
            state: "open",
            due,
            target,
          },
        ],
      }),
      "today.openActionV2": () => ({ version: 2, target }),
      "crm.commitmentsRead": () => ({
        items: [
          {
            commitmentId: id,
            revision: 2,
            basis: "human",
            state: "applied",
            todayEligibility: "current",
            actor: "self",
            actionLabel: "Prepare the example outline",
            due,
            quote: "I will prepare the outline Monday.",
            source,
            task: { taskId: id, status: "open", version: 4, completedAt: null },
          },
        ],
        nextAfterId: null,
      }),
    },
  });
  try {
    await page.goto(server.url());
    await page.getByRole("button", { name: "Open promise" }).click();
    await expect(
      page.getByText("I will prepare the outline Monday."),
    ).toBeVisible();
    await expect(
      page.getByText("Human attestation", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Mark promise complete" }),
    ).toBeVisible();
    expect(
      server.calls.some((call) => call.method.includes("commitmentsComplete")),
    ).toBe(false);
    await page.screenshot({
      path: "../../.context/evidence/490-today-promise.png",
      fullPage: true,
    });
  } finally {
    await server.stop();
  }
});
