import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { runOnce } from "../../worker/src/runner/jobRunner.ts";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
it("includes current explicit human tasks, respects undated/date scopes and filters completed or deleted-source work", async () => {
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
    const command = (body: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...body,
    });
    const created = await post(
      "/crm/people/create",
      command({ fullName: "Actual human follow-on task" }),
    );
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    expect(
      (
        await post(
          "/crm/people/source/add",
          command({
            personId,
            sourceKey: "task-evidence",
            excerpt: "Repairs need clearer routing.",
            occurredAt: "2026-10-01T14:00:00Z",
          }),
        )
      ).status,
    ).toBe(200);
    const page = await post("/crm/people/read", { personId });
    const source = (
      page.body as {
        sources: {
          workspaceId: string;
          sourceId: string;
          kind: "selected_note";
          revision: number;
          contentHash: string;
        }[];
      }
    ).sources[0]!;
    const requested = await post(
      "/ask/answers/request",
      command({
        question: "repairs",
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
    const requestId = (requested.body as { result: { requestId: string } })
      .result.requestId;
    const task = await post(
      "/ask/actions/create",
      command({
        requestId,
        expectedVersion: 1,
        finding: { kind: "keyword_passage", index: 0 },
        action: {
          kind: "task",
          label: "Review repair routing",
          due: null,
          target: { kind: "person", personId },
        },
      }),
    );
    expect(task.status).toBe(200);
    const actionId = (task.body as { result: { actionId: string } }).result
      .actionId;
    const read = await post("/ask/read", {
      operation: "tasks",
      scope: { business: true },
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      count: "1",
      countBasis: "exact",
      records: [
        {
          key: `ask_task:${actionId}`,
          kind: "ask_task",
          label: "Review repair routing",
          dueAt: null,
          status: "open",
          personId,
        },
      ],
    });
    await fixture.db.query(
      `INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1,1,$3)`,
      [fixture.alpha.workspaceId, "a".repeat(64), fixture.alpha.admin.userId],
    );
    const exactRequest = await post(
      "/ask/answers/request",
      command({
        question: "Which open tasks do I have?",
        execution: "agent_v1",
        agentScope: { kind: "business" },
        scope: { sources: [] },
      }),
    );
    expect(exactRequest.status).toBe(200);
    const exactId = (exactRequest.body as { result: { requestId: string } })
      .result.requestId;
    let steps = 0;
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
            steps++;
            return {
              acceptance: "accepted",
              usage: { inputTokens: 20, outputTokens: 10 },
              answer: steps === 1 ? null : { claims: [], abstained: true },
              toolCalls:
                steps === 1
                  ? [
                      {
                        id: "all-open-tasks",
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
      owner: "all-open-tasks-worker",
      limit: 20,
    });
    expect(
      (await post("/ask/answers/read", { requestId: exactId })).body,
    ).toMatchObject({
      state: "complete",
      answer: {
        exactResults: [
          {
            toolCallId: "all-open-tasks",
            value: {
              count: "1",
              records: [{ key: `ask_task:${actionId}`, kind: "ask_task" }],
            },
          },
        ],
      },
    });
    expect(
      (await post("/ask/read", { operation: "tasks", scope: { personId } }))
        .body,
    ).toMatchObject({ count: "1", records: [{ kind: "ask_task", personId }] });
    const personRequest = await post(
      "/ask/answers/request",
      command({
        question: "Which open tasks are for this person?",
        execution: "agent_v1",
        agentScope: { kind: "person", personId },
        scope: { sources: [] },
      }),
    );
    expect(personRequest.status).toBe(200);
    const personExactId = (
      personRequest.body as { result: { requestId: string } }
    ).result.requestId;
    steps = 0;
    await runOnce(fixture.db, {
      registry,
      owner: "person-open-tasks-worker",
      limit: 20,
    });
    expect(
      (await post("/ask/answers/read", { requestId: personExactId })).body,
    ).toMatchObject({
      state: "complete",
      answer: {
        exactResults: [
          {
            value: {
              scope: { personId },
              count: "1",
              records: [{ kind: "ask_task", personId }],
            },
          },
        ],
      },
    });
    const dated = await post("/ask/read", {
      operation: "tasks",
      scope: { business: true, from: "2026-10-01T00:00:00Z" },
    });
    expect(dated.body).toMatchObject({ count: "0", records: [] });
    expect(
      (
        await post(
          "/ask/actions/change",
          command({ actionId, expectedVersion: 1, action: "complete_task" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/ask/read", {
          operation: "tasks",
          scope: { business: true },
        })
      ).body,
    ).toMatchObject({ count: "0", records: [] });
    expect(
      (await post("/ask/answers/read", { requestId: exactId })).body,
    ).toMatchObject({
      state: "complete",
      answer: {
        exactResults: [],
        missingEvidence: expect.arrayContaining(["exact_state_changed"]),
      },
    });
    const second = await post(
      "/ask/actions/create",
      command({
        requestId,
        expectedVersion: 1,
        finding: { kind: "keyword_passage", index: 0 },
        action: {
          kind: "task",
          label: "Another human task",
          due: {
            kind: "date",
            date: "2026-10-12",
            zone: "America/Chicago",
            expression: "October12",
          },
          target: { kind: "person", personId },
        },
      }),
    );
    expect(second.status).toBe(200);
    const localDate = await post("/ask/read", {
      operation: "tasks",
      scope: {
        business: true,
        from: "2026-10-12T05:00:00Z",
        to: "2026-10-13T05:00:00Z",
      },
    });
    expect(localDate.body).toMatchObject({
      count: "1",
      records: [{ kind: "ask_task", dueAt: "2026-10-12T05:00:00.000Z" }],
    });
    expect(
      (
        await post(
          "/crm/people/source/delete",
          command({
            personId,
            sourceId: source.sourceId,
            expectedRevision: source.revision,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post("/ask/read", {
          operation: "tasks",
          scope: { business: true },
        })
      ).body,
    ).toMatchObject({ count: "0", records: [] });
    for (const consumingRequestId of [exactId, personExactId]) {
      const consumed = await post("/ask/answers/read", {
        requestId: consumingRequestId,
      });
      expect(consumed.status).toBe(200);
      expect.soft(consumed.body).toMatchObject({
        state: "stale",
        question: null,
        fallback: null,
        answer: null,
      });
    }
    const historyAfterSourceDeletion = await post("/ask/history/list", {});
    expect(historyAfterSourceDeletion.status).toBe(200);
    for (const consumingRequestId of [exactId, personExactId]) {
      expect.soft(historyAfterSourceDeletion.body).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            requestId: consumingRequestId,
            state: "stale",
            question: null,
            title: null,
          }),
        ]),
      });
    }
  } finally {
    await fixture.stop();
  }
});
