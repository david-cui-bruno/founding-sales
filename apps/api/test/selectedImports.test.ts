import { reassignFirm } from "@fss/domain/crm/firms.ts";
import {
  repositoryContext,
  workspaceScope,
} from "@fss/domain/db/workspaceScope.ts";
import { withTransaction } from "@fss/domain/db/queryable.ts";
import { seedContact } from "./support/crmSeed.ts";
import { seedFirm } from "./support/crmSeed.ts";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
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
  it("refuses concurrent cross-person replay without deadlocking or changing either imported copy", async () => {
    const firstFirm = await seedFirm(fixture, {
      name: "First replay firm",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const secondFirm = await seedFirm(fixture, {
      name: "Second replay firm",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const firstPerson = await seedContact(fixture, {
      firmId: firstFirm, fullName: "First replay person",
    });
    const secondPerson = await seedContact(fixture, {
      firmId: secondFirm, fullName: "Second replay person",
    });
    const bridged = await post("/crm/people/bridge", command({
      contactIds: [firstPerson, secondPerson],
    }));
    expect(bridged.status).toBe(200);
    const selection = {
      text: "Original selected passage remains with its person.",
      subtype: "pasted_text", label: "Replay source", direction: "unknown",
      participants: [], occurredAt: null, attachments: [],
    };
    const preview = await post("/crm/imports/preview", selection);
    const firstKey = randomUUID(), secondKey = randomUUID();
    const input = (personId: string, importKey: string) => command({
      ...selection, personId, firmId: null, importKey,
      previewHash: (preview.body as { previewHash: string }).previewHash,
      parserVersion: "selected-v1",
    });
    const first = await post("/crm/imports/commit", input(firstPerson, firstKey));
    const second = await post("/crm/imports/commit", input(secondPerson, secondKey));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (await holder.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    )).rows[0]?.pid;
    await holder.query("BEGIN");
    // A real database barrier releases both replay requests together. Outcomes are
    // verified only through authenticated commands and reads, never table assertions.
    for (const key of [firstKey, secondKey]) {
      const keyHash = createHash("sha256").update(key).digest("hex");
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${fixture.alpha.workspaceId}:${fixture.alpha.salesperson.userId}:import:${keyHash}`],
      );
    }
    const firstSession = await fixture.database.appRuntimeSession();
    const secondSession = await fixture.database.appRuntimeSession();
    const replayOn = (session: typeof firstSession, body: object) => dispatch({
      method: "POST", path: "/crm/imports/commit", query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` }, body,
    }, {
      session, auth: { ...fixture.deps, db: session },
      supportedClientVersions: fixture.deps.config.supportedClientVersions,
      sendingEnabled: false,
    });
    const pending = Promise.allSettled([
      replayOn(firstSession, input(secondPerson, firstKey)),
      replayOn(secondSession, input(firstPerson, secondKey)),
    ]);
    try {
      let reached = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = (await observer.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
          [pid],
        )).rows;
        if ((rows[0]?.waiting ?? 0) >= 2) { reached = true; break; }
        await delay(5);
      }
      if (!reached) throw new Error("Both replay commands did not reach the database barrier");
    } finally {
      await holder.query("COMMIT");
    }
    for (const result of await pending) {
      expect(result.status, result.status === "rejected"
        ? String(result.reason) : "Both commands return a clean refusal").toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value.status).toBe(409);
      expect(result.value.body).toMatchObject({ reason: "import_identity_conflict" });
    }
    for (const [personId, committed] of [[firstPerson, first], [secondPerson, second]] as const) {
      const sourceId = (committed.body as { result: { sourceId: string } }).result.sourceId;
      const read = await post("/crm/imports/read", { personId });
      expect(read.body).toMatchObject({
        imports: [{ source: { sourceId, excerpt: selection.text, revision: 1 } }],
      });
    }
  });
  it("corrects crossing participant excerpts concurrently without deadlocking", async () => {
    const prepared = [];
    for (const label of ["First", "Second"]) {
      const firmId = await seedFirm(fixture, {
        name: `${label} correction firm`,
        assignedUserId: fixture.alpha.salesperson.userId,
      });
      const personId = await seedContact(fixture, {
        firmId,
        fullName: `${label} correction person`,
      });
      await post("/crm/people/bridge", command({ contactIds: [personId] }));
      const selection = {
        text: `${label} original excerpt`,
        subtype: "pasted_text",
        label: `${label} import`,
        direction: "unknown",
        participants: [],
        occurredAt: null,
        attachments: [],
      };
      const preview = await post("/crm/imports/preview", selection);
      const committed = await post(
        "/crm/imports/commit",
        command({
          ...selection,
          personId,
          importKey: randomUUID(),
          previewHash: (preview.body as { previewHash: string }).previewHash,
          parserVersion: "selected-v1",
        }),
      );
      expect(committed.status).toBe(200);
      const source = (await post("/crm/imports/read", { personId })).body as {
        imports: { source: { sourceId: string; contentHash: string } }[];
      };
      const evidence = {
        sourceId: source.imports[0]!.source.sourceId,
        sourceRevision: 1,
        contentHash: source.imports[0]!.source.contentHash,
      };
      const endpoint = `${label.toLowerCase()}@correction.example.test`;
      expect(
        (
          await post(
            "/crm/endpoints/claim",
            command({
              personId,
              firmId: null,
              shared: false,
              kind: "email",
              value: endpoint,
              status: "current",
              startDate: "2026-01-01",
              endDate: null,
              evidence,
            }),
          )
        ).status,
      ).toBe(200);
      prepared.push({ personId, selection, evidence, endpoint });
    }
    const corrections = [];
    for (const [index, item] of prepared.entries()) {
      const selection = {
        ...item.selection,
        text: `${item.selection.text} corrected`,
        participants: [
          {
            label: "Other participant",
            endpoint: prepared[1 - index]!.endpoint,
            provenance: "user_supplied",
          },
        ],
      };
      const preview = await post("/crm/imports/preview", selection);
      expect(preview.status).toBe(200);
      corrections.push(
        command({
          ...selection,
          sourceId: item.evidence.sourceId,
          expectedSourceRevision: 1,
          expectedMetadataRevision: 1,
          previewHash: (preview.body as { previewHash: string }).previewHash,
          parserVersion: "selected-v1",
        }),
      );
    }
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    const pid = (
      await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid;
    await holder.query("BEGIN");
    await holder.query(
      "SELECT source_id FROM crm_selected_imports WHERE workspace_id=$1 AND source_id=ANY($2::uuid[]) ORDER BY source_id FOR UPDATE",
      [
        fixture.alpha.workspaceId,
        prepared.map((item) => item.evidence.sourceId),
      ],
    );
    const sessions = await Promise.all([
      fixture.database.appRuntimeSession(),
      fixture.database.appRuntimeSession(),
    ]);
    const pending = Promise.allSettled(
      corrections.map((body, index) =>
        dispatch(
          {
            method: "POST",
            path: "/crm/imports/correct",
            query: new URLSearchParams(),
            headers: { authorization: `Bearer ${token}` },
            body,
          },
          {
            session: sessions[index]!,
            auth: { ...fixture.deps, db: sessions[index]! },
            supportedClientVersions:
              fixture.deps.config.supportedClientVersions,
            sendingEnabled: false,
          },
        ),
      ),
    );
    try {
      let reached = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = (
          await observer.query<{ waiting: number }>(
            "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
            [pid],
          )
        ).rows;
        if ((rows[0]?.waiting ?? 0) >= 2) {
          reached = true;
          break;
        }
        await delay(5);
      }
      if (!reached)
        throw new Error("Both corrections did not reach the database barrier");
    } finally {
      await holder.query("COMMIT");
    }
    for (const result of await pending) {
      expect(
        result.status,
        result.status === "rejected"
          ? String(result.reason)
          : "Clean correction result",
      ).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value.status).toBe(200);
    }
    for (const item of prepared) {
      expect(
        (await post("/crm/imports/read", { personId: item.personId })).body,
      ).toMatchObject({
        imports: [
          {
            source: {
              sourceId: item.evidence.sourceId,
              revision: 2,
              excerpt: `${item.selection.text} corrected`,
            },
          },
        ],
      });
    }
  });
  it("previews reversed participant orders concurrently without deadlocking or losing supported identities", async () => {
    const prepared = [];
    for (const label of ["First", "Second"]) {
      const firmId = await seedFirm(fixture, {
        name: `${label} preview firm`,
        assignedUserId: fixture.alpha.salesperson.userId,
      });
      const personId = await seedContact(fixture, {
        firmId,
        fullName: `${label} preview person`,
      });
      await post("/crm/people/bridge", command({ contactIds: [personId] }));
      await post(
        "/crm/people/source/add",
        command({
          personId,
          sourceKey: randomUUID(),
          excerpt: `${label} identity evidence`,
          occurredAt: "2026-09-15T14:00:00.000Z",
        }),
      );
      const page = (await post("/crm/people/read", { personId })).body as {
        sources: { sourceId: string; revision: number; contentHash: string }[];
      };
      const source = page.sources[0]!;
      const endpoint = `${label.toLowerCase()}@preview.example.test`;
      expect(
        (
          await post(
            "/crm/endpoints/claim",
            command({
              personId,
              firmId: null,
              shared: false,
              kind: "email",
              value: endpoint,
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
      prepared.push({ personId, sourceId: source.sourceId, endpoint });
    }
    const holder = await fixture.database.appRuntimeSession();
    const observer = await fixture.database.appRuntimeSession();
    await holder.query("BEGIN");
    await holder.query(
      "SELECT id FROM crm_selected_sources WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE",
      [fixture.alpha.workspaceId, prepared.map((item) => item.sourceId)],
    );
    const sessions = await Promise.all([
      fixture.database.appRuntimeSession(),
      fixture.database.appRuntimeSession(),
    ]);
    const pids = await Promise.all(
      sessions.map(
        async (session) =>
          (
            await session.query<{ pid: number }>(
              "SELECT pg_backend_pid() AS pid",
            )
          ).rows[0]!.pid,
      ),
    );
    const orders = [prepared, [...prepared].reverse()];
    const pending = Promise.allSettled(
      orders.map((order, index) =>
        dispatch(
          {
            method: "POST",
            path: "/crm/imports/preview",
            query: new URLSearchParams(),
            headers: { authorization: `Bearer ${token}` },
            body: {
              text: "Selected conversation between two supported people",
              subtype: "pasted_text",
              label: "Two participant preview",
              direction: "unknown",
              occurredAt: null,
              attachments: [],
              participants: order.map((item) => ({
                label: "Participant",
                endpoint: item.endpoint,
                provenance: "user_supplied",
              })),
            },
          },
          {
            session: sessions[index]!,
            auth: { ...fixture.deps, db: sessions[index]! },
            supportedClientVersions:
              fixture.deps.config.supportedClientVersions,
            sendingEnabled: false,
          },
        ),
      ),
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      let reached = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const rows = (
          await observer.query<{ waiting: number }>(
            "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND cardinality(pg_blocking_pids(pid))>0",
            [pids],
          )
        ).rows;
        if ((rows[0]?.waiting ?? 0) >= 2 || settled) {
          reached = true;
          break;
        }
        await delay(5);
      }
      if (!reached)
        throw new Error(
          "Previews neither settled nor reached a real database barrier",
        );
    } finally {
      await holder.query("COMMIT");
    }
    for (const [index, result] of (await pending).entries()) {
      expect(
        result.status,
        result.status === "rejected"
          ? String(result.reason)
          : "Clean preview result",
      ).toBe("fulfilled");
      if (result.status !== "fulfilled") throw result.reason;
      expect(result.value.status).toBe(200);
      expect(result.value.body).toMatchObject({
        candidates: orders[index]!.map((item) => ({
          endpoint: item.endpoint,
          outcome: "person_match",
          personId: item.personId,
          firmId: null,
        })),
      });
    }
  });
  it("refuses administrator private-evidence candidates when their audit cannot be recorded", async () => {
    const adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    const created = await post("/crm/people/create", command({ fullName: "Audited private identity" }));
    const personId = (created.body as { result: { personId: string } }).result.personId;
    expect((await post("/crm/people/source/add", command({
      personId, sourceKey: randomUUID(), excerpt: "Owner's selected identity proof",
      occurredAt: "2026-09-15T14:00:00.000Z",
    }))).status).toBe(200);
    const page = (await post("/crm/people/read", { personId })).body as {
      sources: { sourceId: string; revision: number; contentHash: string }[];
    };
    const source = page.sources[0]!;
    const endpoint = "audit-required@preview.example.test";
    expect((await post("/crm/endpoints/claim", command({
      personId, firmId: null, shared: false, kind: "email", value: endpoint,
      status: "current", startDate: "2026-01-01", endDate: null,
      evidence: { sourceId: source.sourceId, sourceRevision: source.revision, contentHash: source.contentHash },
    }))).status).toBe(200);
    const input = {
      text: "Selected passage", subtype: "pasted_text", label: "Audited preview",
      direction: "unknown", occurredAt: null, attachments: [],
      participants: [{ label: "Participant", endpoint, provenance: "user_supplied" }],
    };
    const availableAdminPreview = await post("/crm/imports/preview", input, adminToken);
    expect(availableAdminPreview.status).toBe(200);
    expect(availableAdminPreview.body).toMatchObject({ candidates: [{ outcome: "person_match", personId }] });
    // Failure injection controls the audit sink; all outcomes use authenticated reads.
    await fixture.database.session.query(`CREATE FUNCTION refuse_private_endpoint_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'crm.endpoint_private_evidence_read' THEN
        RAISE EXCEPTION 'fixture_private_audit_unavailable'; END IF; RETURN NEW; END $$`);
    await fixture.database.session.query(`CREATE TRIGGER refuse_private_endpoint_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION refuse_private_endpoint_audit()`);
    try {
      await expect(post("/crm/imports/preview", input, adminToken)).rejects.toThrow("fixture_private_audit_unavailable");
      const ownerPreview = await post("/crm/imports/preview", input);
      expect(ownerPreview.status).toBe(200);
      expect(ownerPreview.body).toMatchObject({ candidates: [{ outcome: "person_match", personId }] });
      expect((await post("/crm/people/read", { personId })).body).toMatchObject({
        sources: [{ sourceId: source.sourceId, availability: "available" }],
      });
      // Model an older retained claim whose evidence version is no longer current.
      await fixture.database.session.query(
        "UPDATE crm_selected_sources SET revision=revision+1 WHERE workspace_id=$1 AND id=$2",
        [fixture.alpha.workspaceId, source.sourceId],
      );
      await expect(post("/crm/endpoints/list", { personId }, adminToken)).rejects.toThrow("fixture_private_audit_unavailable");
      const ownerEndpoints = await post("/crm/endpoints/list", { personId });
      expect(ownerEndpoints.status).toBe(200);
      expect(ownerEndpoints.body).toMatchObject({
        claims: [{ personId, value: endpoint, sourceState: "unavailable" }],
      });
    } finally {
      await fixture.database.session.query("DROP TRIGGER refuse_private_endpoint_audit ON audit_events");
      await fixture.database.session.query("DROP FUNCTION refuse_private_endpoint_audit()");
    }
    const adminPreview = await post("/crm/imports/preview", input, adminToken);
    expect(adminPreview.status).toBe(200);
    expect(adminPreview.body).toMatchObject({ candidates: [{ outcome: "needs_review", personId: null }] });
    expect((await post("/crm/endpoints/list", { personId }, adminToken)).body).toMatchObject({
      claims: [{ personId, value: endpoint, sourceState: "unavailable" }],
    });
  });
  it("preserves supported public-preview candidates when another participant has private evidence", async () => {
    const adminToken = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const people = [];
    for (const [label, bearer] of [
      ["Allowed", token],
      ["Private", adminToken],
    ]) {
      const created = await post(
        "/crm/people/create",
        command({ fullName: `${label} preview identity` }),
        bearer,
      );
      const personId = (created.body as { result: { personId: string } }).result
        .personId;
      await post(
        "/crm/people/source/add",
        command({
          personId,
          sourceKey: randomUUID(),
          excerpt: `${label} identity proof`,
          occurredAt: "2026-09-15T14:00:00.000Z",
        }),
        bearer,
      );
      const page = (await post("/crm/people/read", { personId }, bearer))
        .body as {
        sources: { sourceId: string; revision: number; contentHash: string }[];
      };
      const source = page.sources[0]!;
      const endpoint = `${label!.toLowerCase()}@mixed-preview.example.test`;
      expect(
        (
          await post(
            "/crm/endpoints/claim",
            command({
              personId,
              firmId: null,
              shared: false,
              kind: "email",
              value: endpoint,
              status: "current",
              startDate: "2026-01-01",
              endDate: null,
              evidence: {
                sourceId: source.sourceId,
                sourceRevision: source.revision,
                contentHash: source.contentHash,
              },
            }),
            bearer,
          )
        ).status,
      ).toBe(200);
      people.push({ personId, endpoint });
    }
    const preview = await post("/crm/imports/preview", {
      text: "Selected two-person excerpt",
      subtype: "pasted_text",
      label: "Mixed access",
      direction: "unknown",
      occurredAt: null,
      attachments: [],
      participants: people.map((item) => ({
        label: "Participant",
        endpoint: item.endpoint,
        provenance: "user_supplied",
      })),
    });
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      candidates: [
        {
          endpoint: people[0]!.endpoint,
          outcome: "person_match",
          personId: people[0]!.personId,
          firmId: null,
        },
        {
          endpoint: people[1]!.endpoint,
          outcome: "needs_review",
          personId: null,
          firmId: null,
        },
      ],
    });
    expect(JSON.stringify(preview.body)).not.toContain(people[1]!.personId);
  });
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
      firmId: firmB,
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
    // Source captured under B; its current legacy pointer later moves to A.
    await fixture.db.query("UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2", [fixture.alpha.workspaceId, personId, firmA]);
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
