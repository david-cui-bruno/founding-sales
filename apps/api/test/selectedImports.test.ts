import { reassignFirm } from "@fss/domain/crm/firms.ts";
import {
  repositoryContext,
  workspaceScope,
} from "@fss/domain/db/workspaceScope.ts";
import { withTransaction } from "@fss/domain/db/queryable.ts";
import { seedContact } from "./support/crmSeed.ts";
import { seedFirm } from "./support/crmSeed.ts";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
  type AuthFixture,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
describe("selected conversation imports", () => {
  let fixture: AuthFixture;
  let token: string;
  const post = async (path: string, body: unknown, bearer = token) =>
    dispatch(
      {
        method: "POST",
        path,
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${bearer}` },
        body,
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
  beforeAll(async () => {
    fixture = await createAuthFixture();
    token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
  });
  afterAll(async () => fixture.stop());
  it("previews unknown attribution and date, imports a selected passage and replays without duplicate effects", async () => {
    const created = await post(
      "/crm/people/create",
      command({ fullName: "Morgan Lee" }),
    );
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    const selection = {
      text: "We coordinate repairs manually.",
      subtype: "pasted_text",
      label: "Selected Messages passage",
      direction: "outgoing",
      participants: [],
      occurredAt: null,
      attachments: [],
    };
    const preview = await post("/crm/imports/preview", selection);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      occurredAt: null,
      dateProvenance: "unknown",
      direction: "outgoing",
      directionVerified: false,
      attribution: "unknown",
      participants: [],
    });
    const input = command({
      ...selection,
      personId,
      firmId: null,
      importKey: "selected-first",
      previewHash: (preview.body as { previewHash: string }).previewHash,
      parserVersion: "selected-v1",
    });
    const committed = await post("/crm/imports/commit", input);
    expect(committed.status).toBe(200);
    const sourceId = (committed.body as { result: { sourceId: string } }).result
      .sourceId;
    expect((await post("/crm/imports/commit", input)).body).toMatchObject({
      result: { sourceId },
    });
    expect(
      (await post("/crm/imports/commit", { ...input, commandId: randomUUID() }))
        .body,
    ).toMatchObject({ result: { sourceId } });
    const read = await post("/crm/imports/read", { personId });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      imports: [
        {
          source: {
            sourceId,
            kind: "selected_note",
            excerpt: selection.text,
            occurredAt: null,
          },
          metadata: {
            label: selection.label,
            direction: "outgoing",
            directionVerified: false,
            dateProvenance: "unknown",
            attribution: "unknown",
          },
        },
      ],
    });
    expect((read.body as { imports: unknown[] }).imports).toHaveLength(1);
  });
  it("corrects exact revisions and deletes participant/attachment metadata with the copied passage until explicit recapture", async () => {
    const personId = (
      (
        await post(
          "/crm/people/create",
          command({ fullName: "Import correction" }),
        )
      ).body as { result: { personId: string } }
    ).result.personId;
    const selection = {
      text: "Draft: private initial quotation",
      subtype: "transcript",
      label: "Private recording label",
      direction: "draft",
      participants: [
        {
          label: "Private speaker",
          endpoint: null,
          provenance: "user_supplied",
        },
      ],
      occurredAt: null,
      attachments: [
        {
          name: "Private filename",
          url: "https://example.test/private-attachment",
        },
      ],
    };
    const preview = await post("/crm/imports/preview", selection);
    const input = {
      ...selection,
      personId,
      firmId: null,
      importKey: "lifecycle",
      previewHash: (preview.body as { previewHash: string }).previewHash,
      parserVersion: "selected-v1",
    };
    const captured = await post("/crm/imports/commit", command(input));
    const sourceId = (captured.body as { result: { sourceId: string } }).result
      .sourceId;
    const corrected = {
      ...selection,
      text: "Corrected supported passage",
      occurredAt: "2026-09-20T14:00:00.000Z",
    };
    const nextPreview = await post("/crm/imports/preview", corrected);
    const correction = {
      ...corrected,
      sourceId,
      expectedSourceRevision: 1,
      expectedMetadataRevision: 1,
      previewHash: (nextPreview.body as { previewHash: string }).previewHash,
      parserVersion: "selected-v1",
    };
    expect(
      (await post("/crm/imports/correct", command(correction))).status,
    ).toBe(200);
    expect(
      (await post("/crm/imports/correct", command(correction))).status,
    ).toBe(409);
    expect((await post("/crm/imports/read", { personId })).body).toMatchObject({
      imports: [
        {
          source: {
            revision: 2,
            excerpt: corrected.text,
            occurredAt: corrected.occurredAt,
          },
          metadata: {
            revision: 2,
            direction: "draft",
            directionVerified: false,
            dateProvenance: "user_supplied",
          },
        },
      ],
    });
    expect(
      (
        await post(
          "/crm/imports/delete",
          command({
            sourceId,
            expectedSourceRevision: 2,
            expectedMetadataRevision: 2,
          }),
        )
      ).status,
    ).toBe(200);
    const deleted = await post("/crm/imports/read", { personId });
    expect(JSON.stringify(deleted.body)).not.toContain("Private");
    expect(deleted.body).toMatchObject({
      imports: [
        {
          source: { availability: "deleted", excerpt: null },
          metadata: {
            revision: 3,
            label: null,
            participants: null,
            attachments: null,
            direction: null,
          },
        },
      ],
    });
    expect((await post("/crm/imports/commit", command(input))).status).toBe(
      409,
    );
    expect(
      (
        await post(
          "/crm/imports/restore",
          command({
            sourceId,
            expectedSourceRevision: 3,
            expectedMetadataRevision: 3,
          }),
        )
      ).status,
    ).toBe(200);
    expect((await post("/crm/imports/read", { personId })).body).toMatchObject({
      imports: [
        {
          source: { availability: "awaiting_recapture", excerpt: null },
          metadata: { label: null },
        },
      ],
    });
    expect((await post("/crm/imports/commit", command(input))).status).toBe(
      409,
    );
    expect(
      (
        await post(
          "/crm/imports/recapture",
          command({
            ...correction,
            expectedSourceRevision: 4,
            expectedMetadataRevision: 3,
          }),
        )
      ).status,
    ).toBe(200);
    expect((await post("/crm/imports/read", { personId })).body).toMatchObject({
      imports: [
        {
          source: { revision: 5, excerpt: corrected.text },
          metadata: { revision: 4, label: selection.label },
        },
      ],
    });
  });

  it("preserves invalid or ambiguous original dates as unknown and refuses oversize or altered previews", async () => {
    const selection = {
      text: "Date: 2026-02-30T12:00:00Z\nAlex: I drafted this.",
      subtype: "selected_file",
      label: "Selected transcript.txt",
      direction: "draft",
      participants: [],
      occurredAt: null,
      attachments: [{ name: "Notes.pdf", url: null }],
    };
    const preview = await post("/crm/imports/preview", selection);
    expect(preview.body).toMatchObject({
      occurredAt: null,
      dateProvenance: "unknown",
      directionVerified: false,
      attribution: "unknown",
    });
    expect(
      (
        await post("/crm/imports/preview", {
          ...selection,
          text: "x".repeat(20001),
        })
      ).status,
    ).toBe(400);
    const personId = (
      (await post("/crm/people/create", command({ fullName: "Date unknown" })))
        .body as { result: { personId: string } }
    ).result.personId;
    expect(
      (
        await post(
          "/crm/imports/commit",
          command({
            ...selection,
            text: "Altered draft",
            personId,
            importKey: "altered",
            parserVersion: "selected-v1",
            previewHash: (preview.body as { previewHash: string }).previewHash,
          }),
        )
      ).status,
    ).toBe(409);
    expect((await post("/crm/imports/read", { personId })).body).toMatchObject({
      imports: [],
    });
  });

  it("preserves explicit parsed provenance and owner/workspace access for firm imports and deletion through ordinary source commands", async () => {
    const firmId = await seedFirm(fixture, {
      name: "Import firm",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const selection = {
      text: "Date: 2026-09-20T14:00:00Z\nFrom: morgan@example.test\nSelected firm conversation",
      subtype: "selected_file",
      label: "Selected transcript.txt",
      direction: "incoming",
      participants: [],
      occurredAt: null,
      attachments: [
        { name: "Reference.pdf", url: "https://example.test/reference" },
      ],
    };
    const preview = await post("/crm/imports/preview", selection);
    expect(preview.body).toMatchObject({
      occurredAt: "2026-09-20T14:00:00.000Z",
      dateProvenance: "parsed",
      participants: [{ endpoint: "morgan@example.test", provenance: "parsed" }],
      candidates: [
        { outcome: "no_supported_match", personId: null, firmId: null },
      ],
    });
    const created = await post(
      "/crm/imports/commit",
      command({
        ...selection,
        firmId,
        importKey: "firm-file",
        previewHash: (preview.body as { previewHash: string }).previewHash,
        parserVersion: "selected-v1",
      }),
    );
    const sourceId = (created.body as { result: { sourceId: string } }).result
      .sourceId;
    const beta = (
      await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)
    ).accessToken;
    expect((await post("/crm/imports/read", { firmId }, beta)).status).toBe(
      404,
    );
    expect(
      (
        await post(
          "/crm/imports/delete",
          command({
            sourceId,
            expectedSourceRevision: 1,
            expectedMetadataRevision: 1,
          }),
          beta,
        )
      ).status,
    ).toBe(409);
    expect((await post("/crm/imports/read", { firmId })).body).toMatchObject({
      imports: [
        {
          metadata: {
            label: selection.label,
            attachments: selection.attachments,
            directionVerified: false,
          },
        },
      ],
    });
    expect(
      (
        await post(
          "/crm/firm-sources/delete",
          command({ firmId, sourceId, expectedRevision: 1 }),
        )
      ).status,
    ).toBe(200);
    const removed = await post("/crm/imports/read", { firmId });
    expect(JSON.stringify(removed.body)).not.toContain("morgan@example.test");
    expect(JSON.stringify(removed.body)).not.toContain("Reference.pdf");
    expect(removed.body).toMatchObject({
      imports: [
        { metadata: { label: null, participants: null, attachments: null } },
      ],
    });
  });

  it("keeps conflicting parsed dates unknown and refuses text that cannot be stored intact", async () => {
    const selection = {
      text: "Date: 2026-09-20T14:00:00Z\nDate: 2026-09-21T14:00:00Z\nTwo quoted messages",
      subtype: "transcript",
      label: "Selected messages",
      direction: "unknown",
    };
    expect((await post("/crm/imports/preview", selection)).body).toMatchObject({
      occurredAt: null,
      dateProvenance: "unknown",
    });
    expect(
      (
        await post("/crm/imports/preview", {
          ...selection,
          text: "before\0after",
        })
      ).status,
    ).toBe(400);
  });

  it("proposes an existing supported phone identity without automatically associating or creating records", async () => {
    const personId = (
      (
        await post(
          "/crm/people/create",
          command({ fullName: "Phone correspondent" }),
        )
      ).body as { result: { personId: string } }
    ).result.personId;
    await post(
      "/crm/people/source/add",
      command({
        personId,
        sourceKey: "phone-proof",
        excerpt: "My business number is +18175550123.",
        occurredAt: "2026-09-20T14:00:00.000Z",
      }),
    );
    const source = (
      (await post("/crm/people/read", { personId })).body as {
        sources: { sourceId: string; revision: number; contentHash: string }[];
      }
    ).sources[0]!;
    expect(
      (
        await post(
          "/crm/endpoints/claim",
          command({
            personId,
            firmId: null,
            shared: false,
            kind: "phone",
            value: "+18175550123",
            status: "current",
            startDate: "2026-01-01",
            endDate: null,
            evidence: {
              sourceId: source.sourceId,
              sourceRevision: source.revision,
              contentHash: source.contentHash,
            },
          }),
        )
      ).status,
    ).toBe(200);
    const preview = await post("/crm/imports/preview", {
      text: "Selected message from this number",
      subtype: "pasted_text",
      label: "Selected text",
      direction: "incoming",
      participants: [
        {
          label: "Phone correspondent",
          endpoint: "+18175550123",
          provenance: "user_supplied",
        },
      ],
    });
    expect(preview.body).toMatchObject({
      candidates: [
        {
          endpoint: "+18175550123",
          outcome: "person_match",
          personId,
          firmId: null,
        },
      ],
      directionVerified: false,
    });
    expect((await post("/crm/imports/read", { personId })).body).toMatchObject({
      imports: [],
    });
  });

  it("refuses a new uncontextualized person import when only an unrelated permitted historical context keeps that person visible", async () => {
    const firmA = await seedFirm(fixture, {
      name: "Legacy A",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const firmB = await seedFirm(fixture, {
      name: "Permitted B",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const personId = await seedContact(fixture, {
      firmId: firmA,
      fullName: "Historical person",
    });
    await post("/crm/people/bridge", command({ contactIds: [personId] }));
    await post(
      "/crm/people/source/add",
      command({
        personId,
        sourceKey: "historical-b",
        excerpt: "We work with B now.",
        occurredAt: "2026-09-20T14:00:00.000Z",
      }),
    );
    const source = (
      (await post("/crm/people/read", { personId })).body as {
        sources: { sourceId: string; revision: number; contentHash: string }[];
      }
    ).sources[0]!;
    const evidence = {
      sourceId: source.sourceId,
      sourceRevision: source.revision,
      contentHash: source.contentHash,
    };
    const relation = await post(
      "/crm/relationships/save",
      command({
        personId,
        firmId: firmB,
        status: "current",
        startDate: null,
        endDate: null,
        evidence,
      }),
    );
    const relationshipId = (
      relation.body as { result: { relationshipId: string } }
    ).result.relationshipId;
    await post(
      "/crm/relationships/context/save",
      command({ personId, relationshipId, relationshipRevision: 1, evidence }),
    );
    await withTransaction(fixture.db, () =>
      reassignFirm(
        repositoryContext(
          workspaceScope(fixture.alpha.workspaceId, {
            kind: "user",
            userId: fixture.alpha.admin.userId,
            role: "admin",
          }),
          fixture.db,
        ),
        { firmId: firmA, toUserId: fixture.alpha.admin.userId },
      ),
    );
    expect((await post("/crm/people/read", { personId })).status).toBe(200);
    const selection = {
      text: "New context not explicitly selected",
      subtype: "pasted_text",
      label: "New source",
      direction: "unknown",
    };
    const preview = await post("/crm/imports/preview", selection);
    expect(
      (
        await post(
          "/crm/imports/commit",
          command({
            ...selection,
            personId,
            importKey: "unsafe-legacy-fallback",
            parserVersion: "selected-v1",
            previewHash: (preview.body as { previewHash: string }).previewHash,
          }),
        )
      ).status,
    ).toBe(409);
    expect((await post("/crm/imports/read", { personId })).body).toMatchObject({
      imports: [],
    });
  });
  it("refuses metadata that cannot fit the bounded retained representation before committing a source", async () => {
    const selection = {
      text: "Selected passage",
      subtype: "pasted_text",
      label: "Bounded metadata",
      direction: "unknown",
      participants: Array.from({ length: 20 }, (_, index) => ({
        label: `${index} ` + "界".repeat(230),
        endpoint: "界".repeat(310),
        provenance: "user_supplied",
      })),
    };
    expect((await post("/crm/imports/preview", selection)).status).toBe(400);
  });
});
