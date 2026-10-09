import { expect, it } from "vitest";
import { createAuthedClient } from "../src/main/authedClient.ts";
import {
  answerOperation,
  operationHandlers,
  type OperationHostDeps,
} from "../src/main/operationHost.ts";
import { operationOf, OPERATIONS } from "../src/shared/operations.ts";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const HASH = "a".repeat(64);
it("reads a bounded copied-email page through authenticated closed operations and rejects caller-selected paths", async () => {
  const page = {
    sources: [
      {
        sourceId: SOURCE,
        sourceRevision: 1,
        contentHash: HASH,
        availability: "available",
        occurredAt: "2026-10-09T12:00:00.000Z",
        completeness: "partial",
      },
    ],
    nextAfterId: null,
  };
  const requests: { path: string; method: string; body: unknown }[] = [];
  const api = createAuthedClient({
    baseUrl: "https://api.example.test",
    clientVersion: "1.0.49",
    accessToken: async () => ({ token: "fixture", generation: 0 }),
    send: async (url, init) => {
      requests.push({
        path: new URL(url).pathname,
        method: init.method,
        body: JSON.parse(init.body ?? "{}"),
      });
      return { status: 200, body: page };
    },
  });
  const handlers = operationHandlers({
    api,
    recordings: { identity: { current: () => 0 } },
  } as unknown as OperationHostDeps);
  expect(operationOf("crm.businessMailList")).toBe("crm.businessMailList");
  expect(
    await answerOperation(handlers, "read", "crm.businessMailList", {
      firmId: SOURCE,
      limit: 50,
    }),
  ).toEqual(page);
  expect(requests).toEqual([
    {
      path: "/crm/business/mail/list",
      method: "POST",
      body: { firmId: SOURCE, limit: 50 },
    },
  ]);
  await expect(
    answerOperation(handlers, "read", "crm.businessMailList", {
      path: "/send",
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(1);
  const name = operationOf("crm.businessMailList");
  expect(
    name === null
      ? null
      : OPERATIONS[name].output.safeParse({ ...page, token: "unexpected" })
          .success,
  ).toBe(false);
});
it("vetoes an exact copied-email read returned after the authenticated identity changes", async () => {
  let generation = 0;
  const requests: string[] = [];
  const api = createAuthedClient({
    baseUrl: "https://api.example.test",
    clientVersion: "1.0.49",
    accessToken: async () => ({ token: "fixture", generation: 0 }),
    send: async (url) => {
      requests.push(new URL(url).pathname);
      generation++;
      return {
        status: 200,
        body: { state: "unavailable", reason: "source_deleted", source: null },
      };
    },
  });
  const handlers = operationHandlers({
    api,
    recordings: { identity: { current: () => generation } },
  } as unknown as OperationHostDeps);
  await expect(
    answerOperation(handlers, "read", "crm.businessMailRead", {
      sourceId: SOURCE,
      sourceRevision: 1,
      contentHash: HASH,
    }),
  ).rejects.toThrow("identity_changed");
  expect(requests).toEqual(["/crm/business/mail/read"]);
});
it("deletes only a versioned copied source while the main process owns the command envelope", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const api = createAuthedClient({
    baseUrl: "https://api.example.test",
    clientVersion: "1.0.49",
    accessToken: async () => ({ token: "fixture", generation: 0 }),
    send: async (url, init) => {
      requests.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body ?? "{}"),
      });
      return {
        status: 200,
        body: {
          status: "accepted",
          replayed: false,
          result: {
            sourceId: SOURCE,
            sourceRevision: 2,
            availability: "deleted",
          },
        },
      };
    },
  });
  const handlers = operationHandlers({
    api,
    recordings: { identity: { current: () => 0 } },
  } as unknown as OperationHostDeps);
  expect(
    await answerOperation(handlers, "command", "crm.businessMailDelete", {
      sourceId: SOURCE,
      expectedRevision: 1,
    }),
  ).toEqual({ sourceId: SOURCE, sourceRevision: 2, availability: "deleted" });
  expect(requests[0]).toEqual({
    path: "/crm/business/mail/delete",
    body: {
      sourceId: SOURCE,
      expectedRevision: 1,
      commandId: expect.any(String),
      clientVersion: "1.0.49",
    },
  });
  await expect(
    answerOperation(handlers, "command", "crm.businessMailDelete", {
      sourceId: SOURCE,
      expectedRevision: 1,
      commandId: SOURCE,
      clientVersion: "1.0.0",
      passage: "private",
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(1);
});
it("reads capture-off controls and current copied-source availability without creating activation authority", async () => {
  const controls = {
    mailboxId: SOURCE,
    enabled: false,
    ready: false,
    reason: "activation_not_available",
    revision: 0,
  };
  const state = { revision: 3, availability: "awaiting_recapture" };
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
        body: path.endsWith("controls/read") ? controls : state,
      };
    },
  });
  const handlers = operationHandlers({
    api,
    recordings: { identity: { current: () => 0 } },
  } as unknown as OperationHostDeps);
  expect(
    await answerOperation(handlers, "read", "crm.businessMailControls", {
      mailboxId: SOURCE,
    }),
  ).toEqual(controls);
  expect(
    await answerOperation(handlers, "read", "crm.businessMailState", {
      sourceId: SOURCE,
    }),
  ).toEqual(state);
  expect(requests).toEqual([
    "/crm/business/mail/controls/read",
    "/crm/business/mail/state/read",
  ]);
  await expect(
    answerOperation(handlers, "read", "crm.businessMailControls", {
      mailboxId: SOURCE,
      enabled: true,
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(2);
});
it("vetoes a restoration receipt after an identity change instead of claiming restored content", async () => {
  let generation = 0;
  const requests: string[] = [];
  const api = createAuthedClient({
    baseUrl: "https://api.example.test",
    clientVersion: "1.0.49",
    accessToken: async () => ({ token: "fixture", generation: 0 }),
    send: async (url) => {
      requests.push(new URL(url).pathname);
      generation++;
      return {
        status: 200,
        body: {
          status: "accepted",
          replayed: false,
          result: {
            sourceId: SOURCE,
            sourceRevision: 3,
            availability: "awaiting_recapture",
          },
        },
      };
    },
  });
  const handlers = operationHandlers({
    api,
    recordings: { identity: { current: () => generation } },
  } as unknown as OperationHostDeps);
  await expect(
    answerOperation(handlers, "command", "crm.businessMailRestore", {
      sourceId: SOURCE,
      expectedRevision: 2,
    }),
  ).rejects.toThrow("identity_changed");
  expect(requests).toEqual(["/crm/business/mail/restore"]);
});
it("requests recapture through a separate versioned command and returns only a queued receipt", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const api = createAuthedClient({
    baseUrl: "https://api.example.test",
    clientVersion: "1.0.49",
    accessToken: async () => ({ token: "fixture", generation: 0 }),
    send: async (url, init) => {
      requests.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body ?? "{}"),
      });
      return {
        status: 200,
        body: {
          status: "accepted",
          replayed: false,
          result: { sourceId: SOURCE, sourceRevision: 3, status: "queued" },
        },
      };
    },
  });
  const handlers = operationHandlers({
    api,
    recordings: { identity: { current: () => 0 } },
  } as unknown as OperationHostDeps);
  expect(
    await answerOperation(handlers, "command", "crm.businessMailRecapture", {
      sourceId: SOURCE,
      expectedRevision: 3,
    }),
  ).toEqual({ sourceId: SOURCE, sourceRevision: 3, status: "queued" });
  expect(requests).toEqual([
    {
      path: "/crm/business/mail/recapture",
      body: {
        sourceId: SOURCE,
        expectedRevision: 3,
        commandId: expect.any(String),
        clientVersion: "1.0.49",
      },
    },
  ]);
});
it("records an explicit reviewed context without adding operational matching or opportunity fields", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const api = createAuthedClient({
    baseUrl: "https://api.example.test",
    clientVersion: "1.0.49",
    accessToken: async () => ({ token: "fixture", generation: 0 }),
    send: async (url, init) => {
      requests.push({
        path: new URL(url).pathname,
        body: JSON.parse(init.body ?? "{}"),
      });
      return {
        status: 200,
        body: {
          status: "accepted",
          replayed: false,
          result: { sourceId: SOURCE, sourceRevision: 2 },
        },
      };
    },
  });
  const handlers = operationHandlers({
    api,
    recordings: { identity: { current: () => 0 } },
  } as unknown as OperationHostDeps);
  expect(
    await answerOperation(handlers, "command", "crm.businessMailAssociate", {
      sourceId: SOURCE,
      expectedRevision: 1,
      personId: SOURCE,
    }),
  ).toEqual({ sourceId: SOURCE, sourceRevision: 2 });
  expect(requests).toEqual([
    {
      path: "/crm/business/mail/associate",
      body: {
        sourceId: SOURCE,
        expectedRevision: 1,
        personId: SOURCE,
        commandId: expect.any(String),
        clientVersion: "1.0.49",
      },
    },
  ]);
  await expect(
    answerOperation(handlers, "command", "crm.businessMailAssociate", {
      sourceId: SOURCE,
      expectedRevision: 1,
    }),
  ).rejects.toThrow();
  await expect(
    answerOperation(handlers, "command", "crm.businessMailAssociate", {
      sourceId: SOURCE,
      expectedRevision: 1,
      firmId: SOURCE,
      opportunityId: SOURCE,
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(1);
});
