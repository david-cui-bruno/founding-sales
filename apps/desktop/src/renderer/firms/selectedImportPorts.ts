import { operations } from "../app/bridges.ts";
import type { SelectedImportPorts } from "./SelectedImports.tsx";
export async function readSelectedTextFile(
  file: Pick<File, "name" | "size" | "arrayBuffer">,
): Promise<{ text: string; label: string }> {
  if (!/\.(?:txt|md|csv|srt|vtt)$/iu.test(file.name) || file.size > 80000)
    throw new Error("selected_file_unsupported");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await file.arrayBuffer(),
  );
  if (!text.trim() || text.length > 20000 || text.includes("\0"))
    throw new Error("selected_file_limit");
  return { text, label: file.name };
}
function api() {
  const value = operations();
  if (value === undefined) throw new Error("unavailable");
  return value;
}
export const selectedImportPorts: SelectedImportPorts = {
  read: async (scope) =>
    await api().read("crm.selectedImportRead", {
      ...scope,
      personId: scope.personId ?? null,
      firmId: scope.firmId ?? null,
      limit: 50,
    }),
  preview: async (input) =>
    await api().read("crm.selectedImportPreview", input),
  commit: async (input) =>
    await api().command("crm.selectedImportCommit", input),
  correct: async (input) => {
    await api().command("crm.selectedImportCorrect", input);
  },
  remove: async (input) => {
    await api().command("crm.selectedImportDelete", input);
  },
  restore: async (input) => {
    await api().command("crm.selectedImportRestore", input);
  },
  recapture: async (input) => {
    await api().command("crm.selectedImportRecapture", input);
  },
  readFile: readSelectedTextFile,
};
