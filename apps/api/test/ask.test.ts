import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
import { seedFirm } from "./support/crmSeed.ts";

it("answers exact open opportunity state in Ask without inferring conversation coverage", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const firmId = await seedFirm(fixture, {
      name: "Ask exact state firm",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const ids = [];
    for (const name of ["Repairs pilot", "Portfolio rollout"]) {
      const created = await post("/opportunities/v2/open", {
        commandId: randomUUID(),
        clientVersion: CURRENT_CLIENT_VERSION,
        firmId,
        name,
        stageKey: "new",
      });
      expect(created.status).toBe(200);
      ids.push(
        (created.body as { result: { opportunityId: string } }).result
          .opportunityId,
      );
    }
    const read = await post("/ask/read", {
      operation: "opportunities",
      scope: { firmId },
      status: "open",
      limit: 20,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      operation: "opportunities",
      count: "2",
      truncated: false,
      coverage: {
        scope: "current_permitted_crm_state",
        acquisition: "unverified",
        semantic: "not_requested",
      },
    });
    const records = (
      read.body as {
        records: {
          opportunityId: string;
          name: string;
          status: string;
          stageKey: string;
        }[];
      }
    ).records;
    expect(records.map((row) => row.opportunityId).sort()).toEqual(ids.sort());
    expect(records.map((row) => row.name).sort()).toEqual([
      "Portfolio rollout",
      "Repairs pilot",
    ]);
    expect(
      records.every((row) => row.status === "open" && row.stageKey === "new"),
    ).toBe(true);
  } finally {
    await fixture.stop();
  }
});

it("states the event basis and bounds exact opportunity counts by opening dates", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const firmId = await seedFirm(fixture, {
      name: "Ask dated state firm",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    expect(
      (
        await post("/opportunities/v2/open", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          firmId,
          name: "Current pilot",
          stageKey: "new",
        })
      ).status,
    ).toBe(200);
    const scope = {
      firmId,
      from: "2099-01-01T00:00:00.000Z",
      to: "2100-01-01T00:00:00.000Z",
    };
    const read = await post("/ask/read", {
      operation: "opportunities",
      scope,
      status: "open",
      limit: 20,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      count: "0",
      records: [],
      dateBasis: "opportunity_opened_at",
      scope,
      truncated: false,
      coverage: { acquisition: "unverified" },
    });
  } finally {
    await fixture.stop();
  }
});

it("keeps equal names as separate Ask records and requires explicit identity selection", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const ids = [];
    for (let index = 0; index < 2; index++) {
      const created = await post("/crm/people/create", {
        commandId: randomUUID(),
        clientVersion: CURRENT_CLIENT_VERSION,
        fullName: "Alex Lee",
      });
      expect(created.status).toBe(200);
      ids.push(
        (created.body as { result: { personId: string } }).result.personId,
      );
    }
    const read = await post("/ask/read", {
      operation: "records",
      query: "Alex Lee",
      kind: "people",
      limit: 20,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      operation: "records",
      selection: "ambiguous",
      coverage: { acquisition: "unverified" },
    });
    const records = (
      read.body as {
        records: {
          recordId: string;
          kind: string;
          name: string;
          firmId: null;
        }[];
      }
    ).records;
    expect(records.map((row) => row.recordId).sort()).toEqual(ids.sort());
    expect(
      records.every(
        (row) =>
          row.name === "Alex Lee" &&
          row.kind === "person" &&
          row.firmId === null,
      ),
    ).toBe(true);
  } finally {
    await fixture.stop();
  }
});

it("keeps bounded identity scans unresolved until their remaining pages are checked", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    for (let index = 0; index < 2; index++)
      expect(
        (
          await post("/crm/people/create", {
            commandId: randomUUID(),
            clientVersion: CURRENT_CLIENT_VERSION,
            fullName: "Alex Lee",
          })
        ).status,
      ).toBe(200);
    const first = await post("/ask/read", {
      operation: "records",
      query: "Alex Lee",
      kind: "people",
      limit: 1,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      selection: "unresolved",
      scanComplete: false,
    });
    const page = first.body as {
      records: { recordId: string }[];
      nextAfterId: string;
    };
    expect(page.records).toHaveLength(1);
    expect(page.nextAfterId).toEqual(expect.any(String));
    const second = await post("/ask/read", {
      operation: "records",
      query: "Alex Lee",
      kind: "people",
      limit: 1,
      afterId: page.nextAfterId,
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      selection: "unresolved",
      scanComplete: true,
      nextAfterId: null,
    });
    expect(
      (second.body as { records: { recordId: string }[] }).records[0]?.recordId,
    ).not.toBe(page.records[0]?.recordId);
  } finally {
    await fixture.stop();
  }
});

