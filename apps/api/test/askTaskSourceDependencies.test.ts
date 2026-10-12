import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
import { recordingSuppressionJournal } from "@fss/domain/suppression/journal.ts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { dispatch } from "../src/server.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { runOnce } from "../../worker/src/runner/jobRunner.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";

// Authenticated commands and the registered worker are the agreed seams; only
// purpose configuration is seeded, and all evidence/actions use product commands.
async function setup(kind: "person" | "firm" = "person") {
  const fixture = await createAuthFixture();
  const token = (
    await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
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
        suppressionJournal: recordingSuppressionJournal(),
      },
    );
  const command = (body: object) => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...body,
  });
  const person = await post(
    "/crm/people/create",
    command({ fullName: "Task source dependency" }),
  );
  expect(person.status).toBe(200);
  const personId = z
    .object({ result: z.object({ personId: z.uuid() }) })
    .parse(person.body).result.personId;
  const firm =
    kind === "firm"
      ? await post(
          "/crm/firms/add",
          command({ firm: { name: "Task retention firm" } }),
        )
      : null;
  if (firm) expect(firm.status).toBe(200);
  const firmId = firm
    ? z.object({ result: z.object({ firmId: z.uuid() }) }).parse(firm.body)
        .result.firmId
    : null;
  async function tasks(sourceKey: string, count: number, date: string) {
    const excerpt = `Routing ${sourceKey} needs review.`;
    const added = await post(
      firmId ? "/crm/firm-sources/add" : "/crm/people/source/add",
      command({
        ...(firmId ? { firmId } : { personId }),
        sourceKey,
        excerpt,
        occurredAt: "2026-10-01T14:00:00Z",
      }),
    );
    expect(added.status).toBe(200);
    const sourceId = z
      .object({ result: z.object({ sourceId: z.uuid() }) })
      .parse(added.body).result.sourceId;
    const source = {
      workspaceId: fixture.alpha.workspaceId,
      sourceId,
      kind: "selected_note" as const,
      revision: 1,
      contentHash: createHash("sha256").update(excerpt).digest("hex"),
    };
    const requested = await post(
      "/ask/answers/request",
      command({
        question: "Routing",
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
      }),
    );
    expect(requested.status).toBe(200);
    const requestId = z
      .object({ result: z.object({ requestId: z.uuid() }) })
      .parse(requested.body).result.requestId;
    const actionIds: string[] = [];
    for (let index = 0; index < count; index++) {
      const created = await post(
        "/ask/actions/create",
        command({
          requestId,
          expectedVersion: 1,
          finding: { kind: "keyword_passage", index: 0 },
          action: {
            kind: "task",
            label: `${sourceKey} task ${index}`,
            due: {
              kind: "date",
              date,
              zone: "America/New_York",
              expression: date,
            },
            target: firmId
              ? { kind: "firm", firmId }
              : { kind: "person", personId },
          },
        }),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      actionIds.push(
        z
          .object({ result: z.object({ actionId: z.uuid() }) })
          .parse(created.body).result.actionId,
      );
    }
    return {
      source,
      requestId,
      actionIds,
      erase: () =>
        post(
          "/crm/people/source/delete",
          command({
            personId,
            sourceId: source.sourceId,
            expectedRevision: source.revision,
          }),
        ),
    };
  }
  async function consume(afterRead?: () => Promise<void>) {
    await fixture.db.query(
      `INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1,1,$3)`,
      [fixture.alpha.workspaceId, "a".repeat(64), fixture.alpha.admin.userId],
    );
    const requested = await post(
      "/ask/answers/request",
      command({
        question: "Which open tasks are recorded?",
        execution: "agent_v1",
        agentScope: firmId
          ? { kind: "business" }
          : { kind: "person", personId },
        scope: { sources: [] },
      }),
    );
    expect(requested.status).toBe(200);
    const requestId = z
      .object({ result: z.object({ requestId: z.uuid() }) })
      .parse(requested.body).result.requestId;
    let calls = 0;
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
      crmAskAnswers: {
        agent: {
          endpointId: "controlled-answer",
          modelVersion: "literal-v1",
          providerKey: "fixture.ask",
          async runStep() {
            calls++;
            if (calls === 2) await afterRead?.();
            return {
              acceptance: "accepted",
              usage: { inputTokens: 20, outputTokens: 10 },
              answer: calls === 1 ? null : { claims: [], abstained: true },
              toolCalls:
                calls === 1
                  ? [
                      {
                        id: "current-tasks",
                        name: "read_exact",
                        input: { operation: "tasks" },
                      },
                    ]
                  : [],
            };
          },
        },
        agentLimits: {
          maxSteps: 3,
          maxInputBytes: 50000,
          maxOutputTokens: 1000,
          deadlineMs: 60000,
        },
        allowControlledEvaluation: true,
        verifyPurpose: async (proof) => ({
          configFingerprint: proof.configFingerprint,
          authorizationFingerprint: proof.authorizationFingerprint,
          validUntil: "2099-01-01T00:00:00Z",
          evaluationKind: "controlled_fixture",
        }),
      },
    });
    await runOnce(fixture.db, {
      registry,
      owner: "task-dependency-worker",
      limit: 100,
    });
    return {
      requestId,
      calls,
      read: () => post("/ask/answers/read", { requestId }),
      diagnostics: () => post("/ask/answers/diagnostics", { requestId }),
    };
  }
  return { fixture, post, command, personId, firmId, tasks, consume };
}

