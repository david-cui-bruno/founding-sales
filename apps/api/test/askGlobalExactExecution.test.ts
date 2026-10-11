import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
import { seedFirm } from "./support/crmSeed.ts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { runOnce } from "../../worker/src/runner/jobRunner.ts";
it("retains source-free global exact observations in saved reads with original immutable date bounds", async () => {
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
    const firmId = await seedFirm(fixture, {
      name: "Source-free date-scoped exact firm",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    expect(
      (
        await post(
          "/opportunities/v2/open",
          command({ firmId, name: "Exact opportunity", stageKey: "new" }),
        )
      ).status,
    ).toBe(200);
    const exact = await post("/ask/read", {
      operation: "opportunities",
      scope: { business: true },
      status: "all",
      limit: 20,
    });
    const from = (exact.body as { records: { openedAt: string }[] }).records[0]!
      .openedAt;
    const to = new Date(Date.parse(from) + 86400000).toISOString();
    await fixture.db.query(
      `INSERT INTO crm_ask_purposes(workspace_id,purpose,revision,enabled,endpoint_id,model_version,access_grant_version,data_handling_version,evaluation_fingerprint,processor_version,retrieval_version,answer_version,support_version,chunker_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by) VALUES($1,'answer',1,true,'controlled-answer','literal-v1','fixture-grant','fixture-handling',$2,'ask-answer-v1','lexical-original-v1','literal-v1','exact-original-v1','lexical-original-v1',100,1000,1,1,$3)`,
      [fixture.alpha.workspaceId, "a".repeat(64), fixture.alpha.admin.userId],
    );
    const requested = await post(
      "/ask/answers/request",
      command({
        question: "How many opportunities opened in this interval?",
        execution: "agent_v1",
        agentScope: { kind: "business", from, to },
        scope: { sources: [] },
      }),
    );
    expect(requested.status).toBe(200);
    const requestId = (requested.body as { result: { requestId: string } })
      .result.requestId;
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
          async runStep(input) {
            calls++;
            if (calls === 1)
              expect(JSON.stringify(input.transcript)).toContain(from);
            return {
              acceptance: "accepted",
              usage: { inputTokens: 20, outputTokens: 10 },
              answer: calls === 1 ? null : { claims: [], abstained: true },
              toolCalls:
                calls === 1
                  ? [
                      {
                        id: "global-exact",
                        name: "read_exact",
                        input: { operation: "opportunities" },
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
      owner: "global-exact-worker",
      limit: 20,
    });
    const read = await post("/ask/answers/read", { requestId });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      state: "complete",
      answer: {
        exactResults: [
          {
            toolCallId: "global-exact",
            operation: "opportunities",
            value: { scope: { business: true, from, to }, count: "1" },
          },
        ],
      },
      supportedWork: {
        exactResults: [{ toolCallId: "global-exact", value: { count: "1" } }],
      },
    });
    expect(calls).toBe(2);
  } finally {
    await fixture.stop();
  }
});