it("returns one firm identity despite multiple opportunities and preserves equal firm names", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const firmIds = [];
    for (let index = 0; index < 2; index++)
      firmIds.push(
        await seedFirm(fixture, {
          name: "Orion Management",
          assignedUserId: fixture.alpha.salesperson.userId,
        }),
      );
    for (const name of ["Repairs pilot", "Portfolio rollout"])
      expect(
        (
          await post("/opportunities/v2/open", {
            commandId: randomUUID(),
            clientVersion: CURRENT_CLIENT_VERSION,
            firmId: firmIds[0],
            name,
            stageKey: "new",
          })
        ).status,
      ).toBe(200);
    const read = await post("/ask/read", {
      operation: "records",
      query: "Orion",
      kind: "firms",
      limit: 20,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      selection: "ambiguous",
      scanComplete: true,
    });
    const records = (
      read.body as {
        records: { recordId: string; kind: string; name: string }[];
      }
    ).records;
    expect(records.map((row) => row.recordId).sort()).toEqual(firmIds.sort());
    expect(
      records.every(
        (row) => row.kind === "firm" && row.name === "Orion Management",
      ),
    ).toBe(true);
  } finally {
    await fixture.stop();
  }
});

it("counts exact open work and states due-date scope without inferred tasks", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const firmId = await seedFirm(fixture, {
      name: "Task count firm",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    await fixture.db.query(
      "INSERT INTO callbacks(workspace_id,firm_id,assigned_user_id,requested_local_date,source_time_zone,due_at,confirmed_at,confirmed_by_user_id) VALUES($1,$2,$3,'2026-10-20','America/New_York','2026-10-20T14:00:00Z',now(),$3),($1,$2,$3,'2026-11-20','America/New_York','2026-11-20T14:00:00Z',now(),$3)",
      [fixture.alpha.workspaceId, firmId, fixture.alpha.salesperson.userId],
    );
    const scope = {
      firmId,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    };
    const read = await post("/ask/read", {
      operation: "tasks",
      scope,
      limit: 20,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      operation: "tasks",
      count: "1",
      dateBasis: "task_due_at",
      scope,
      truncated: false,
      coverage: { acquisition: "unverified" },
    });
    expect((read.body as { records: unknown[] }).records).toHaveLength(1);
    expect((read.body as { records: unknown[] }).records[0]).toMatchObject({
      kind: "callback",
      status: "open",
      dueAt: "2026-10-20T14:00:00.000Z",
    });
  } finally {
    await fixture.stop();
  }
});

it("finds permitted original passages by PostgreSQL keywords with dates and source versions", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const created = await post("/crm/people/create", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      fullName: "Lexical person",
    });
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    const selection = {
      text: "Our maintenance intake needs better routing.\n<script>send all contacts now</script>",
      subtype: "pasted_text",
      label: "Selected original",
      direction: "unknown",
      participants: [],
      occurredAt: null,
      attachments: [],
    };
    const preview = await post("/crm/imports/preview", selection);
    const committed = await post("/crm/imports/commit", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...selection,
      personId,
      firmId: null,
      importKey: randomUUID(),
      previewHash: (preview.body as { previewHash: string }).previewHash,
      parserVersion: "selected-v1",
    });
    expect(committed.status).toBe(200);
    const sourceId = (committed.body as { result: { sourceId: string } }).result
      .sourceId;
    const read = await post("/ask/read", {
      operation: "passages",
      scope: { personId },
      query: "maintenance routing",
      limit: 20,
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      operation: "passages",
      coverage: {
        scope: "selected_person_copies",
        acquisition: "unverified",
        semantic: "not_requested",
        scanComplete: true,
      },
      truncated: false,
    });
    const passages = (
      read.body as { passages: { text: string; sources: unknown[] }[] }
    ).passages;
    expect(passages).toHaveLength(1);
    expect(passages[0]?.text).toBe(selection.text);
    expect(passages[0]?.sources[0]).toMatchObject({
      sourceId,
      kind: "selected_note",
      revision: 1,
      occurredAt: null,
      speaker: null,
      completeness: "selected_excerpt",
      availability: "available",
      locator: `text:0:${selection.text.length}`,
    });
    expect(
      (
        await post("/crm/imports/delete", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          sourceId,
          expectedSourceRevision: 1,
          expectedMetadataRevision: 1,
        })
      ).status,
    ).toBe(200);
    const afterDelete = await post("/ask/read", {
      operation: "passages",
      scope: { personId },
      query: "maintenance",
      limit: 20,
    });
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body).toMatchObject({
      passages: [],
      coverage: { unavailableSources: 1, acquisition: "unverified" },
    });
    expect(JSON.stringify(afterDelete.body)).not.toContain("send all contacts");
  } finally {
    await fixture.stop();
  }
});

