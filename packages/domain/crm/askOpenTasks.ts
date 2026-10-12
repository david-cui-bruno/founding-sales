import type { z } from "zod";
import type {
  askTaskScopeSchema,
  crmCommitmentDueSchema,
} from "@fss/contracts";
import type { RepositoryContext } from "../db/workspaceScope.ts";
import type { AskTaskDependency } from "./askTaskDependencies.ts";
import { readAskActions } from "./askActions.ts";
import { readCrmCommitments } from "./commitments.ts";
import { createNativeCrmMailEvidence } from "./nativeMailEvidence.ts";
const mail = createNativeCrmMailEvidence();
type Scope = z.infer<typeof askTaskScopeSchema>;
type Due = z.infer<typeof crmCommitmentDueSchema>;
interface Task {
  key: string;
  kind: "ask_task" | "internal_task";
  label: string;
  dueAt: string | null;
  due: Due;
  status: "open";
  firmId?: string;
  personId?: string;
  reviewRequired: boolean;
  version: number;
}
async function dueAt(context: RepositoryContext, due: Due) {
  if (due === null) return null;
  if (due.kind === "instant") return due.at;
  const row = (
    await context.db.query<{ at: Date }>(
      "SELECT ($1::date::timestamp AT TIME ZONE $2) AS at",
      [due.date, due.zone],
    )
  ).rows[0]!;
  return row.at.toISOString();
}
function within(scope: Scope, at: string | null) {
  return at === null
    ? scope.from === undefined && scope.to === undefined
    : (scope.from === undefined || Date.parse(at) >= Date.parse(scope.from)) &&
        (scope.to === undefined || Date.parse(at) < Date.parse(scope.to));
}
/** Enumerate only canonical owner-private proofs. A ceiling is disclosed as a lower-bound count. */
export async function readAskAdditionalOpenTasks(
  context: RepositoryContext,
  scope: Scope,
  observe?: (dependencies: AskTaskDependency[]) => void,
) {
  const tasks = new Map<string, Task>();
  let manualScanned = 0,
    commitmentsScanned = 0;
  let supersededPartial = false;
  let manualComplete = false,
    commitmentsComplete = false;
  let cursor: string | undefined;
  while (manualScanned < 500) {
    const page = await readAskActions(
      context,
      {
        scope:
          "firmId" in scope
            ? { kind: "firm", firmId: scope.firmId }
            : "personId" in scope
              ? { kind: "person", personId: scope.personId }
              : { kind: "history" },
        afterId: cursor,
        limit: Math.min(50, 500 - manualScanned),
      },
      { inTransaction: true },
    );
    if (page === null) return null;
    manualScanned += page.items.length;
    for (const item of page.items) {
      if (
        item.kind !== "task" ||
        item.status !== "open" ||
        item.supportState !== "current" ||
        item.label === null
      )
        continue;
      const at = await dueAt(context, item.due);
      if (!within(scope, at)) continue;
      const key = `ask_task:${item.actionId}`;
      tasks.set(key, {
        key,
        kind: "ask_task",
        label: item.label,
        dueAt: at,
        due: item.due,
        status: "open",
        ...(item.target?.kind === "firm"
          ? { firmId: item.target.firmId }
          : item.target?.kind === "person"
            ? { personId: item.target.personId }
            : {}),
        reviewRequired: item.reviewRequired,
        version: item.version,
      });
    }
    if (page.nextAfterId === null) {
      manualComplete = true;
      break;
    }
    if (page.nextAfterId === cursor) break;
    cursor = page.nextAfterId;
  }
  cursor = undefined;
  while (commitmentsScanned < 500) {
    const page = await readCrmCommitments(
      context,
      {
        scope:
          "firmId" in scope
            ? { kind: "firm", firmId: scope.firmId }
            : "personId" in scope
              ? { kind: "person", personId: scope.personId }
              : { kind: "today" },
        afterId: cursor,
        limit: Math.min(50, 500 - commitmentsScanned),
      },
      mail,
      { allOpenTasks: true },
    );
    if (page === null) return null;
    commitmentsScanned += page.items.length;
    for (const item of page.items) {
      if (
        !("commitmentId" in item) ||
        item.source === null ||
        item.actionLabel === null
      )
        continue;
      const target = {
        ...("firmId" in scope
          ? { firmId: scope.firmId }
          : "personId" in scope
            ? { personId: scope.personId }
            : {}),
      };
      if (item.task?.status === "open") {
        const at = await dueAt(context, item.due);
        if (within(scope, at)) {
          const key = `internal_task:${item.task.taskId}`;
          tasks.set(key, {
            key,
            kind: "internal_task",
            label: item.actionLabel,
            dueAt: at,
            due: item.due,
            status: "open",
            ...target,
            reviewRequired: item.state === "review_required",
            version: item.task.version,
          });
        }
      }
      supersededPartial ||= item.supersededOpenTasksTruncated;
      if (within(scope, null))
        for (const task of item.supersededOpenTasks) {
          const key = `internal_task:${task.taskId}`;
          tasks.set(key, {
            key,
            kind: "internal_task",
            label: "Earlier commitment task requires review",
            dueAt: null,
            due: null,
            status: "open",
            ...target,
            reviewRequired: true,
            version: task.version,
          });
        }
    }
    if (page.nextAfterId === null) {
      commitmentsComplete = true;
      break;
    }
    if (page.nextAfterId === cursor) break;
    cursor = page.nextAfterId;
  }
  observe?.([...tasks.values()].map(task => ({kind: task.kind, taskId: task.key.slice(task.key.indexOf(":") + 1), version: task.version})));
  return {
    records: [...tasks.values()],
    complete: manualComplete && commitmentsComplete && !supersededPartial,
    manualScanned,
    commitmentsScanned,
  };
}
