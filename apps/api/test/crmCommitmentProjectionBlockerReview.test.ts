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

it("shows a persistent source-bound Today problem only after promise projection exhausts registered worker retries", async () => {
  const fixture = await createAuthFixture();
  let faultInstalled = false;
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
    const get = (path: string) =>
      dispatch(
        {
          method: "GET",
          path,
          body: null,
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
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...fields,
    });
    const created = await post(
      "/crm/people/create",
      command({ fullName: "Human decision correspondent" }),
    );
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    await post(
      "/crm/people/source/add",
      command({
        personId,
        sourceKey: "human-review",
        excerpt: "I will prepare the repair summary by October 12.",
        occurredAt: "2026-10-01T14:00:00Z",
      }),
    );
    const page = await post("/crm/people/read", { personId });
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
    let modelCalls = 0;
    async function process(modelVersion: string, expectedRevision: number) {
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
        crmExtraction: { allowControlledEvaluation:true,
          adapter: {
            endpointId: "review-evaluation",
            modelVersion,
            accessGrantVersion: "fixture-review-grant",
            dataHandlingVersion: "fixture-review-policy",
            providerKey: "fixture.crm_review",
            fundingVerifiedUntil: "2099-01-01T00:00:00Z",
            run: async () => {
              modelCalls++;
              return {
                acceptance: "accepted",
                usage: { inputTokens: 1, outputTokens: 1 },
                claims: [
                  {
                    kind: "commitment",
                    status: "stated",
                    interpretation: "Promise to prepare summary",
                    locator: "text:0:48",
                    quote: "I will prepare the repair summary by October 12.",
                  },
                ],
              };
            },
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
    const review = command({
      source,
      claimId: first.claim.claimId,
      claimRevision: 1,
      claimHash: first.claim.claimHash,
      contextHash: first.generation.contextHash,
      expectedDecisionRevision: 0,
      expectedCommitmentRevision: 0,
      classification: "internal_promise",
      actor: "self",
      actionLabel: "Prepare the repair summary",
      due: {
        kind: "date",
        date: "2026-10-12",
        zone: "America/Chicago",
        expression: "by October 12",
      },
    });
    const queued = await post("/crm/commitments/review", review);
    expect(queued.status).toBe(200);
    const receipt = queued.body as {
      result: { commitmentId: string; revision: number; status: string };
    };
    expect(receipt.result).toMatchObject({ revision: 1, status: "queued" });
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
    });
    const quiet = await get("/today/actions/v2");
    expect(quiet.status).toBe(200);
    expect(quiet.body).toMatchObject({ version: 2, actions: [] });
    // Disposable fault injection makes each actual registered projection attempt
    // fail atomically; the runner, rather than the fixture, exhausts its budget.
    await fixture.db.query(
      "CREATE FUNCTION review_projection_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_PROJECTION_FAILURE_DETAIL'; END $$",
    );
    await fixture.db.query(
      "CREATE TRIGGER review_projection_fault BEFORE INSERT ON crm_internal_tasks FOR EACH ROW EXECUTE FUNCTION review_projection_fault()",
    );
    faultInstalled = true;
    for (let attempt = 1; attempt <= 3; attempt++) {
      await runOnce(fixture.db, {
        registry,
        owner: `projection-fault-${attempt}`,
        limit: 20,
      });
      const job = (
        await fixture.db.query<{
          id: string;
          state: string;
          attempt_count: number;
          max_attempts: number;
        }>(
          "SELECT id,state,attempt_count,max_attempts FROM jobs WHERE workspace_id=$1 AND kind='crm.commitments_project' AND payload->>'commitmentId'=$2",
          [source.workspaceId, receipt.result.commitmentId],
        )
      ).rows[0]!;
      expect(job.attempt_count).toBe(attempt);
      expect(job.max_attempts).toBe(3);
      expect(job.state).toBe(attempt === 3 ? "dead" : "retryable");
      if (attempt < 3) {
        expect((await get("/today/actions/v2")).body).toMatchObject({
          version: 2,
          actions: [],
        });
        // Advance only the disposable retry eligibility; do not edit attempts,
        // fences or state. The next registered runner performs the real claim.
        await fixture.db.query(
          "UPDATE jobs SET not_before=clock_timestamp()-interval '1 second',run_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2",
          [source.workspaceId, job.id],
        );
      }
    }
    const protectedPage = await post("/crm/commitments/read", {
      scope: {
        kind: "source",
        sourceId: source.sourceId,
        sourceKind: source.kind,
      },
      limit: 50,
    });
    expect(protectedPage.status).toBe(200);
    expect(protectedPage.body).toMatchObject({
      items: [
        {
          commitmentId: receipt.result.commitmentId,
          revision: 1,
          state: "pending",
          quote: "I will prepare the repair summary by October 12.",
          task: null,
        },
      ],
    });
    expect((await post("/crm/processing/source/read", source)).status).toBe(
      200,
    );
    expect((await get("/today/actions")).body).toMatchObject({
      version: 1,
      actions: [],
    });
    expect(modelCalls).toBe(1);
    const failed = await get("/today/actions/v2");
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({
      version: 2,
      actions: [
        {
          kind: "problem",
          reason: "commitment_projection_failed",
          state: "open",
          target: {
            kind: "commitment_blocker",
            review: { commitmentId: receipt.result.commitmentId, revision: 1 },
            support: {
              sourceKind: source.kind,
              sourceId: source.sourceId,
              sourceRevision: source.revision,
              sourceHash: source.contentHash,
            },
          },
        },
      ],
    });
    expect((failed.body as { actions: unknown[] }).actions).toHaveLength(1);
    expect(JSON.stringify(failed.body)).not.toContain(
      "PRIVATE_PROJECTION_FAILURE_DETAIL",
    );
    expect(JSON.stringify(failed.body)).not.toContain("Complete");
  } finally {
    try {
      if (faultInstalled) {
        await fixture.db.query(
          "DROP TRIGGER review_projection_fault ON crm_internal_tasks",
        );
        await fixture.db.query("DROP FUNCTION review_projection_fault()");
      }
    } finally {
      await fixture.stop();
    }
  }
});