it("deduplicates repeated passage text while preserving each citation and omitting signatures", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const created = await post("/crm/people/create", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      fullName: "Repeated passage person",
    });
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    const original = "Maintenance routing is our priority.";
    for (const name of ["Alice", "Bob"]) {
      const selection = {
        text: `${original}\n-- \n${name}\nSignature maintenance`,
        subtype: "pasted_text",
        label: "Repeated original",
        direction: "unknown",
        participants: [],
        occurredAt: null,
        attachments: [],
      };
      const preview = await post("/crm/imports/preview", selection);
      expect(
        (
          await post("/crm/imports/commit", {
            commandId: randomUUID(),
            clientVersion: CURRENT_CLIENT_VERSION,
            ...selection,
            personId,
            firmId: null,
            importKey: randomUUID(),
            previewHash: (preview.body as { previewHash: string }).previewHash,
            parserVersion: "selected-v1",
          })
        ).status,
      ).toBe(200);
    }
    const read = await post("/ask/read", {
      operation: "passages",
      scope: { personId },
      query: "maintenance",
      limit: 20,
    });
    expect(read.status).toBe(200);
    const passages = (
      read.body as {
        passages: { text: string; sources: { sourceId: string }[] }[];
      }
    ).passages;
    expect(passages).toHaveLength(1);
    expect(passages[0]?.text).toBe(original);
    expect(passages[0]?.sources).toHaveLength(2);
    expect(
      new Set(passages[0]?.sources.map((source) => source.sourceId)).size,
    ).toBe(2);
    expect(read.body).toMatchObject({
      coverage: { omittedSignatures: 2, chunkerVersion: "lexical-original-v1" },
    });
  } finally {
    await fixture.stop();
  }
});

it("retrieves dated operational activity separately from copied conversation coverage", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const firmId = await seedFirm(fixture, {
      name: "Dated activity firm",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    await fixture.db.query(
      "INSERT INTO call_logs(workspace_id,firm_id,outcome,step_effect,occurred_at,recorded_at,actor_user_id) VALUES($1,$2,'no_answer','none','2026-10-01T12:00:00Z',now(),$3),($1,$2,'no_answer','none','2026-09-01T12:00:00Z',now(),$3)",
      [fixture.alpha.workspaceId, firmId, fixture.alpha.salesperson.userId],
    );
    const scope = {
      firmId,
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
    };
    const read = await post("/ask/read", { operation: "activity", scope });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      operation: "activity",
      scope,
      dateBasis: "operational_event_at",
      scanComplete: true,
      coverage: { acquisition: "unverified" },
    });
    const events = (read.body as { events: unknown[] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "call",
      code: "no_answer",
      at: "2026-10-01T12:00:00.000Z",
    });
  } finally {
    await fixture.stop();
  }
});

it("does not claim no reply when conversation acquisition is incomplete", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const firmId = await seedFirm(fixture, {
      name: "Unknown reply firm",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const read = await post("/ask/read", {
      operation: "reply_status",
      scope: { firmId },
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      operation: "reply_status",
      verifiedOutgoingCount: "0",
      withoutVerifiedReplyCount: "0",
      unanswered: "not_established",
      coverage: {
        scope: "authorized_progress_receipts",
        acquisition: "partial",
        semantic: "not_requested",
      },
    });
  } finally {
    await fixture.stop();
  }
});

