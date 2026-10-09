// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type {
  BusinessPolicy,
  MailConversation,
  MailSourceList,
} from "@fss/contracts";
import {
  EmailTimeline,
  type EmailTimelinePorts,
} from "../src/renderer/firms/EmailTimeline.tsx";
import { People, type PeoplePorts } from "../src/renderer/firms/People.tsx";
import {
  FirmAddresses,
  type FirmAddressPorts,
} from "../src/renderer/firms/FirmAddresses.tsx";
import { BusinessReview } from "../src/renderer/firms/BusinessReview.tsx";
import { emailTimelinePorts } from "../src/renderer/firms/emailTimelinePorts.ts";
import { createAuthedClient } from "../src/main/authedClient.ts";
import {
  answerOperation,
  operationHandlers,
  type OperationHostDeps,
} from "../src/main/operationHost.ts";
import type { OperationApi } from "../src/shared/operations.ts";
import { FirmsRoute } from "../src/renderer/firms/FirmsRoute.tsx";
import { createGeneration } from "../src/renderer/app/generation.ts";
import { DraftsProvider } from "../src/renderer/app/drafts.tsx";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  assigneeFirmPage,
  crmState,
  FIRM_ID,
} from "./e2e/support/crmFixtures.ts";
import { resetCrmMemory } from "../src/renderer/firms/crmMemory.ts";

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
  resetCrmMemory();
});
const SOURCE = "11111111-1111-4111-8111-111111111111";
const FIRM = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";
const HASH = "a".repeat(64);
const PROVIDER_AT = "2026-09-10T15:00:00.000Z";
const OBSERVED_AT = "2026-10-09T12:00:00.000Z";
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized promise");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function list(): MailSourceList {
  return {
    sources: [
      {
        sourceId: SOURCE,
        sourceRevision: 1,
        contentHash: HASH,
        availability: "available",
        occurredAt: PROVIDER_AT,
        completeness: "partial",
      },
    ],
    nextAfterId: null,
  };
}
function conversation(): MailConversation {
  return {
    state: "available",
    source: {
      sourceId: SOURCE,
      direction: "outgoing",
      subject: "A partial business conversation",
      sourceRevision: 1,
      contentHash: HASH,
      passage: "Retained email text.",
      ownerUserId: PERSON,
      mailboxId: PERSON,
      accountBinding: HASH,
      acquiredGeneration: 2,
      originalContexts: [
        {
          contextId: SOURCE,
          personId: null,
          firmId: null,
          opportunityId: null,
          sourceRevision: 1,
          review: "current",
          operationalMatchId: null,
          operationalMatchHash: null,
          identityStatus: "observed_label",
        },
      ],
      reviewedContexts: [],
      participants: ["Alex Example <alex@example.test>"],
      parserVersion: "gmail-mime-v1",
      representation: "html_flattened",
      completeness: "partial",
      rawSenderDate: null,
      occurredAt: PROVIDER_AT,
      observedAt: OBSERVED_AT,
      ranges: [{ start: 0, end: 20, kind: "forwarded" }],
      sentProof: false,
    },
  };
}
it("opens approved email with explicit partial, observed identity and date labels without asserting Sent proof", async () => {
  const user = userEvent.setup();
  const ports: EmailTimelinePorts = {
    list: async (input) => {
      expect(input).toEqual({ firmId: FIRM, limit: 50 });
      return list();
    },
    read: async (input) => {
      expect(input).toEqual({
        sourceId: SOURCE,
        sourceRevision: 1,
        contentHash: HASH,
      });
      return conversation();
    },
  };
  render(
    <EmailTimeline enabled ports={ports} firmId={FIRM} privacyKey="owner:2" />,
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  expect(await screen.findByText("Retained email text.")).toBeTruthy();
  expect(screen.getByText("Partial copied content")).toBeTruthy();
  expect(screen.getByText("Sender date unknown")).toBeTruthy();
  expect(screen.getByText(`Provider date: ${PROVIDER_AT}`)).toBeTruthy();
  expect(screen.getByText(`Observed in Callie: ${OBSERVED_AT}`)).toBeTruthy();
  expect(screen.getByText("Observed name; person unconfirmed")).toBeTruthy();
  expect(screen.getByText("Firm unknown")).toBeTruthy();
  expect(screen.getByText("Sent state unverified")).toBeTruthy();
  expect(
    screen.getByText("Parser: gmail-mime-v1 · HTML flattened · revision 1"),
  ).toBeTruthy();
  expect(screen.getByText("Forwarded text")).toBeTruthy();
  expect(screen.queryByText("Provider-verified Sent message")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /send|enroll|enable capture/i }),
  ).toBeNull();
});
it("clears the copied body immediately on deletion and ignores an older pagination response", async () => {
  const user = userEvent.setup();
  const pendingPage = deferred<MailSourceList>();
  const pendingDelete = deferred<{
    sourceId: string;
    sourceRevision: number;
    availability: "deleted";
  }>();
  let deleted = false;
  const ports: EmailTimelinePorts = {
    list: async (input) =>
      input.afterId
        ? pendingPage.promise
        : deleted
          ? {
              sources: [
                {
                  ...list().sources[0]!,
                  sourceRevision: 2,
                  availability: "deleted",
                },
              ],
              nextAfterId: null,
            }
          : { ...list(), nextAfterId: SOURCE },
    read: async () => conversation(),
    remove: async (input) => {
      expect(input).toEqual({ sourceId: SOURCE, expectedRevision: 1 });
      deleted = true;
      return pendingDelete.promise;
    },
  };
  render(
    <EmailTimeline enabled ports={ports} firmId={FIRM} privacyKey="owner:2" />,
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  await screen.findByText("Retained email text.");
  await user.click(screen.getByRole("button", { name: "More copied emails" }));
  await user.click(screen.getByRole("button", { name: "Delete copied email" }));
  expect(screen.queryByText("Retained email text.")).toBeNull();
  await act(async () => {
    pendingDelete.resolve({
      sourceId: SOURCE,
      sourceRevision: 2,
      availability: "deleted",
    });
  });
  await screen.findByText("Copied email deleted");
  await act(async () => {
    pendingPage.resolve({
      sources: [{ ...list().sources[0]!, sourceId: PERSON }],
      nextAfterId: null,
    });
  });
  expect(screen.queryByRole("button", { name: "Open email 2" })).toBeNull();
  expect(screen.queryByText("Retained email text.")).toBeNull();
  expect(screen.getByText("Copied email deleted")).toBeTruthy();
});
it("restores only to awaiting recapture and neither fetches nor restores deleted email text", async () => {
  const user = userEvent.setup();
  let restored = false;
  let bodyReads = 0;
  const ports: EmailTimelinePorts = {
    list: async () => ({
      sources: [
        {
          ...list().sources[0]!,
          sourceRevision: restored ? 3 : 2,
          availability: restored ? "awaiting_recapture" : "deleted",
        },
      ],
      nextAfterId: null,
    }),
    read: async () => {
      bodyReads++;
      return conversation();
    },
    restore: async (input) => {
      expect(input).toEqual({ sourceId: SOURCE, expectedRevision: 2 });
      restored = true;
      return {
        sourceId: SOURCE,
        sourceRevision: 3,
        availability: "awaiting_recapture",
      };
    },
  };
  render(<EmailTimeline enabled ports={ports} privacyKey="owner:2" />);
  await user.click(
    await screen.findByRole("button", { name: "Restore copy for recapture" }),
  );
  expect(await screen.findByText("Awaiting explicit recapture")).toBeTruthy();
  expect(bodyReads).toBe(0);
  expect(screen.queryByText("Retained email text.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Open email 1" })).toBeNull();
});
it("requests recapture only after a separate click and keeps queued content unavailable", async () => {
  const user = userEvent.setup();
  let requests = 0;
  const ports: EmailTimelinePorts = {
    list: async () => ({
      sources: [
        {
          ...list().sources[0]!,
          sourceRevision: 3,
          availability: "awaiting_recapture",
        },
      ],
      nextAfterId: null,
    }),
    read: async () => {
      throw new Error("A queued copy has no readable body");
    },
    recapture: async (input) => {
      expect(input).toEqual({ sourceId: SOURCE, expectedRevision: 3 });
      requests++;
      return { sourceId: SOURCE, sourceRevision: 3, status: "queued" };
    },
  };
  render(<EmailTimeline enabled ports={ports} privacyKey="owner:2" />);
  const request = await screen.findByRole<HTMLButtonElement>("button", {
    name: "Request recapture",
  });
  expect(requests).toBe(0);
  await user.click(request);
  expect(
    await screen.findByText(
      "Recapture requested; copied content is not yet available.",
    ),
  ).toBeTruthy();
  expect(requests).toBe(1);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Request recapture" })
      .disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Open email 1" })).toBeNull();
});
it("records a reviewed firm correction against the displayed revision while preserving original context", async () => {
  const user = userEvent.setup();
  let associated = false;
  const original = conversation();
  if (original.state !== "available")
    throw new Error("Available fixture required");
  const ports: EmailTimelinePorts = {
    list: async () => ({
      ...list(),
      sources: list().sources.map((row) => ({
        ...row,
        sourceRevision: associated ? 2 : 1,
      })),
    }),
    read: async (input) => ({
      ...original,
      source: {
        ...original.source,
        sourceRevision: input.sourceRevision,
        originalContexts: original.source.originalContexts.map((context) => ({
          ...context,
          firmId: FIRM,
          identityStatus: "reviewed",
        })),
        reviewedContexts: associated
          ? [
              {
                ...original.source.originalContexts[0]!,
                contextId: PERSON,
                firmId: PERSON,
                identityStatus: "reviewed",
                sourceRevision: 2,
              },
            ]
          : [],
      },
    }),
    associate: async (input) => {
      expect(input).toEqual({
        sourceId: SOURCE,
        expectedRevision: 1,
        firmId: PERSON,
      });
      associated = true;
      return { sourceId: SOURCE, sourceRevision: 2 };
    },
  };
  render(
    <EmailTimeline
      enabled
      ports={ports}
      privacyKey="owner:2"
      firms={[
        { id: FIRM, name: "Original firm A" },
        { id: PERSON, name: "Reviewed firm B" },
      ]}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  await user.selectOptions(
    screen.getByLabelText("Reviewed email firm"),
    PERSON,
  );
  await user.click(
    screen.getByRole("button", { name: "Record reviewed email context" }),
  );
  expect(screen.queryByText("Retained email text.")).toBeNull();
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  expect(await screen.findByText("Firm: Original firm A")).toBeTruthy();
  expect(screen.getByText("Firm: Reviewed firm B")).toBeTruthy();
  expect(
    screen.getByText("Parser: gmail-mime-v1 · HTML flattened · revision 2"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /send|enroll|create opportunity/i }),
  ).toBeNull();
});
it("does not publish an older private body after a fresh history read replaces its source", async () => {
  const user = userEvent.setup();
  const pending = deferred<MailConversation>();
  let reads = 0;
  const ports: EmailTimelinePorts = {
    list: async () =>
      ++reads === 1 ? list() : { sources: [], nextAfterId: null },
    read: async () => pending.promise,
  };
  render(<EmailTimeline enabled ports={ports} privacyKey="owner:2" />);
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  await user.click(
    screen.getByRole("button", { name: "Refresh copied emails" }),
  );
  await screen.findByText("No copied emails available.");
  await act(async () => {
    pending.resolve(conversation());
  });
  expect(screen.queryByText("Retained email text.")).toBeNull();
  expect(screen.queryByText("Alex Example <alex@example.test>")).toBeNull();
});
it("opens email on the selected person record with a bound person filter", async () => {
  const user = userEvent.setup();
  const person = {
    personId: PERSON,
    fullName: "Reviewed person",
    firm: null,
    revision: 1,
  };
  const ports: PeoplePorts = {
    list: async () => ({ people: [person], nextAfterId: null }),
    read: async () => ({ person, sources: [], nextAfterSourceId: null }),
    create: async () => {
      throw new Error("Unexpected create");
    },
    add: async () => {
      throw new Error("Unexpected note");
    },
    remove: async () => {
      throw new Error("Unexpected note deletion");
    },
    restore: async () => {
      throw new Error("Unexpected note restoration");
    },
    recapture: async () => {
      throw new Error("Unexpected note recapture");
    },
  };
  const mail: EmailTimelinePorts = {
    list: async (input) => {
      expect(input).toEqual({ personId: PERSON, limit: 50 });
      return list();
    },
    read: async () => conversation(),
  };
  render(<People enabled ports={ports} mail={mail} privacyKey="owner:2" />);
  await user.click(
    await screen.findByRole("button", { name: "Reviewed person" }),
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  expect(await screen.findByText("Retained email text.")).toBeTruthy();
});
it("keeps approved history readable while broader capture is off and offers no enable action", async () => {
  const user = userEvent.setup();
  const ports: EmailTimelinePorts = {
    list: async () => list(),
    read: async () => conversation(),
    controls: async (input) => {
      expect(input).toEqual({ mailboxId: PERSON });
      return {
        mailboxId: PERSON,
        enabled: false,
        ready: false,
        reason: "activation_not_available",
        revision: 0,
      };
    },
  };
  render(
    <EmailTimeline
      enabled
      ports={ports}
      mailboxId={PERSON}
      privacyKey="owner:2"
    />,
  );
  expect(
    await screen.findByText("Business email capture is off."),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Open email 1" }));
  expect(await screen.findByText("Retained email text.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /enable capture/i })).toBeNull();
});
it("invalidates a sibling firm timeline after public copied-email deletion and rejects its pending page", async () => {
  const user = userEvent.setup();
  const pendingPage = deferred<MailSourceList>();
  let deleted = false;
  const ports: EmailTimelinePorts = {
    list: async (input) =>
      input.afterId
        ? pendingPage.promise
        : deleted
          ? {
              sources: [
                {
                  ...list().sources[0]!,
                  sourceRevision: 2,
                  availability: "deleted",
                  occurredAt: null,
                },
              ],
              nextAfterId: null,
            }
          : { ...list(), nextAfterId: SOURCE },
    read: async () => conversation(),
    remove: async () => {
      deleted = true;
      return { sourceId: SOURCE, sourceRevision: 2, availability: "deleted" };
    },
  };
  function Records() {
    const [version, setVersion] = useState(0);
    return (
      <>
        <section aria-label="Original firm timeline">
          <EmailTimeline
            enabled
            ports={ports}
            privacyKey="owner:2"
            firmId={FIRM}
            sourceVersion={version}
            onSourceChange={() => setVersion((value) => value + 1)}
          />
        </section>
        <section aria-label="Reviewed firm timeline">
          <EmailTimeline
            enabled
            ports={ports}
            privacyKey="owner:2"
            firmId={PERSON}
            sourceVersion={version}
            onSourceChange={() => setVersion((value) => value + 1)}
          />
        </section>
      </>
    );
  }
  render(<Records />);
  const original = within(
    screen.getByRole("region", { name: "Original firm timeline" }),
  );
  const reviewed = within(
    screen.getByRole("region", { name: "Reviewed firm timeline" }),
  );
  await user.click(
    await original.findByRole("button", { name: "Open email 1" }),
  );
  await user.click(
    await reviewed.findByRole("button", { name: "Open email 1" }),
  );
  await reviewed.findByText("Retained email text.");
  await user.click(
    reviewed.getByRole("button", { name: "More copied emails" }),
  );
  await user.click(
    original.getByRole("button", { name: "Delete copied email" }),
  );
  await reviewed.findByText("Copied email deleted");
  expect(reviewed.queryByText("Retained email text.")).toBeNull();
  await act(async () => {
    pendingPage.resolve(list());
  });
  expect(reviewed.queryByRole("button", { name: "Open email 1" })).toBeNull();
});
it("opens an email through the renderer adapter and authenticated operation host without exposing paths to the renderer", async () => {
  const user = userEvent.setup();
  const requests: string[] = [];
  const api = createAuthedClient({
    baseUrl: "https://api.example.test",
    clientVersion: "1.0.49",
    accessToken: async () => ({ token: "fixture", generation: 0 }),
    send: async (url) => {
      const path = new URL(url).pathname;
      requests.push(path);
      return {
        status: 200,
        body:
          path === "/crm/people/list"
            ? {
                people: [
                  {
                    personId: PERSON,
                    fullName: "Reviewed person",
                    firm: null,
                    revision: 1,
                  },
                ],
                nextAfterId: null,
              }
            : path === "/firms"
              ? { firms: [] }
              : path.endsWith("controls/read")
                ? {
                    mailboxId: PERSON,
                    enabled: false,
                    ready: false,
                    reason: "activation_not_available",
                    revision: 0,
                  }
                : path.endsWith("/list")
                  ? list()
                  : conversation(),
      };
    },
  });
  const handlers = operationHandlers({
    api,
    recordings: { identity: { current: () => 0 } },
  } as unknown as OperationHostDeps);
  globalThis.callieApi = {
    read: async (name: string, input: unknown) =>
      answerOperation(handlers, "read", name, input),
    command: async (name: string, input: unknown) =>
      answerOperation(handlers, "command", name, input),
  } as unknown as OperationApi;
  render(
    <EmailTimeline
      enabled
      ports={emailTimelinePorts}
      privacyKey="owner:2"
      firmId={FIRM}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  expect(await screen.findByText("Retained email text.")).toBeTruthy();
  await user.selectOptions(
    await screen.findByLabelText("Reviewed email person"),
    PERSON,
  );
  expect(requests.sort()).toEqual([
    "/crm/business/mail/controls/read",
    "/crm/business/mail/list",
    "/crm/business/mail/read",
    "/crm/people/list",
    "/firms",
  ]);
});
it("opens email on a selected firm record using only that firm filter", async () => {
  const user = userEvent.setup();
  const ports: FirmAddressPorts = {
    firms: async () => [{ firmId: FIRM, name: "Original firm A" }],
    read: async () => ({ sources: [], nextAfterSourceId: null }),
    add: async () => {
      throw new Error("Unexpected note");
    },
    remove: async () => {
      throw new Error("Unexpected note deletion");
    },
    restore: async () => {
      throw new Error("Unexpected note restoration");
    },
    recapture: async () => {
      throw new Error("Unexpected note recapture");
    },
  };
  const mail: EmailTimelinePorts = {
    list: async (input) => {
      expect(input).toEqual({ firmId: FIRM, limit: 50 });
      return list();
    },
    read: async () => conversation(),
  };
  render(
    <FirmAddresses
      enabled
      ports={ports}
      mail={mail}
      privacyKey="owner:2"
      endpoints={{
        list: async () => ({ claims: [], nextAfterId: null }),
        match: async () => {
          throw new Error("Unexpected match");
        },
      }}
    />,
  );
  await user.selectOptions(
    await screen.findByLabelText("Shared-address firm"),
    FIRM,
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  expect(await screen.findByText("Retained email text.")).toBeTruthy();
});
it("keeps approved unknown-firm copies accessible within existing conversation review", async () => {
  const user = userEvent.setup();
  const policy: BusinessPolicy = {
    mailboxId: PERSON,
    ownerUserId: PERSON,
    emailAddress: "owner@example.test",
    generation: 2,
    accountBinding: HASH,
    revision: 0,
    enabled: false,
    scopeDays: 90,
    classificationMode: "metadata_only",
    disclosure: null,
    ready: false,
    reasons: ["activation_not_available"],
    metadataReviewDisclosureText: "Metadata only.",
    metadataReviewDisclosure: {
      version: "business-metadata-review-v1",
      sha256: HASH,
    },
  };
  const mail: EmailTimelinePorts = {
    list: async (input) => {
      expect(input).toEqual({ mailboxId: PERSON, limit: 50 });
      return list();
    },
    read: async () => conversation(),
  };
  render(
    <BusinessReview
      enabled
      mail={mail}
      privacyKey="owner:2"
      ports={{
        policy: async () => policy,
        savePolicy: async () => {
          throw new Error("Unexpected consent");
        },
      }}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  expect(await screen.findByText("Retained email text.")).toBeTruthy();
  expect(screen.getByText("Firm unknown")).toBeTruthy();
  expect(
    screen.getByText("Business conversation capture is off."),
  ).toBeTruthy();
});
it("wires the authenticated email timeline onto the actual firm page", async () => {
  const user = userEvent.setup();
  resetCrmMemory();
  const state = crmState({
    screen: "firm",
    firm: assigneeFirmPage(),
    role: "salesperson",
  });
  const answer = async (name: string, input: unknown) => {
    if (name === "crm.state" || name === "crm.openFirm") return state;
    if (name === "crm.businessMailList") {
      expect(input).toEqual({ firmId: FIRM_ID, limit: 50 });
      return list();
    }
    if (name === "crm.businessMailRead") return conversation();
    if (name === "crm.businessMailControls")
      return {
        mailboxId: PERSON,
        enabled: false,
        ready: false,
        reason: "activation_not_available",
        revision: 0,
      };
    if (name === "research.open")
      return {
        firm: null,
        settings: null,
        worstCaseRunCents: null,
        spend: null,
        notice: null,
        mayMutate: true,
        role: "salesperson",
      };
    if (name === "calling.history") return { calls: null };
    if (name === "meetings.forFirm" || name === "meetings.unmatched")
      return { meetings: [] };
    throw new Error(`Unexpected operation ${name}`);
  };
  globalThis.callieApi = {
    read: answer,
    command: answer,
  } as unknown as OperationApi;
  const generation = createGeneration();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DraftsProvider>
        <FirmsRoute
          route={{ name: "firm", firmId: FIRM_ID }}
          identity="owner"
          generation={0}
          guard={generation.guard}
        />
      </DraftsProvider>
    </QueryClientProvider>,
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  expect(await screen.findByText("Retained email text.")).toBeTruthy();
});
for (const change of [
  "authentication",
  "firm navigation",
  "access disabled",
] as const) {
  it(`discards a private email read after ${change}`, async () => {
    const user = userEvent.setup();
    const pending = deferred<MailConversation>();
    let active = true;
    const ports: EmailTimelinePorts = {
      list: async () => (active ? list() : { sources: [], nextAfterId: null }),
      read: async () => pending.promise,
    };
    const view = render(
      <EmailTimeline
        enabled
        ports={ports}
        privacyKey="owner:2"
        firmId={FIRM}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Open email 1" }),
    );
    active = false;
    view.rerender(
      <EmailTimeline
        enabled={change !== "access disabled"}
        ports={ports}
        privacyKey={change === "authentication" ? "other-owner:3" : "owner:2"}
        firmId={change === "firm navigation" ? PERSON : FIRM}
      />,
    );
    await act(async () => {
      pending.resolve(conversation());
    });
    expect(screen.queryByText("Retained email text.")).toBeNull();
    expect(screen.queryByText("A partial business conversation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open email 1" })).toBeNull();
  });
}
it("allows an observed unknown-firm copy to be explicitly associated with a currently listed person", async () => {
  const user = userEvent.setup();
  let associated = false;
  const ports: EmailTimelinePorts = {
    list: async () => list(),
    read: async () => conversation(),
    choices: async () => ({
      people: [{ id: PERSON, name: "Reviewed person" }],
      firms: [],
    }),
    associate: async (input) => {
      expect(input).toEqual({
        sourceId: SOURCE,
        expectedRevision: 1,
        personId: PERSON,
      });
      associated = true;
      return { sourceId: SOURCE, sourceRevision: 2 };
    },
  };
  render(
    <EmailTimeline
      enabled
      ports={ports}
      privacyKey="owner:2"
      mailboxId={PERSON}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  await user.selectOptions(
    await screen.findByLabelText("Reviewed email person"),
    PERSON,
  );
  await user.click(
    screen.getByRole("button", { name: "Record reviewed email context" }),
  );
  expect(associated).toBe(true);
});
it("evicts cached source metadata when the current exact read denies source access", async () => {
  const user = userEvent.setup();
  const ports: EmailTimelinePorts = {
    list: async () => list(),
    read: async () => ({
      state: "unavailable",
      reason: "source_access_denied",
      source: null,
    }),
  };
  render(<EmailTimeline enabled ports={ports} privacyKey="owner:2" />);
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  await screen.findByText("This copied email is unavailable.");
  expect(screen.queryByRole("button", { name: "Open email 1" })).toBeNull();
  expect(screen.queryByText(`· ${PROVIDER_AT}`)).toBeNull();
});

it("binds supplied quoted and forwarded attribution to their exact text while keeping uncovered text unknown", async () => {
  const user = userEvent.setup();
  const value = conversation();
  if (value.state !== "available")
    throw new Error("Expected available fixture");
  const authored = "New text.\n";
  const quoted = "> Older reply.\n";
  const forwarded = "Forwarded copy.\n";
  const unknown = "Unattributed.";
  value.source.passage = authored + quoted + forwarded + unknown;
  value.source.ranges = [
    { start: 0, end: authored.length, kind: "authored" },
    {
      start: authored.length,
      end: authored.length + quoted.length,
      kind: "quoted",
    },
    {
      start: authored.length + quoted.length,
      end: authored.length + quoted.length + forwarded.length,
      kind: "forwarded",
    },
  ];
  render(
    <EmailTimeline
      enabled
      privacyKey="owner:2"
      ports={{ list: async () => list(), read: async () => value }}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Open email 1" }));
  const blocks = within(
    await screen.findByRole("list", { name: "Email text attribution" }),
  ).getAllByRole("listitem");
  expect(blocks).toHaveLength(4);
  expect(within(blocks[0]!).getByText("Authored text")).toBeTruthy();
  expect(within(blocks[0]!).getByText(authored.trim())).toBeTruthy();
  expect(within(blocks[1]!).getByText("Quoted text")).toBeTruthy();
  expect(within(blocks[1]!).getByText(quoted.trim())).toBeTruthy();
  expect(within(blocks[2]!).getByText("Forwarded text")).toBeTruthy();
  expect(within(blocks[2]!).getByText(forwarded.trim())).toBeTruthy();
  expect(within(blocks[3]!).getByText("Text attribution unknown")).toBeTruthy();
  expect(within(blocks[3]!).getByText(unknown)).toBeTruthy();
});
