import { operations } from "../app/bridges.ts";
import type { EvidenceReviewPorts } from "./EvidenceReview.tsx";
function api() {
  const value = operations();
  if (value === undefined) throw new Error("unavailable");
  return value;
}
export const evidenceReviewPorts: EvidenceReviewPorts = {
  commitmentStatus: async (input) =>
    await api().read("crm.commitmentsReviewStatus", input),
  commitmentReview: async (input) =>
    await api().command("crm.commitmentsReview", input),
  workBind: async (input) => await api().command("crm.evidenceWorkBind", input),
  workList: async (input) => await api().read("crm.evidenceWorkList", input),
  workRead: async (input) => await api().read("crm.evidenceWorkRead", input),
  conflictSave: async (input) =>
    await api().command("crm.evidenceConflictSave", input),
  conflictList: async (input) =>
    await api().read("crm.evidenceConflictList", input),
  conflictRead: async (input) =>
    await api().read("crm.evidenceConflictRead", input),
  conflictResolve: async (input) =>
    await api().command("crm.evidenceConflictResolve", input),
  read: async (input) => await api().read("crm.evidenceRead", input),
  decide: async (input) => await api().command("crm.evidenceDecide", input),
  historyList: async (input) =>
    await api().read("crm.evidenceHistoryList", input),
  historyRead: async (input) =>
    await api().read("crm.evidenceHistoryRead", input),
};