it("searches a bounded explicitly selected whole copy beyond the first passage without processing", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const envelope = (body: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...body,
    });
    const created = await post(
      "/crm/people/create",
      envelope({ fullName: "Explicit corpus owner" }),
    );
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    const text =
      "ordinary context ".repeat(150) +
      "Drainage coordination is the stated need.";
    expect(
      (
        await post(
          "/crm/people/source/add",
          envelope({
            personId,
            sourceKey: "beyond-first-window",
            excerpt: text,
            occurredAt: "2026-10-01T14:00:00.000Z",
          }),
        )
      ).status,
    ).toBe(200);
    const page = (await post("/crm/people/read", { personId })).body as {
      sources: {
        workspaceId: string;
        sourceId: string;
        revision: number;
        contentHash: string;
      }[];
    };
    const selected = page.sources[0]!;
    const source = { ...selected, kind: "selected_note", locator: null };
    const read = await post("/ask/read", {
      operation: "passages",
      scope: {
        sources: [
          {
            workspaceId: source.workspaceId,
            sourceId: source.sourceId,
            kind: source.kind,
            revision: source.revision,
            contentHash: source.contentHash,
            locator: null,
          },
        ],
      },
      query: "Drainage",
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      operation: "passages",
      passages: [
        {
          text: expect.stringContaining("Drainage coordination"),
          sources: [
            {
              sourceId: source.sourceId,
              revision: 1,
              locator: "text:2000:2591",
              speaker: null,
              occurredAt: "2026-10-01T14:00:00.000Z",
              completeness: "selected_excerpt",
            },
          ],
        },
      ],
      coverage: {
        scope: "explicit_copied_sources",
        semantic: "not_requested",
        scanComplete: true,
        inspectedSources: 1,
        inspectedWindows: 2,
        truncatedSources: 0,
        refusedSources: 0,
      },
    });
  } finally {
    await fixture.stop();
  }
});

it("searches original meeting utterance windows with the recorded speaker and original event date", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const firmId = await seedFirm(fixture, {
      name: "Original meeting corpus",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const meetingId = randomUUID(),
      recordingId = randomUUID(),
      sourceId = randomUUID();
    await fixture.db.query(
      "INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$2::uuid::text,$2::uuid::text,'booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",
      [fixture.alpha.workspaceId, meetingId, firmId],
    );
    await fixture.db.query(
      "INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Original meeting',$4,100,$5,'ready')",
      [
        fixture.alpha.workspaceId,
        recordingId,
        meetingId,
        "b".repeat(64),
        `meetings/${meetingId}/${"b".repeat(64)}.m4a`,
      ],
    );
    const prefix = "ordinary context ".repeat(125),
      utterances = [
        {
          startMs: 0,
          endMs: 5000,
          text: prefix + "Drainage coordination is needed.",
          speaker: "Speaker 1",
          attribution: "unknown",
        },
        {
          startMs: 5000,
          endMs: 8000,
          text: "A separate ordinary utterance.",
          speaker: "Speaker 2",
          attribution: "unknown",
        },
      ];
    await fixture.db.query(
      "INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,8000,'en-US',$4::jsonb)",
      [
        fixture.alpha.workspaceId,
        sourceId,
        recordingId,
        JSON.stringify(utterances),
      ],
    );
    const source = {
      workspaceId: fixture.alpha.workspaceId,
      sourceId,
      kind: "meeting_transcript",
      revision: 1,
      contentHash: createHash("sha256")
        .update(JSON.stringify(utterances))
        .digest("hex"),
      locator: null,
    };
    const read = await post("/ask/read", {
      operation: "passages",
      scope: { sources: [source] },
      query: "Drainage",
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      passages: [
        {
          text: utterances[0]!.text.slice(2000),
          sources: [
            {
              sourceId,
              kind: "meeting_transcript",
              revision: 1,
              locator: `utterance:0:text:2000:${utterances[0]!.text.length}`,
              speaker: "Speaker 1",
              occurredAt: "2026-10-01T14:00:00.000Z",
              completeness: "partial",
            },
          ],
        },
      ],
      coverage: {
        scanComplete: true,
        inspectedSources: 1,
        inspectedWindows: 3,
        semantic: "not_requested",
      },
    });
  } finally {
    await fixture.stop();
  }
});

