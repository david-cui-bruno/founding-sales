import { expect, it } from "vitest";
import { OPERATIONS, operationOf } from "../src/shared/operations.ts";
it("allows bounded import preview and exact-version correction through closed operations only", () => {
  expect(operationOf("crm.selectedImportPreview")).toBe(
    "crm.selectedImportPreview",
  );
  const operation = OPERATIONS["crm.selectedImportPreview"];
  expect(
    operation.input.safeParse({
      text: "Selected",
      subtype: "pasted_text",
      label: "Note",
      direction: "draft",
    }).success,
  ).toBe(true);
  expect(
    operation.input.safeParse({
      text: "x".repeat(20001),
      subtype: "pasted_text",
      label: "Note",
      direction: "draft",
    }).success,
  ).toBe(false);
  expect(
    operation.input.safeParse({
      text: "Selected",
      subtype: "pasted_text",
      label: "Note",
      direction: "draft",
      path: "/send",
    }).success,
  ).toBe(false);
});
