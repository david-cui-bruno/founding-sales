// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import {
  SelectedImports,
  type SelectedImportPorts,
} from "../src/renderer/firms/SelectedImports.tsx";
afterEach(cleanup);
it("previews selected text with unknown dates and unverified direction before explicit import to the current person", async () => {
  const personId = "11111111-1111-4111-8111-111111111111";
  let captured = false;
  const ports: SelectedImportPorts = {
    read: async () => ({
      imports: captured
        ? [
            {
              source: {
                workspaceId: personId,
                sourceId: personId,
                kind: "selected_note",
                revision: 1,
                contentHash: "a".repeat(64),
                locator: "selected_excerpt",
                speaker: null,
                occurredAt: null,
                observedAt: "2026-10-09T00:00:00.000Z",
                completeness: "selected_excerpt",
                availability: "available",
                excerpt: "I drafted a reply.",
              },
              metadata: {
                revision: 1,
                subtype: "pasted_text",
                label: "Selected conversation",
                participants: [],
                attachments: [],
                direction: "draft",
                directionVerified: false,
                attribution: "unknown",
                dateProvenance: "unknown",
              },
            },
          ]
        : [],
      nextAfterId: null,
    }),
    preview: async () => ({
      previewHash: "a".repeat(64),
      parserVersion: "selected-v1",
      participants: [],
      occurredAt: null,
      dateProvenance: "unknown",
      direction: "draft",
      directionVerified: false,
      attribution: "unknown",
      candidates: [],
      warnings: ["Imported direction unverified."],
    }),
    commit: async (input) => {
      expect(input.personId).toBe(personId);
      expect(input.firmId).toBeNull();
      expect(input.occurredAt).toBeNull();
      captured = true;
      return { sourceId: personId, sourceRevision: 1, metadataRevision: 1 };
    },
    correct: async () => {},
    remove: async () => {},
    restore: async () => {},
    recapture: async () => {},
    readFile: async () => ({ text: "File passage", label: "transcript.txt" }),
  };
  render(<SelectedImports enabled personId={personId} ports={ports} />);
  await userEvent.type(
    screen.getByLabelText("Selected conversation text"),
    "I drafted a reply.",
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Asserted direction"),
    "draft",
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Import selected conversation",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await userEvent.click(
    screen.getByRole("button", { name: "Preview selected conversation" }),
  );
  expect(await screen.findByText("Original date unknown")).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "Import selected conversation" }),
  );
  expect(await screen.findByText("I drafted a reply.")).toBeTruthy();
  expect(
    screen.getByText("draft — unverified imported assertion"),
  ).toBeTruthy();
  expect(screen.getByText("Participants unknown")).toBeTruthy();
});
it("clears sensitive correction drafts when their copied import is deleted", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let deleted = false;
  const ports: SelectedImportPorts = {
    read: async () => ({
      imports: [
        {
          source: {
            workspaceId: id,
            sourceId: id,
            kind: "selected_note",
            revision: deleted ? 2 : 1,
            contentHash: deleted ? null : "a".repeat(64),
            locator: deleted ? null : "selected_excerpt",
            speaker: null,
            occurredAt: deleted ? null : "2026-09-20T14:00:00.000Z",
            observedAt: "2026-10-09T00:00:00.000Z",
            completeness: deleted ? "unavailable" : "selected_excerpt",
            availability: deleted ? "deleted" : "available",
            excerpt: deleted ? null : "Private imported passage",
          },
          metadata: {
            revision: deleted ? 2 : 1,
            subtype: "pasted_text",
            label: deleted ? null : "Private source label",
            participants: deleted
              ? null
              : [
                  {
                    label: "Private person",
                    endpoint: null,
                    provenance: "user_supplied",
                  },
                ],
            attachments: deleted
              ? null
              : [{ name: "Private filename", url: null }],
            direction: deleted ? null : "draft",
            directionVerified: false,
            attribution: deleted ? null : "asserted",
            dateProvenance: deleted ? null : "user_supplied",
          },
        },
      ],
      nextAfterId: null,
    }),
    preview: async () => ({
      previewHash: "a".repeat(64),
      parserVersion: "selected-v1",
      participants: [],
      occurredAt: null,
      dateProvenance: "unknown",
      direction: "draft",
      directionVerified: false,
      attribution: "unknown",
      candidates: [],
      warnings: [],
    }),
    commit: async () => ({
      sourceId: id,
      sourceRevision: 1,
      metadataRevision: 1,
    }),
    correct: async () => {},
    remove: async () => {
      deleted = true;
    },
    restore: async () => {},
    recapture: async () => {},
    readFile: async () => ({ text: "", label: "" }),
  };
  render(<SelectedImports enabled personId={id} ports={ports} />);
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Correct imported conversation",
    }),
  );
  expect(
    (screen.getByLabelText("Import label") as HTMLInputElement).value,
  ).toBe("Private source label");
  await userEvent.click(
    screen.getByRole("button", { name: "Delete imported conversation" }),
  );
  await screen.findByText("Deleted imported conversation");
  expect(
    (screen.getByLabelText("Import label") as HTMLInputElement).value,
  ).toBe("Selected conversation");
  expect(
    (screen.getByLabelText("Selected conversation text") as HTMLTextAreaElement)
      .value,
  ).toBe("");
  expect(
    (screen.getByLabelText("Original conversation date") as HTMLInputElement)
      .value,
  ).toBe("");
  expect(
    (screen.getByLabelText("Participant labels") as HTMLTextAreaElement).value,
  ).toBe("");
  expect(
    (screen.getByLabelText("Attachment reference name") as HTMLInputElement)
      .value,
  ).toBe("");
});
it("explains the permitted-firm remedy when the original person context cannot accept a new copy", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const ports: SelectedImportPorts = {
    read: async () => ({ imports: [], nextAfterId: null }),
    preview: async () => ({
      previewHash: "a".repeat(64),
      parserVersion: "selected-v1",
      participants: [],
      occurredAt: null,
      dateProvenance: "unknown",
      direction: "unknown",
      directionVerified: false,
      attribution: "unknown",
      candidates: [],
      warnings: [],
    }),
    commit: async () => {
      throw new Error("import_context_required");
    },
    correct: async () => {},
    remove: async () => {},
    restore: async () => {},
    recapture: async () => {},
    readFile: async () => ({ text: "", label: "" }),
  };
  render(<SelectedImports enabled personId={id} ports={ports} />);
  await userEvent.type(
    screen.getByLabelText("Selected conversation text"),
    "Selected permitted-firm history",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Preview selected conversation" }),
  );
  await screen.findByText("Original date unknown");
  await userEvent.click(
    screen.getByRole("button", { name: "Import selected conversation" }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Select the permitted firm",
  );
});
it("preserves every attachment reference while correcting an imported assertion", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  let saved = false;
  const ports: SelectedImportPorts = {
    read: async () => ({
      imports: [
        {
          source: {
            workspaceId: id,
            sourceId: id,
            kind: "selected_note",
            revision: 1,
            contentHash: "a".repeat(64),
            locator: "selected_excerpt",
            speaker: null,
            occurredAt: "2026-09-20T14:00:12.123Z",
            observedAt: "2026-10-09T00:00:00.000Z",
            completeness: "selected_excerpt",
            availability: "available",
            excerpt: "Selected passage",
          },
          metadata: {
            revision: 1,
            subtype: "transcript",
            label: "Selected transcript",
            participants: [],
            attachments: [
              { name: "First.pdf", url: null },
              { name: "Second.pdf", url: "https://example.test/second" },
            ],
            direction: "unknown",
            directionVerified: false,
            attribution: "unknown",
            dateProvenance: "unknown",
          },
        },
      ],
      nextAfterId: null,
    }),
    preview: async () => ({
      previewHash: "a".repeat(64),
      parserVersion: "selected-v1",
      participants: [],
      occurredAt: null,
      dateProvenance: "unknown",
      direction: "draft",
      directionVerified: false,
      attribution: "unknown",
      candidates: [],
      warnings: [],
    }),
    commit: async () => ({
      sourceId: id,
      sourceRevision: 1,
      metadataRevision: 1,
    }),
    correct: async (input) => {
      expect(input.attachments).toEqual([
        { name: "First.pdf", url: null },
        { name: "Second.pdf", url: "https://example.test/second" },
      ]);
      expect(input.occurredAt).toBe("2026-09-20T14:00:12.123Z");
      expect(input.expectedSourceRevision).toBe(1);
      expect(input.expectedMetadataRevision).toBe(1);
      saved = true;
    },
    remove: async () => {},
    restore: async () => {},
    recapture: async () => {},
    readFile: async () => ({ text: "", label: "" }),
  };
  render(<SelectedImports enabled personId={id} ports={ports} />);
  await userEvent.click(
    await screen.findByRole("button", {
      name: "Correct imported conversation",
    }),
  );
  await userEvent.selectOptions(
    screen.getByLabelText("Asserted direction"),
    "draft",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Preview selected conversation" }),
  );
  await screen.findByRole("region", { name: "Import preview" });
  await userEvent.click(
    screen.getByRole("button", { name: "Save import correction" }),
  );
  expect(saved).toBe(true);
});
