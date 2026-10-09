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
import { seedFirm, seedContact } from "./support/crmSeed.ts";
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
    const get=(path:string)=>dispatch({method:"GET",path,body:null,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}}, {session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
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
    let source = {
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
    const projection=(await fixture.db.query<{receipt:unknown}>("SELECT to_jsonb(r)->'projection_receipt' AS receipt FROM crm_commitment_reviews r WHERE workspace_id=$1 AND id=$2",[source.workspaceId,receipt.result.commitmentId])).rows[0]!.receipt;
    expect(projection).toMatchObject({reviewRevision:1,sourceKind:source.kind,sourceId:source.sourceId,sourceRevision:source.revision,sourceHash:source.contentHash,decisionRevision:0,contextHash:first.generation.contextHash,outcome:"applied",observedAt:expect.any(String),jobId:expect.any(String),fencingToken:expect.any(String)});
    const read=()=>post("/crm/commitments/read",{scope:{kind:"person",personId},limit:50});
    const visible=await read();expect(visible.status).toBe(200);
    expect(visible.body).toMatchObject({items:[{commitmentId:receipt.result.commitmentId,task:{status:"open"},actionLabel:"Prepare the repair summary",due:{kind:"date",date:"2026-10-12",zone:"America/Chicago",expression:"by October 12"},quote:"I will prepare the repair summary by October 12.",source:{occurredAt:"2026-10-01T14:00:00.000Z"}}]});
    const originalTask=(visible.body as {items:{task:{taskId:string}}[]}).items[0]!.task.taskId;
    const actionsV1=await get("/today/actions");expect(actionsV1.status).toBe(200);expect(actionsV1.body).toMatchObject({version:1,actions:[]});
    const actionsV2=await get("/today/actions/v2");expect(actionsV2.status).toBe(200);
    expect(actionsV2.body).toMatchObject({version:2,actions:[{kind:"promise",reason:"dated_promise",due:{kind:"date",date:"2026-10-12",zone:"America/Chicago"},target:{kind:"internal_task",taskId:originalTask,expectedVersion:1,review:{commitmentId:receipt.result.commitmentId,revision:1,projectionVersion:1}}}]});
    expect((await get("/today/actions")).body).toMatchObject({version:1,actions:[]});
    const promiseAction=(actionsV2.body as {actions:{actionId:string;target:unknown}[]}).actions[0]!;
    expect((await post("/today/actions/open/v2",{actionId:promiseAction.actionId,target:promiseAction.target})).body).toEqual({version:2,target:promiseAction.target});

    const runtime=await fixture.database.appRuntimeSession();
    await expect(runtime.query("UPDATE crm_commitment_reviews SET original_access_closure='{\"firmIds\":[],\"personIds\":[]}'::jsonb,revision=revision+1 WHERE workspace_id=$1 AND id=$2",[source.workspaceId,receipt.result.commitmentId])).rejects.toMatchObject({code:"23514",constraint:"crm_commitment_review_guard"});
    await expect(runtime.query("UPDATE crm_commitment_reviews SET state='suggestion' WHERE workspace_id=$1 AND id=$2",[source.workspaceId,receipt.result.commitmentId])).rejects.toMatchObject({code:"23514",constraint:"crm_commitment_review_guard"});
    await expect(runtime.query("UPDATE crm_internal_tasks SET status='cancelled' WHERE workspace_id=$1 AND id=$2",[source.workspaceId,originalTask])).rejects.toMatchObject({code:"23514",constraint:"crm_internal_task_guard"});
    await expect(runtime.query("DELETE FROM crm_internal_tasks WHERE workspace_id=$1 AND id=$2",[source.workspaceId,originalTask])).rejects.toMatchObject({code:"42501"});

    expect((await post("/crm/commitments/review",review)).status).toBe(200);
    await runOnce(fixture.db,{registry,owner:"commitment-projector-again",limit:20});
    expect((await read()).body).toMatchObject({items:[{task:{taskId:originalTask,status:"open"}}]});
    expect((await read()).body as object).toHaveProperty("items.length",1);
    // Cycle2: an explicit actual completion is separate from evidence review.
    const complete=command({taskId:originalTask,expectedVersion:1});
    const done=await post("/crm/commitments/complete",complete);expect(done.status).toBe(200);
    expect(done.body).toMatchObject({result:{taskId:originalTask,version:2}});
    const completedAt=(done.body as {result:{completedAt:string}}).result.completedAt;
    expect((await read()).body).toMatchObject({items:[{task:{taskId:originalTask,status:"done",version:2,completedAt}}]});
    expect((await post("/crm/commitments/complete",complete)).body).toMatchObject({result:(done.body as {result:unknown}).result});
    await expect(runtime.query("UPDATE crm_internal_tasks SET completed_at=clock_timestamp(),version=version+1 WHERE workspace_id=$1 AND id=$2",[source.workspaceId,originalTask])).rejects.toMatchObject({code:"23514",constraint:"crm_internal_task_guard"});
    const revised={...review,commandId:randomUUID(),expectedCommitmentRevision:1,actionLabel:"Prepare a revised repair summary"};
    expect((await post("/crm/commitments/review",revised)).status).toBe(200);
    await runOnce(fixture.db,{registry,owner:"commitment-projector-revised",limit:20});
    const updated=await read();expect(updated.body).toMatchObject({items:[{revision:2,task:{status:"open",version:1,completedAt:null}}]});
    const changedTask=(updated.body as {items:{task:{taskId:string}}[]}).items[0]!.task.taskId;expect(changedTask).not.toBe(originalTask);

    expect((await post("/crm/commitments/read",{scope:{kind:"today"},limit:50})).body).toMatchObject({items:[{task:{taskId:changedTask,status:"open"}}]});
    expect((await post("/today/actions/open/v2",{actionId:promiseAction.actionId,target:promiseAction.target})).body).toEqual({version:2,target:null});
    // Cycle3: changed interpretation cannot erase an already performed action.
    const correction=await post("/crm/evidence/decide",command({source,claimId:first.claim.claimId,claimRevision:1,claimHash:first.claim.claimHash,contextHash:first.generation.contextHash,expectedDecisionRevision:0,action:"correct",correctedInterpretation:"This was tentative, not an agreed commitment"}));expect(correction.status).toBe(200);
    const corrected=await read();expect(corrected.status).toBe(200);
    expect(corrected.body).toMatchObject({items:[{state:"review_required",actionLabel:null,due:null,quote:null,source:null,task:{taskId:changedTask,status:"open",version:2,completedAt:null}}]});
    // Cycle4: whole-copy deletion scrubs private promise proof, not completion.
    expect((await post("/crm/people/source/delete",command({personId,sourceId:source.sourceId,expectedRevision:source.revision}))).status).toBe(200);
    const redacted=await post("/crm/commitments/read",{scope:{kind:"history"},limit:50});expect(redacted.status).toBe(200);
    expect(redacted.body).toMatchObject({items:[{taskId:originalTask,status:"done",version:3,completedAt}],nextAfterId:null});
    expect(JSON.stringify(redacted.body)).not.toContain("repair summary");
    const scrubbed=(await runtime.query<Record<string,unknown>>("SELECT anchor_id,target,context_snapshot,original_access_closure,classification,actor,action_label,due,source_zone_receipt,projection_receipt FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2",[source.workspaceId,receipt.result.commitmentId])).rows[0]!;
    expect(Object.values(scrubbed)).toEqual(Array(10).fill(null));
    // Cycle7: terminal original-firm deletion previews and redacts current private proof.
    const firmId=await seedFirm(fixture,{name:"Original promise authority",assignedUserId:fixture.alpha.admin.userId});
    const bridgedId=await seedContact(fixture,{firmId,fullName:"Captured firm promise owner"});
    expect((await post("/crm/people/bridge",command({contactIds:[bridgedId]}))).status).toBe(200);
    expect((await post("/crm/people/source/add",command({personId:bridgedId,sourceKey:"firm-promise",excerpt:"I will prepare the repair summary by October 12.",occurredAt:"2026-10-01T14:00:00Z"}))).status).toBe(200);
    const firmPage=await post("/crm/people/read",{personId:bridgedId});
    const firmSource=(firmPage.body as {sources:typeof source[]}).sources[0]!;
    source={workspaceId:firmSource.workspaceId,sourceId:firmSource.sourceId,kind:"selected_note",revision:firmSource.revision,contentHash:firmSource.contentHash,locator:null};
    const second=await process("fixture-v2",1);
    const secondReview=command({source,claimId:second.claim.claimId,claimRevision:1,claimHash:second.claim.claimHash,contextHash:second.generation.contextHash,expectedDecisionRevision:0,expectedCommitmentRevision:0,classification:"internal_promise",actor:"self",actionLabel:"Prepare the firm summary",due:{kind:"date",date:"2026-10-12",zone:"America/Chicago",expression:"by October 12"}});
    const secondQueued=await post("/crm/commitments/review",secondReview);expect(secondQueued.status).toBe(200);
    const secondId=(secondQueued.body as {result:{commitmentId:string}}).result.commitmentId;
    await runOnce(fixture.db,{registry,owner:"firm-commitment-projector",limit:20});
    const firmCommitments=await post("/crm/commitments/read",{scope:{kind:"person",personId:bridgedId},limit:50});expect(firmCommitments.status).toBe(200);
    const secondTask=(firmCommitments.body as {items:{task:{taskId:string}}[]}).items[0]!.task.taskId;
    expect((await post("/crm/commitments/complete",command({taskId:secondTask,expectedVersion:1}))).status).toBe(200);
    // Controlled current-context drift: original A capture is retained while current source moves to B.
    const movedFirmId=await seedFirm(fixture,{name:"Current promise context B",assignedUserId:fixture.alpha.admin.userId});
    await fixture.db.query("UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2",[source.workspaceId,bridgedId,movedFirmId]);
    expect((await runtime.query<{closure:{firmIds:string[]}}>("SELECT original_access_closure AS closure FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2",[source.workspaceId,secondId])).rows[0]!.closure.firmIds).toEqual([firmId]);
    const deletionPreview=await post("/retention/deletions/preview",command({targetKind:"firm",firmId}));expect(deletionPreview.status).toBe(200);
    const previewReceipt=(deletionPreview.body as {result:{requestId:string;previewHash:string;redacts:Record<string,number>}}).result;
    expect(previewReceipt.redacts["crm_commitment_reviews"]).toBe(1);
    expect(previewReceipt.redacts["crm_internal_tasks"]).toBe(1);
    const deleted=await post("/retention/deletions/commit",command({requestId:previewReceipt.requestId,previewHash:previewReceipt.previewHash}));expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({result:{redacted:{crm_commitment_reviews:1,crm_internal_tasks:1}}});
    const finalProof=(await runtime.query<Record<string,unknown>>("SELECT anchor_id,target,context_snapshot,original_access_closure,classification,actor,action_label,due,source_zone_receipt,projection_receipt FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2",[source.workspaceId,secondId])).rows[0]!;
    expect(Object.values(finalProof)).toEqual(Array(10).fill(null));
    const history=await post("/crm/commitments/read",{scope:{kind:"history"},limit:50});expect(history.status).toBe(200);
    expect((history.body as {items:{taskId:string;status:string}[]}).items).toEqual(expect.arrayContaining([expect.objectContaining({taskId:originalTask,status:"done"}),expect.objectContaining({taskId:secondTask,status:"done"})]));
    // Cycle8: imported obsolete promises remain quiet record history.
    const historicalAdded=await post("/crm/people/source/add",command({personId,sourceKey:"historical-promise",excerpt:"I will prepare the repair summary by October 12.",occurredAt:"2000-01-01T14:00:00Z"}));expect(historicalAdded.status).toBe(200);
    const historicalId=(historicalAdded.body as {result:{sourceId:string}}).result.sourceId;
    const historicalPage=(await post("/crm/people/read",{personId})).body as {sources:typeof source[]};
    const historicalSource=historicalPage.sources.find(value=>value.sourceId===historicalId)!;
    source={workspaceId:historicalSource.workspaceId,sourceId:historicalId,kind:"selected_note",revision:historicalSource.revision,contentHash:historicalSource.contentHash,locator:null};
    const historicalClaim=await process("fixture-v3",2);
    const historicalReview=command({source,claimId:historicalClaim.claim.claimId,claimRevision:1,claimHash:historicalClaim.claim.claimHash,contextHash:historicalClaim.generation.contextHash,expectedDecisionRevision:0,expectedCommitmentRevision:0,classification:"internal_promise",actor:"self",actionLabel:"Historical summary promise",due:{kind:"date",date:"2000-10-12",zone:"America/Chicago",expression:"by October 12"}});
    expect((await post("/crm/commitments/review",historicalReview)).status).toBe(200);
    await runOnce(fixture.db,{registry,owner:"historical-commitment-projector",limit:20});
    expect((await read()).body).toMatchObject({items:[{actionLabel:"Historical summary promise",todayEligibility:"historical",task:{status:"open"}}]});
    expect((await post("/crm/commitments/read",{scope:{kind:"today"},limit:50})).body).toEqual({items:[],nextAfterId:null});





  }finally{await fixture.stop();}
});