it("returns permitted copies from an explicit mixed request without revealing refused copy contents", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const adminToken = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown, credential = token) =>
      dispatch(
        {
          method: "POST",
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${credential}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const sources = [];
    for (const [credential, text] of [
      [token, "Drainage coordination is our priority."],
      [adminToken, "Secret drainage staffing."],
    ] as const) {
      const created = await post(
        "/crm/people/create",
        {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          fullName: "Selected record",
        },
        credential,
      );
      const personId = (created.body as { result: { personId: string } }).result
        .personId;
      expect(
        (
          await post(
            "/crm/people/source/add",
            {
              commandId: randomUUID(),
              clientVersion: CURRENT_CLIENT_VERSION,
              personId,
              sourceKey: randomUUID(),
              excerpt: text,
              occurredAt: "2026-10-01T14:00:00Z",
            },
            credential,
          )
        ).status,
      ).toBe(200);
      const page = await post("/crm/people/read", { personId }, credential);
      const row = (
        page.body as {
          sources: {
            workspaceId: string;
            sourceId: string;
            revision: number;
            contentHash: string;
          }[];
        }
      ).sources[0]!;
      sources.push({ ...row, kind: "selected_note", locator: null });
    }
    const read = await post("/ask/read", {
      operation: "passages",
      scope: {
        sources: sources.map(
          ({
            workspaceId,
            sourceId,
            kind,
            revision,
            contentHash,
            locator,
          }) => ({
            workspaceId,
            sourceId,
            kind,
            revision,
            contentHash,
            locator,
          }),
        ),
      },
      query: "drainage",
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      passages: [{ text: "Drainage coordination is our priority." }],
      coverage: {
        requestedSources: 2,
        inspectedSources: 1,
        refusedSources: 1,
        scanComplete: false,
      },
    });
    expect(JSON.stringify(read.body)).not.toContain("Secret");
  } finally {
    await fixture.stop();
  }
});

it("retrieves call speech with the original channel label and an unknown original date", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const ws = fixture.alpha.workspaceId,
      user = fixture.alpha.salesperson.userId;
    const firmId = await seedFirm(fixture, {
      name: "Native call source",
      regionCode: "RI",
      assignedUserId: user,
    });
    const callId = randomUUID();
    const route = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,'+14015550123','research_provider',now(),0.9,'passed','usable','route.1') RETURNING id",
        [ws, firmId],
      )
    ).rows[0]!.id;
    const identity = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO calling_identities(workspace_id,owner_user_id,e164,verification_status,enabled,verified_at,verified_by_user_id,verification_method) VALUES($1,$2,'+14015550124','verified',false,now(),$2,'owner_attestation') RETURNING id",
        [ws, user],
      )
    ).rows[0]!.id;
    const posture = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO state_postures(workspace_id,state,revision,effective_from,review_at,rules_revision,confirmed_statements,confirmed_by_user_id) VALUES($1,'RI',1,'2026-01-01','2027-01-01',2,ARRAY['businessToBusiness'],$2) RETURNING id",
        [ws, fixture.alpha.admin.userId],
      )
    ).rows[0]!.id;
    const device = (
      await fixture.db.query<{ id: string }>(
        "SELECT id FROM devices WHERE workspace_id=$1 AND user_id=$2 LIMIT 1",
        [ws, user],
      )
    ).rows[0]!.id;
    const ticket = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO dial_tickets(workspace_id,command_id,firm_id,phone_route_id,route_version,posture_id,posture_revision,calling_identity_id,actor_user_id,device_id,assigned_user_id,e164,firm_time_zone,expires_at) VALUES($1,'crm-call-fixture',$2,$3,1,$4,1,$5,$6,$7,$6,'+14015550123','America/New_York',now()+interval '30 seconds') RETURNING id",
        [ws, firmId, route, posture, identity, user, device],
      )
    ).rows[0]!.id;
    const reservation = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros,state,settled_at) VALUES($1,'twilio.voice','call_session',$2,1,current_date,'America/New_York',0,NULL,NULL,NULL,'minute',1,0,'released',now()) RETURNING id",
        [ws, callId],
      )
    ).rows[0]!.id;
    await fixture.db.query(
      "INSERT INTO call_sessions(workspace_id,id,ticket_id,firm_id,actor_user_id,reservation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 seconds')",
      [ws, callId, ticket, firmId, user, reservation],
    );
    const utterances = [
      {
        speaker: 1,
        start: 0,
        end: 5,
        text: "Drainage coordination is needed.",
      },
    ];
    await fixture.db.query(
      "INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances) VALUES($1,$2,'aws_transcribe','standard','en-US',5,$3::jsonb)",
      [ws, callId, JSON.stringify(utterances)],
    );
    const source = {
      workspaceId: ws,
      sourceId: callId,
      kind: "call_transcript",
      revision: 1,
      contentHash: createHash("sha256")
        .update(JSON.stringify(utterances))
        .digest("hex"),
      locator: null,
    };

    const read = await post("/ask/read", {
      operation: "passages",
      scope: { sources: [source] },
      query: "drainage",
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      passages: [
        {
          text: "Drainage coordination is needed.",
          sources: [
            {
              sourceId: callId,
              kind: "call_transcript",
              locator: "utterance:0:text:0:32",
              speaker: "channel:1",
              occurredAt: null,
              completeness: "partial",
            },
          ],
        },
      ],
      coverage: {
        scanComplete: true,
        inspectedSources: 1,
        inspectedWindows: 1,
      },
    });
  } finally {
    await fixture.stop();
  }
});