it("erases copied task evidence deleted during generation and conserves the accepted response usage", async () => {
  const f = await setup();
  try {
    const original = await f.tasks("private", 1, "2026-10-05");
    const consumer = await f.consume(async () => {
      expect((await original.erase()).status).toBe(200);
    });
    expect(consumer.calls).toBe(2);
    expect((await consumer.read()).body).toMatchObject({
      state: "stale",
      question: null,
      fallback: null,
      answer: null,
    });
    expect((await consumer.diagnostics()).body).toMatchObject({
      usage: { inputTokens: 40, outputTokens: 20 },
      cost: { unsettledCents: 0, estimated: false },
    });
  } finally {
    await f.fixture.stop();
  }
});

it("erases a task-count answer when the deleted source supports a contributor beyond the twenty displayed records", async () => {
  const f = await setup();
  try {
    await f.tasks("displayed", 20, "2026-10-05");
    const hidden = await f.tasks("hidden", 1, "2026-10-06");
    const consumer = await f.consume();
    const read = await consumer.read();
    expect(read.body).toMatchObject({
      state: "complete",
      answer: { exactResults: [{ value: { count: "21" } }] },
    });
    const exact = z
      .object({
        answer: z.object({
          exactResults: z.array(
            z.object({
              value: z.object({
                records: z.array(z.object({ key: z.string() })),
              }),
            }),
          ),
        }),
      })
      .parse(read.body);
    expect(exact.answer.exactResults[0]!.value.records).toHaveLength(20);
    expect(
      exact.answer.exactResults[0]!.value.records.map((item) => item.key),
    ).not.toContain(`ask_task:${hidden.actionIds[0]}`);
    expect((await hidden.erase()).status).toBe(200);
    expect((await consumer.read()).body).toMatchObject({
      state: "stale",
      question: null,
      fallback: null,
      answer: null,
    });
  } finally {
    await f.fixture.stop();
  }
});

it("keeps an independent human task and its source-free consumer after deleting the originating investigation", async () => {
  const f = await setup();
  try {
    const original = await f.tasks("independent", 1, "2026-10-05");
    const consumer = await f.consume();
    expect((await consumer.read()).body).toMatchObject({
      state: "complete",
      answer: { exactResults: [{ value: { count: "1" } }] },
    });
    const history = await f.post("/ask/history/list", {});
    const revision = z
      .object({
        items: z.array(
          z.object({ requestId: z.uuid(), historyRevision: z.number() }),
        ),
      })
      .parse(history.body)
      .items.find(
        (item) => item.requestId === original.requestId,
      )!.historyRevision;
    expect(
      (
        await f.post(
          "/ask/history/change",
          f.command({
            requestId: original.requestId,
            expectedRevision: revision,
            action: { kind: "delete" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.post("/ask/answers/read", { requestId: original.requestId }))
        .body,
    ).toMatchObject({ state: "deleted", question: null, answer: null });
    expect(
      (
        await f.post("/ask/read", {
          operation: "tasks",
          scope: { personId: f.personId },
        })
      ).body,
    ).toMatchObject({
      count: "1",
      records: [{ key: `ask_task:${original.actionIds[0]}` }],
    });
    expect((await consumer.read()).body).toMatchObject({
      state: "complete",
      answer: {
        exactResults: [
          {
            value: {
              count: "1",
              records: [{ key: `ask_task:${original.actionIds[0]}` }],
            },
          },
        ],
      },
    });
    expect((await original.erase()).status).toBe(200);
    expect((await consumer.read()).body).toMatchObject({
      state: "stale",
      question: null,
      answer: null,
    });
  } finally {
    await f.fixture.stop();
  }
});

it("measures and removes task dependency lineage in scoped firm deletion and erases its source-free consumer", async () => {
  const f = await setup("firm");
  try {
    await f.tasks("firm-private", 1, "2026-10-05");
    const consumer = await f.consume();
    expect((await consumer.read()).body).toMatchObject({
      state: "complete",
      answer: { exactResults: [{ value: { count: "1" } }] },
    });
    const preview = await f.post(
      "/retention/deletions/preview",
      f.command({ targetKind: "firm", firmId: f.firmId }),
    );
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({
      result: {
        removes: { crm_ask_task_dependencies: 1 },
        redacts: { crm_ask_requests: 2, crm_ask_actions: 1 },
      },
    });
    const shown = z
      .object({
        result: z.object({ requestId: z.uuid(), previewHash: z.string() }),
      })
      .parse(preview.body).result;
    const committed = await f.post(
      "/retention/deletions/commit",
      f.command(shown),
    );
    expect(committed.status, JSON.stringify(committed.body)).toBe(200);
    expect(committed.body).toMatchObject({
      result: {
        removed: { crm_ask_task_dependencies: 1 },
        redacted: { crm_ask_requests: 2, crm_ask_actions: 1 },
      },
    });
    expect((await consumer.read()).body).toMatchObject({
      state: "deleted",
      question: null,
      fallback: null,
      answer: null,
    });
  } finally {
    await f.fixture.stop();
  }
});
