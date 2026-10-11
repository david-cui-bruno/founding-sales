import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
import { seedFirm } from "./support/crmSeed.ts";
it("resolves permitted named records before pagination and reads source-free global exact state with dates", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (body: unknown, path = "/ask/read") =>
      dispatch(
        {
          method: "POST",
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    await seedFirm(fixture, {
      name: "Unrelated first",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const allowed = await seedFirm(fixture, {
      name: "Named source-free company",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const forbidden = await seedFirm(fixture, {
      name: "Named forbidden company",
      assignedUserId: fixture.alpha.admin.userId,
    });
    const match = await post({
      operation: "records",
      query: "Named",
      kind: "firms",
      limit: 1,
    });
    expect(match.status).toBe(200);
    expect(match.body).toMatchObject({
      selection: "single",
      records: [{ recordId: allowed }],
      scanComplete: true,
    });
    const opened = await post(
      {
        commandId: randomUUID(),
        clientVersion: CURRENT_CLIENT_VERSION,
        firmId: allowed,
        name: "Visible opportunity",
        stageKey: "new",
      },
      "/opportunities/v2/open",
    );
    expect(opened.status).toBe(200);
    const adminToken = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const privateOpportunity = await dispatch(
      {
        method: "POST",
        path: "/opportunities/v2/open",
        body: {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          firmId: forbidden,
          name: "Private opportunity",
          stageKey: "new",
        },
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${adminToken}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(privateOpportunity.status).toBe(200);
    const all = await post({
      operation: "opportunities",
      scope: { business: true },
      status: "open",
      limit: 20,
    });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({
      count: "1",
      records: [{ firmId: allowed }],
    });
    const dated = await post({
      operation: "opportunities",
      scope: { business: true, to: "2000-01-01T00:00:00Z" },
      status: "open",
      limit: 20,
    });
    expect(dated.status).toBe(200);
    expect(dated.body).toMatchObject({ count: "0", records: [] });
    for (const operation of ["tasks", "reply_status"]) {
      const result = await post({ operation, scope: { business: true } });
      expect(result.status).toBe(200);
    }
  } finally {
    await fixture.stop();
  }
});
it("keeps matching people distinct, reports no match, and filters scoped firm identities before page limits", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (body: unknown, path = "/ask/read") =>
      dispatch(
        {
          method: "POST",
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const ids: string[] = [];
    for (const fullName of ["Unrelated person", "Alex Lee", "Alex Lee"]) {
      const created = await post(
        {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          fullName,
        },
        "/crm/people/create",
      );
      expect(created.status).toBe(200);
      if (fullName === "Alex Lee")
        ids.push(
          (created.body as { result: { personId: string } }).result.personId,
        );
    }
    const result = await post({
      operation: "records",
      query: "Alex",
      kind: "people",
      limit: 20,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      selection: "ambiguous",
      records: expect.arrayContaining(
        ids.map((recordId) =>
          expect.objectContaining({ recordId, relationships: [] }),
        ),
      ),
      scanComplete: true,
    });
    const first = await post({
      operation: "records",
      query: "Alex",
      kind: "people",
      limit: 1,
    });
    expect(first.body).toMatchObject({
      selection: "unresolved",
      records: [expect.objectContaining({ name: "Alex Lee" })],
      scanComplete: false,
    });
    const missing = await post({
      operation: "records",
      query: "Missing person",
      kind: "people",
      limit: 1,
    });
    expect(missing.body).toMatchObject({
      selection: "none",
      records: [],
      scanComplete: true,
    });
    const firmA = await seedFirm(fixture, {
      name: "Allowed A",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const firmB = await seedFirm(fixture, {
      name: "Allowed B",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const scoped = await post({
      operation: "records",
      kind: "firms",
      scope: { firmId: firmA },
      limit: 1,
    });
    expect(scoped.status).toBe(200);
    expect(scoped.body).toMatchObject({
      selection: "single",
      records: [{ recordId: firmA }],
    });
    expect(JSON.stringify(scoped.body)).not.toContain(firmB);
  } finally {
    await fixture.stop();
  }
});
it("displays distinct historical relationship versions without selecting or merging a person into a firm", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (body: unknown, path = "/ask/read") =>
      dispatch(
        {
          method: "POST",
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const command = (body: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...body,
    });
    const created = await post(
      command({ fullName: "Historical Alex" }),
      "/crm/people/create",
    );
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    const imported = {
      text: "Alex worked at Old Company until September and moved to New Company.",
      subtype: "pasted_text",
      label: "Historical relationship evidence",
      direction: "unknown",
      occurredAt: "2026-10-01T12:00:00Z",
      participants: [],
      attachments: [],
    };
    const preview = await post(imported, "/crm/imports/preview");
    const previewHash = (preview.body as { previewHash: string }).previewHash;
    const committed = await post(
      command({
        ...imported,
        personId,
        firmId: null,
        importKey: "history-relationship",
        previewHash,
        parserVersion: "selected-v1",
      }),
      "/crm/imports/commit",
    );
    expect(committed.status).toBe(200);
    const read = await post({ personId }, "/crm/people/read");
    const source = (
      read.body as {
        sources: { sourceId: string; revision: number; contentHash: string }[];
      }
    ).sources[0]!;
    const oldFirm = await seedFirm(fixture, {
      name: "Old Company",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const newFirm = await seedFirm(fixture, {
      name: "New Company",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    for (const [firmId, status, startDate, endDate] of [
      [oldFirm, "historical", "2020-01-01", "2026-09-30"],
      [newFirm, "current", "2026-10-01", null],
    ]) {
      const saved = await post(
        command({
          personId,
          firmId,
          status,
          startDate,
          endDate,
          evidence: {
            sourceId: source.sourceId,
            sourceRevision: source.revision,
            contentHash: source.contentHash,
          },
        }),
        "/crm/relationships/save",
      );
      expect(saved.status).toBe(200);
    }
    const result = await post({
      operation: "records",
      kind: "people",
      query: "Historical Alex",
      limit: 20,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      selection: "single",
      records: [
        {
          recordId: personId,
          firmId: null,
          relationships: expect.arrayContaining([
            expect.objectContaining({
              firmId: oldFirm,
              status: "historical",
              startDate: "2020-01-01",
              endDate: "2026-09-30",
              revision: 1,
            }),
            expect.objectContaining({
              firmId: newFirm,
              status: "current",
              startDate: "2026-10-01",
              endDate: null,
              revision: 1,
            }),
          ]),
          relationshipsComplete: true,
        },
      ],
    });
    const scoped = await post({
      operation: "records",
      kind: "people",
      scope: { firmId: oldFirm },
      query: "Historical Alex",
      limit: 20,
    });
    expect(scoped.status).toBe(200);
    expect(JSON.stringify(scoped.body)).not.toContain(newFirm);
  } finally {
    await fixture.stop();
  }
});
