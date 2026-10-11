import { expect, it } from "vitest";
import {
  selectedImportCommitPayloadSchema,
  crmClaimContextSchema,
} from "../src/index.ts";
it("accepts an explicitly selected opportunity without inferring one from imported text", () => {
  expect(
    selectedImportCommitPayloadSchema.safeParse({
      text: "Phone notes",
      subtype: "transcript",
      label: "Selected call",
      direction: "unknown",
      firmId: "00000000-0000-4000-8000-000000000001",
      opportunityId: "00000000-0000-4000-8000-000000000002",
      importKey: "one",
      previewHash: "a".repeat(64),
      parserVersion: "selected-v1",
    }).success,
  ).toBe(true);
  expect(
    crmClaimContextSchema.safeParse({
      personId: null,
      firmIds: [],
      relationships: [],
      review: "current",
      opportunityId: "00000000-0000-4000-8000-000000000002",
    }).success,
  ).toBe(true);
});
