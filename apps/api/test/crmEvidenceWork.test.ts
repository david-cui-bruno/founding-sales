import type {
  SessionQueryable,
  QueryResultRowLike,
} from "@fss/domain/db/queryable.ts";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { crmProcessingResultSchema } from "@fss/contracts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { runOnce } from "../../worker/src/runner/jobRunner.ts";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";

import { seedFirm } from "./support/crmSeed.ts";
it("flags dependent open meeting work after correction while preserving completed action facts", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    let workAuditUnavailable = false;
    const wrapped: SessionQueryable = {
      async query<Row extends QueryResultRowLike>(
        sql: string,
        values?: readonly unknown[],
      ) {
        if (
          workAuditUnavailable &&
          values?.[3] === "crm.evidence_work_admin_read"
        )
          throw new Error("Controlled work audit unavailable");
        return fixture.db.query<Row>(sql, values);
      },
    };
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: "POST",
          path,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
          body,
        },
        {
          session: wrapped,
          auth: { ...fixture.deps, db: wrapped },
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...fields,
    });
    const firmId = await seedFirm(fixture, {
      name: "Supported work firm",
      assignedUserId: fixture.alpha.admin.userId,
    });
    await post(
      "/crm/firm-sources/add",
      command({
        firmId,
        sourceKey: "human-review",
        excerpt: "We need help coordinating repairs.",
        occurredAt: "2026-10-01T14:00:00Z",
      }),
    );
    const page = await post("/crm/firm-sources/read", { firmId });
    const selected = (
      page.body as {
        sources: {
          workspaceId: string;
          sourceId: string;
          revision: number;
          contentHash: string;
        }[];
      }
    ).sources[0]!;
    const source = {
      workspaceId: selected.workspaceId,
      sourceId: selected.sourceId,
      kind: "selected_note" as const,
      revision: selected.revision,
      contentHash: selected.contentHash,
      locator: null,
    };
    async function process(
      modelVersion: string,
      expectedRevision: number,
      interpretation = "Needs repair coordination",
    ) {
      expect(
        (
          await post(
            "/crm/processing/purpose/save",
            command({
              expectedRevision,
              enabled: false,
              endpointId: "review-evaluation",
              modelVersion,
              accessGrantVersion: "fixture-review-grant",
              dataHandlingVersion: "fixture-review-policy",
              dailyCeilingCents: 100,
              monthlyCeilingCents: 1000,
              inputTokenPriceMicros: 1,
              outputTokenPriceMicros: 1,
            }),
          )
        ).status,
      ).toBe(200);
      // Isolated evaluation fixture only; public controls cannot enable processing.
      await fixture.db.query(
        "UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1",
        [source.workspaceId],
      );
      await post("/crm/processing/request", command({ source }));
      const registry = registerHandlers(new HandlerRegistry(), {
        classifier: undefined,
        mail: undefined,
        send: undefined,
        research: undefined,
        crmExtraction: {
          adapter: {
            endpointId: "review-evaluation",
            modelVersion,
            accessGrantVersion: "fixture-review-grant",
            dataHandlingVersion: "fixture-review-policy",
            providerKey: "fixture.crm_review",
            fundingVerifiedUntil: "2099-01-01T00:00:00Z",
            run: async () => ({
              acceptance: "accepted",
              usage: { inputTokens: 1, outputTokens: 1 },
              claims: [
                {
                  kind: "need",
                  status: "stated",
                  interpretation,
                  locator: "text:0:12",
                  quote: "We need help",
                },
              ],
            }),
          },
        },
      });
      await runOnce(fixture.db, {
        registry,
        owner: `review-${modelVersion}`,
        limit: 20,
      });
      const result = crmProcessingResultSchema.parse(
        (await post("/crm/processing/read", { source })).body,
      );
      if (!("generationId" in result) || result.claims[0] === undefined)
        throw new Error("Controlled extraction unavailable");
      return { generation: result, claim: result.claims[0] };
    }

    const first = await process("fixture-v1", 0);
    const target = {
      source,
      claimId: first.claim.claimId,
      claimRevision: 1,
      claimHash: first.claim.claimHash,
      contextHash: first.generation.contextHash,
    };
    expect(
      (
        await post(
          "/crm/evidence/decide",
          command({
            ...target,
            expectedDecisionRevision: 0,
            action: "confirm",
          }),
        )
      ).status,
    ).toBe(200);
    const meetingId = randomUUID();
    await fixture.db.query(
      "INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'evidence-tasks','evidence-tasks','booked',now(),now(),now())",
      [source.workspaceId, meetingId, firmId],
    );
    const tasks = [];
    for (const commitment of ["open-support", "completed-support"]) {
      const taskId = randomUUID();
      tasks.push(taskId);
      await fixture.db.query(
        `INSERT INTO meeting_tasks(workspace_id,id,meeting_id,firm_id,commitment_id,label,owner_user_id,deadline,due_at,evidence) VALUES($1,$2,$3,$4,$5,'Arrange repair discussion',$6,'{"precision":"date","localDate":"2026-10-10","zone":"America/New_York"}',now(),'[{"kind":"debrief","revision":1,"quote":"We need help","startOffset":0,"endOffset":12}]')`,
        [
          source.workspaceId,
          taskId,
          meetingId,
          firmId,
          commitment,
          fixture.alpha.admin.userId,
        ],
      );
    }
    expect(
      (
        await post(
          "/meetings/tasks/change",
          command({ taskId: tasks[1], expectedVersion: 1, action: "complete" }),
        )
      ).status,
    ).toBe(200);
    const open = { kind: "meeting_task", id: tasks[0]! },
      done = { kind: "meeting_task", id: tasks[1]! };
    const doneBefore = await post("/crm/evidence/work/read", { work: done });
    expect(doneBefore.status).toBe(200);
    const completedAt = (doneBefore.body as { work: { completedAt: string } })
      .work.completedAt;
    expect(completedAt).toEqual(expect.any(String));
    const openBindCommand = command({
      ...target,
      expectedDecisionRevision: 1,
      work: { ...open, expectedVersion: "1" },
    });
    expect(
      (await post("/crm/evidence/work/bind", openBindCommand)).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/crm/evidence/work/bind",
          command({
            ...target,
            expectedDecisionRevision: 1,
            work: { ...done, expectedVersion: "2" },
          }),
        )
      ).status,
    ).toBe(200);
    const discover = await post("/crm/evidence/work/list", {
      kind: source.kind,
      sourceId: source.sourceId,
    });
    expect(discover.status).toBe(200);
    expect(discover.body).toMatchObject({
      works: expect.arrayContaining([
        expect.objectContaining({
          work: open,
          status: "open",
          version: "1",
          reviewRequired: false,
        }),
        expect.objectContaining({
          work: done,
          status: "done",
          version: "2",
          completedAt,
          reviewRequired: false,
        }),
      ]),
      nextAfter: null,
    });
    expect(
      (
        await post(
          "/crm/evidence/decide",
          command({
            ...target,
            expectedDecisionRevision: 1,
            action: "correct",
            correctedInterpretation: "Annual repair coordination only",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await post("/crm/evidence/work/bind", openBindCommand)).status,
    ).toBe(409);
    expect(
      (await post("/crm/evidence/work/read", { work: open })).body,
    ).toMatchObject({
      work: { status: "open", version: "1", completedAt: null },
      dependencies: [
        {
          reviewRequired: true,
          reason: "human_decision_changed",
          observedDecisionRevision: 1,
        },
      ],
    });
    expect(
      (await post("/crm/evidence/work/read", { work: done })).body,
    ).toMatchObject({
      work: { status: "done", version: "2", completedAt },
      dependencies: [
        { reviewRequired: false, reason: null, observedDecisionRevision: 1 },
      ],
    });
    const second = await process(
      "fixture-v2",
      1,
      "Has a different repair plan",
    );
    expect(
      (
        await post(
          "/crm/evidence/work/bind",
          command({
            ...target,
            expectedDecisionRevision: 2,
            work: { ...open, expectedVersion: "1" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await post("/crm/evidence/work/read", { work: open })).body,
    ).toMatchObject({ dependencies: [{ reviewRequired: false }] });
    const conflict = await post(
      "/crm/evidence/conflict/save",
      command({
        expectedConflictRevision: 0,
        members: [
          { ...target, expectedDecisionRevision: 2 },
          {
            source,
            claimId: second.claim.claimId,
            claimRevision: 1,
            claimHash: second.claim.claimHash,
            contextHash: second.generation.contextHash,
            expectedDecisionRevision: 0,
          },
        ],
      }),
    );
    expect(conflict.status).toBe(200);
    expect(
      (await post("/crm/evidence/work/read", { work: open })).body,
    ).toMatchObject({
      work: { status: "open", version: "1" },
      dependencies: [{ reviewRequired: true, reason: "conflict_changed" }],
    });
    expect(
      (await post("/crm/evidence/work/read", { work: done })).body,
    ).toMatchObject({
      work: { status: "done", version: "2", completedAt },
      dependencies: [{ reviewRequired: false, reason: null }],
    });
    expect(
      (
        await post(
          "/crm/firm-sources/delete",
          command({ firmId, sourceId: source.sourceId, expectedRevision: 1 }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await post("/crm/evidence/work/read", { work: open })).body,
    ).toMatchObject({
      work: { status: "open" },
      dependencies: [{ reviewRequired: true, reason: "source_deleted" }],
    });
    expect(
      (await post("/crm/evidence/work/read", { work: done })).body,
    ).toMatchObject({
      work: { status: "done", version: "2", completedAt },
      dependencies: [{ reviewRequired: false, reason: null }],
    });
    const outcomes = await dispatch(
      {
        method: "GET",
        path: "/meetings/outcomes",
        body: undefined,
        query: new URLSearchParams({ meetingId }),
        headers: { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(outcomes.body).toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({
          id: tasks[1],
          status: "done",
          label: "Arrange repair discussion",
          evidence: [
            {
              kind: "debrief",
              revision: 1,
              quote: "We need help",
              startOffset: 0,
              endOffset: 12,
            },
          ],
        }),
      ]),
    });
    workAuditUnavailable = true;
    await expect(
      post("/crm/evidence/work/read", { work: done }),
    ).rejects.toThrow("Controlled work audit unavailable");
  } finally {
    await fixture.stop();
  }
});

it("keeps equivalent reprocessing stable and flags open call work after a material model change", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: "POST",
          path,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
          body,
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...fields,
    });
    const firmId = await seedFirm(fixture, {
      name: "Supported work firm",
      assignedUserId: fixture.alpha.admin.userId,
    });
    await post(
      "/crm/firm-sources/add",
      command({
        firmId,
        sourceKey: "human-review",
        excerpt: "We need help coordinating repairs.",
        occurredAt: "2026-10-01T14:00:00Z",
      }),
    );
    const page = await post("/crm/firm-sources/read", { firmId });
    const selected = (
      page.body as {
        sources: {
          workspaceId: string;
          sourceId: string;
          revision: number;
          contentHash: string;
        }[];
      }
    ).sources[0]!;
    const source = {
      workspaceId: selected.workspaceId,
      sourceId: selected.sourceId,
      kind: "selected_note" as const,
      revision: selected.revision,
      contentHash: selected.contentHash,
      locator: null,
    };
    async function process(
      modelVersion: string,
      expectedRevision: number,
      interpretation = "Needs repair coordination",
    ) {
      expect(
        (
          await post(
            "/crm/processing/purpose/save",
            command({
              expectedRevision,
              enabled: false,
              endpointId: "review-evaluation",
              modelVersion,
              accessGrantVersion: "fixture-review-grant",
              dataHandlingVersion: "fixture-review-policy",
              dailyCeilingCents: 100,
              monthlyCeilingCents: 1000,
              inputTokenPriceMicros: 1,
              outputTokenPriceMicros: 1,
            }),
          )
        ).status,
      ).toBe(200);
      // Isolated evaluation fixture only; public controls cannot enable processing.
      await fixture.db.query(
        "UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1",
        [source.workspaceId],
      );
      await post("/crm/processing/request", command({ source }));
      const registry = registerHandlers(new HandlerRegistry(), {
        classifier: undefined,
        mail: undefined,
        send: undefined,
        research: undefined,
        crmExtraction: {
          adapter: {
            endpointId: "review-evaluation",
            modelVersion,
            accessGrantVersion: "fixture-review-grant",
            dataHandlingVersion: "fixture-review-policy",
            providerKey: "fixture.crm_review",
            fundingVerifiedUntil: "2099-01-01T00:00:00Z",
            run: async () => ({
              acceptance: "accepted",
              usage: { inputTokens: 1, outputTokens: 1 },
              claims: [
                {
                  kind: "need",
                  status: "stated",
                  interpretation,
                  locator: "text:0:12",
                  quote: "We need help",
                },
              ],
            }),
          },
        },
      });
      await runOnce(fixture.db, {
        registry,
        owner: `review-${modelVersion}`,
        limit: 20,
      });
      const result = crmProcessingResultSchema.parse(
        (await post("/crm/processing/read", { source })).body,
      );
      if (!("generationId" in result) || result.claims[0] === undefined)
        throw new Error("Controlled extraction unavailable");
      return { generation: result, claim: result.claims[0] };
    }

    const first = await process("fixture-v1", 0);
    const target = {
      source,
      claimId: first.claim.claimId,
      claimRevision: 1,
      claimHash: first.claim.claimHash,
      contextHash: first.generation.contextHash,
    };
    expect(
      (
        await post(
          "/crm/evidence/decide",
          command({
            ...target,
            expectedDecisionRevision: 0,
            action: "confirm",
          }),
        )
      ).status,
    ).toBe(200);
    const taskId = (
      await fixture.db.query<{ id: string }>(
        `INSERT INTO call_tasks(workspace_id,firm_id,quote_key,text,due_at,created_by_user_id) VALUES($1,$2,'task:0123456789abcdef','Arrange repair discussion',now(),$3) RETURNING id`,
        [source.workspaceId, firmId, fixture.alpha.admin.userId],
      )
    ).rows[0]!.id;
    const work = { kind: "call_task", id: taskId };
    const before = await post("/crm/evidence/work/read", { work });
    const version = (before.body as { work: { version: string } }).work.version;
    expect(
      (
        await post(
          "/crm/evidence/work/bind",
          command({
            ...target,
            expectedDecisionRevision: 1,
            work: { ...work, expectedVersion: version },
          }),
        )
      ).status,
    ).toBe(200);
    await process("fixture-v2", 1);
    expect(
      (await post("/crm/evidence/work/read", { work })).body,
    ).toMatchObject({
      work: { status: "open", version },
      dependencies: [{ reviewRequired: false }],
    });
    await process("fixture-v3", 2, "Only emergency repair vendors are needed");
    expect(
      (await post("/crm/evidence/work/read", { work })).body,
    ).toMatchObject({
      work: { status: "open", version },
      dependencies: [
        { reviewRequired: true, reason: "material_claim_changed" },
      ],
    });
  } finally {
    await fixture.stop();
  }
});