it("discovers bounded exact copied sources for an explicitly selected person without inference", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const created = await post("/crm/people/create", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      fullName: "Source discovery person",
    });
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    for (let index = 0; index < 2; index++)
      expect(
        (
          await post("/crm/people/source/add", {
            commandId: randomUUID(),
            clientVersion: CURRENT_CLIENT_VERSION,
            personId,
            sourceKey: `discovery:${index}`,
            excerpt: "Drainage coordination is needed.",
            occurredAt: "2026-10-01T14:00:00Z",
          })
        ).status,
      ).toBe(200);
    const first = await post("/ask/read", {
      operation: "sources",
      scope: { personId },
      limit: 1,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      operation: "sources",
      scope: { personId },
      sources: [
        {
          workspaceId: fixture.alpha.workspaceId,
          kind: "selected_note",
          revision: 1,
          locator: null,
          availability: "available",
          occurredAt: "2026-10-01T14:00:00.000Z",
        },
      ],
      coverage: {
        scope: "record_copied_sources",
        scanComplete: false,
        semantic: "not_requested",
      },
    });
    const page = first.body as {
      sources: { sourceId: string }[];
      nextAfter: { kind: string; sourceId: string };
    };
    expect(page.nextAfter).toEqual({
      kind: "selected_note",
      sourceId: page.sources[0]!.sourceId,
    });
    const second = await post("/ask/read", {
      operation: "sources",
      scope: { personId },
      after: page.nextAfter,
      limit: 1,
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      nextAfter: null,
      coverage: { scanComplete: true },
    });
    expect(
      (second.body as { sources: { sourceId: string }[] }).sources[0]!.sourceId,
    ).not.toBe(page.sources[0]!.sourceId);
    expect(JSON.stringify(first.body)).not.toContain("Drainage coordination");
  } finally {
    await fixture.stop();
  }
});

it("discovers an authorized deleted selected copy as a body-free unavailable reference", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
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
    const created = await post("/crm/people/create", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      fullName: "Deleted discovery person",
    });
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    const added = await post("/crm/people/source/add", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      personId,
      sourceKey: randomUUID(),
      excerpt: "Private drainage coordination.",
      occurredAt: "2026-10-01T14:00:00Z",
    });
    const sourceId = (added.body as { result: { sourceId: string } }).result
      .sourceId;
    expect(
      (
        await post("/crm/people/source/delete", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          personId,
          sourceId,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(200);
    const read = await post("/ask/read", {
      operation: "sources",
      scope: { personId },
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      sources: [
        {
          sourceId,
          kind: "selected_note",
          revision: 2,
          contentHash: null,
          occurredAt: null,
          locator: null,
          availability: "deleted",
          completeness: "unavailable",
        },
      ],
      coverage: { scanComplete: true },
    });
    expect(JSON.stringify(read.body)).not.toContain("Private drainage");
  } finally {
    await fixture.stop();
  }
});
