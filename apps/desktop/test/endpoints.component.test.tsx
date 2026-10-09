// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import {
  Endpoints,
  type EndpointPorts,
} from "../src/renderer/firms/Endpoints.tsx";
afterEach(cleanup);
const ID = "11111111-1111-4111-8111-111111111111";
it("shows a shared firm address with unknown speaker and keeps uncertain matching explicit", async () => {
  const claim = {
    claimId: ID,
    endpointId: ID,
    kind: "email" as const,
    value: "info@example.test",
    personId: null,
    personName: null,
    firmId: ID,
    firmName: "Example Firm",
    shared: true,
    status: "current" as const,
    startDate: null,
    endDate: null,
    revision: 1,
    evidence: { sourceId: ID, sourceRevision: 1, contentHash: "a".repeat(64) },
    sourceState: "available" as const,
  };
  const ports: EndpointPorts = {
    list: async () => ({ claims: [claim], nextAfterId: null }),
    match: async () => ({
      outcome: "needs_review",
      reason: "uncertain_identity",
      personId: null,
      firmId: null,
      candidates: [claim],
    }),
  };
  render(<Endpoints firmId={ID} ports={ports} />);
  expect(await screen.findByText("Unknown human speaker")).toBeTruthy();
  await userEvent.type(
    screen.getByLabelText("Address or number"),
    "info@example.test",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Check existing identity" }),
  );
  expect(
    await screen.findByText("Identity needs review; no automatic merge."),
  ).toBeTruthy();
  expect(screen.getByText("Example Firm")).toBeTruthy();
});
it("requires an identity check and exact source before explicitly recording an endpoint claim", async () => {
  const user = userEvent.setup();
  let saved = false;
  const ports: EndpointPorts = {
    list: async () => ({ claims: [], nextAfterId: null }),
    match: async () => ({
      outcome: "no_supported_match",
      reason: "no_supported_evidence",
      personId: null,
      firmId: null,
      candidates: [],
    }),
  };
  const editing = {
    claim: async (input: {
      personId: string | null;
      firmId: string | null;
      shared: boolean;
      evidence: { sourceId: string; sourceRevision: number };
    }) => {
      expect(input.personId).toBeNull();
      expect(input.firmId).toBe(ID);
      expect(input.shared).toBe(true);
      expect(input.evidence.sourceRevision).toBe(1);
      saved = true;
    },
    correct: async () => {},
  };
  const sources = [
    {
      workspaceId: ID,
      sourceId: ID,
      kind: "selected_note" as const,
      revision: 1,
      contentHash: "a".repeat(64),
      locator: "selected_excerpt",
      speaker: null,
      occurredAt: "2026-09-10T15:00:00.000Z",
      observedAt: "2026-10-08T15:00:00.000Z",
      completeness: "selected_excerpt" as const,
      availability: "available" as const,
      excerpt: "Firm shared inbox.",
    },
  ];
  render(
    <Endpoints
      firmId={ID}
      ports={ports}
      editing={editing}
      sources={sources}
      enabled
    />,
  );
  await user.type(
    screen.getByLabelText("Address or number"),
    "info@example.test",
  );
  await user.selectOptions(
    screen.getByLabelText("Endpoint supporting note"),
    ID,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Record supported address",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.click(
    screen.getByRole("button", { name: "Check existing identity" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Record supported address" }),
  );
  expect(saved).toBe(true);
});

it.each(["person", "firm"] as const)(
  "explicitly corrects endpoint ownership to another %s with exact evidence and expected revision",
  async (targetKind) => {
    const targetId = "22222222-2222-4222-8222-222222222222";
    const evidence = {
      sourceId: ID,
      sourceRevision: 1,
      contentHash: "a".repeat(64),
    };
    let corrected = false;
    const claim = {
      claimId: ID,
      endpointId: ID,
      kind: "email" as const,
      value: "alex@example.test",
      personId: ID,
      personName: "Alex",
      firmId: null,
      firmName: null,
      shared: false,
      status: "current" as const,
      startDate: null,
      endDate: null,
      revision: 4,
      evidence,
      sourceState: "available" as const,
    };
    const ports: EndpointPorts = {
      list: async () => ({
        claims: corrected ? [] : [claim],
        nextAfterId: null,
      }),
      match: async () => ({
        outcome: "needs_review",
        reason: "uncertain_identity",
        candidates: [claim],
        personId: null,
        firmId: null,
      }),
    };
    const editing = {
      owners: async () => [
        { kind: targetKind, id: targetId, name: "Correct owner" },
      ],
      claim: async () => {},
      correct: async (input: {
        personId: string | null;
        firmId: string | null;
        shared: boolean;
        expectedRevision: number;
        evidence: typeof evidence;
      }) => {
        expect(input.personId).toBe(targetKind === "person" ? targetId : null);
        expect(input.firmId).toBe(targetKind === "firm" ? targetId : null);
        expect(input.shared).toBe(targetKind === "firm");
        expect(input.expectedRevision).toBe(4);
        expect(input.evidence).toEqual(evidence);
        corrected = true;
      },
    };
    render(
      <Endpoints
        personId={ID}
        ports={ports}
        editing={editing}
        enabled
        sources={[
          {
            workspaceId: ID,
            sourceId: ID,
            kind: "selected_note",
            revision: 1,
            contentHash: evidence.contentHash,
            locator: "selected_excerpt",
            speaker: null,
            occurredAt: "2026-10-08T15:00:00.000Z",
            observedAt: "2026-10-08T15:00:00.000Z",
            completeness: "selected_excerpt",
            availability: "available",
            excerpt: "Supported owner correction.",
          },
        ]}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Correct address association",
      }),
    );
    await userEvent.selectOptions(
      await screen.findByLabelText("Correct endpoint owner"),
      `${targetKind}:${targetId}`,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Check existing identity" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save address correction" }),
    );
    expect(corrected).toBe(true);
  },
);
