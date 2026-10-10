// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import {
  CrmCapabilitiesSection,
  type CrmCapabilityPorts,
} from "../src/renderer/settings/CrmCapabilitiesSection.tsx";
import type { z } from "zod";
import type { crmCapabilityReadResponseSchema } from "@fss/contracts";
afterEach(cleanup);
const ID = "11111111-1111-4111-8111-111111111111",
  RECEIPT = "22222222-2222-4222-8222-222222222222";
type View = z.infer<typeof crmCapabilityReadResponseSchema>;
function metadata(enabled = false): View {
  return {
    capability: "metadata_review",
    mailboxId: ID,
    configured: true,
    revision: enabled ? 4 : 3,
    enabled,
    ready: true,
    reason: "ready",
    authorityReceiptId: RECEIPT,
    proposedRevision: enabled ? 5 : 4,
    proposedConfigurationFingerprint: "a".repeat(64),
    configuration: {
      capability: "metadata_review",
      workspaceId: ID,
      ownerUserId: ID,
      mailboxId: ID,
      revision: enabled ? 4 : 3,
      providerAccountId: "synthetic account",
      generation: 2,
      accountBinding: "a".repeat(64),
      disclosureVersion: "metadata-v1",
      disclosureSha256: "a".repeat(64),
      scopeDays: 90,
    },
  };
}
function unavailable(capability: View["capability"]): View {
  return {
    capability,
    mailboxId: capability === "mail_capture" ? ID : null,
    configured: false,
    revision: 0,
    enabled: false,
    ready: false,
    reason: "configuration_unavailable",
    authorityReceiptId: null,
    proposedRevision: 1,
    proposedConfigurationFingerprint: null,
    configuration: null,
  };
}
it("activates only the prepared metadata capability with its exact receipt and refreshes current state", async () => {
  const user = userEvent.setup();
  let activated = false;
  const ports: CrmCapabilityPorts = {
    read: async (input) =>
      input.capability === "metadata_review"
        ? metadata(activated)
        : unavailable(input.capability),
    activate: async (input) => {
      expect(input).toEqual({
        capability: "metadata_review",
        mailboxId: ID,
        expectedRevision: 3,
        authorityReceiptId: RECEIPT,
      });
      activated = true;
      return { revision: 4, enabled: true, authorityReceiptId: RECEIPT };
    },
    disable: async () => {
      throw new Error("unexpected disable");
    },
  };
  render(
    <CrmCapabilitiesSection
      scope="mail"
      available
      privacyKey="owner:1"
      mailboxId={ID}
      ports={ports}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Activate metadata review" }),
  );
  expect(activated).toBe(true);
  expect(
    await screen.findByRole("button", { name: "Disable metadata review" }),
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Activate original email capture",
    }).disabled,
  ).toBe(true);
});

it("allows disable even when current authority is unavailable", async () => {
  const user = userEvent.setup();
  let disabled = false;
  const ports: CrmCapabilityPorts = {
    read: async (input) =>
      input.capability === "metadata_review"
        ? disabled
          ? {
              ...metadata(),
              revision: 5,
              ready: false,
              authorityReceiptId: null,
            }
          : { ...metadata(true), ready: false, reason: "authority_unavailable" }
        : unavailable(input.capability),
    activate: async () => {
      throw new Error("unexpected activate");
    },
    disable: async (input) => {
      expect(input).toEqual({
        capability: "metadata_review",
        mailboxId: ID,
        expectedRevision: 4,
      });
      disabled = true;
      return { revision: 5, enabled: false, authorityReceiptId: null };
    },
  };
  render(
    <CrmCapabilitiesSection
      scope="mail"
      available
      privacyKey="owner:1"
      mailboxId={ID}
      ports={ports}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Disable metadata review" }),
  );
  expect(disabled).toBe(true);
  expect(
    (
      await screen.findByRole<HTMLButtonElement>("button", {
        name: "Activate metadata review",
      })
    ).disabled,
  ).toBe(true);
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("uninitialized deferred");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("does not publish an old account command completion into the next identity", async () => {
  const user = userEvent.setup();
  const pending = deferred<{
    revision: number;
    enabled: boolean;
    authorityReceiptId: string | null;
  }>();
  const next = "33333333-3333-4333-8333-333333333333";
  let oldReads = 0;
  const ports: CrmCapabilityPorts = {
    read: async (input) => {
      if (input.mailboxId === ID) {
        oldReads++;
        return input.capability === "metadata_review"
          ? metadata()
          : unavailable(input.capability);
      }
      return { ...unavailable(input.capability), mailboxId: next };
    },
    activate: async () => pending.promise,
    disable: async () => {
      throw new Error("unexpected disable");
    },
  };
  const view = render(
    <CrmCapabilitiesSection
      scope="mail"
      available
      privacyKey="owner:1"
      mailboxId={ID}
      ports={ports}
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Activate metadata review" }),
  );
  view.rerender(
    <CrmCapabilitiesSection
      scope="mail"
      available
      privacyKey="other:2"
      mailboxId={next}
      ports={ports}
    />,
  );
  expect(
    (
      await screen.findByRole<HTMLButtonElement>("button", {
        name: "Activate metadata review",
      })
    ).disabled,
  ).toBe(true);
  await act(async () =>
    pending.resolve({
      revision: 4,
      enabled: true,
      authorityReceiptId: RECEIPT,
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Disable metadata review" }),
  ).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Activate metadata review",
    }).disabled,
  ).toBe(true);
  expect(oldReads).toBe(2);
});

it("clears pending readiness from an old mailbox before its read finishes", async () => {
  const pending = deferred<View>();
  const next = "33333333-3333-4333-8333-333333333333";
  const ports: CrmCapabilityPorts = {
    read: async (input) =>
      input.mailboxId === ID
        ? input.capability === "metadata_review"
          ? pending.promise
          : unavailable(input.capability)
        : { ...unavailable(input.capability), mailboxId: next },
    activate: async () => {
      throw new Error("unexpected activate");
    },
    disable: async () => {
      throw new Error("unexpected disable");
    },
  };
  const view = render(
    <CrmCapabilitiesSection
      scope="mail"
      available
      privacyKey="owner:1"
      mailboxId={ID}
      ports={ports}
    />,
  );
  view.rerender(
    <CrmCapabilitiesSection
      scope="mail"
      available
      privacyKey="next:2"
      mailboxId={next}
      ports={ports}
    />,
  );
  await screen.findAllByText(
    "Not prepared. Independent review is required before activation.",
  );
  await act(async () => pending.resolve(metadata()));
  expect(screen.queryByText("Ready to activate.")).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Activate metadata review",
    }).disabled,
  ).toBe(true);
});
it("fails closed with a plain message when the desktop read bridge is unavailable", async () => {
  const ports: CrmCapabilityPorts = {
    read: () => {
      throw new Error("private raw bridge failure");
    },
    activate: async () => {
      throw new Error("unexpected activate");
    },
    disable: async () => {
      throw new Error("unexpected disable");
    },
  };
  render(
    <CrmCapabilitiesSection
      scope="ai"
      available
      privacyKey="owner:1"
      ports={ports}
    />,
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("private raw bridge failure")).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Activate evidence extraction",
    }).disabled,
  ).toBe(true);
});
