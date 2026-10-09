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

it("projects exactly one internal task from an explicit dated human promise review through the registered worker", async () => {
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
                  kind: "commitment",
                  status: "stated",
                  interpretation: "Promise to prepare summary",
                  locator: "text:0:48",
                  quote: "I will prepare the repair summary by October 12.",
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

    const first=await process("fixture-v1",0);
    const review=command({source,claimId:first.claim.claimId,claimRevision:1,claimHash:first.claim.claimHash,contextHash:first.generation.contextHash,expectedDecisionRevision:0,expectedCommitmentRevision:0,classification:"internal_promise",actor:"self",actionLabel:"Prepare the repair summary",due:{kind:"date",date:"2026-10-12",zone:"America/Chicago",expression:"by October 12"}});
    const queued=await post("/crm/commitments/review",review);expect(queued.status).toBe(200);
    const receipt=queued.body as {result:{commitmentId:string;revision:number;status:string}};
    expect(receipt.result).toMatchObject({revision:1,status:"queued"});
    const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined});
    await runOnce(fixture.db,{registry,owner:"commitment-projector",limit:20});
    const read=()=>post("/crm/commitments/read",{scope:{kind:"person",personId},limit:50});
    const visible=await read();expect(visible.status).toBe(200);
    expect(visible.body).toMatchObject({items:[{commitmentId:receipt.result.commitmentId,task:{status:"open"},actionLabel:"Prepare the repair summary",due:{kind:"date",date:"2026-10-12",zone:"America/Chicago",expression:"by October 12"},quote:"I will prepare the repair summary by October 12.",source:{occurredAt:"2026-10-01T14:00:00.000Z"}}]});
    const originalTask=(visible.body as {items:{task:{taskId:string}}[]}).items[0]!.task.taskId;
    expect((await post("/crm/commitments/review",review)).status).toBe(200);
    await runOnce(fixture.db,{registry,owner:"commitment-projector-again",limit:20});
    expect((await read()).body).toMatchObject({items:[{task:{taskId:originalTask,status:"open"}}]});
    expect((await read()).body as object).toHaveProperty("items.length",1);
  }finally{await fixture.stop();}
});
