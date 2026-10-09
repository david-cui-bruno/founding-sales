import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { crmProcessingResultSchema, type CrmCommitmentReview } from "@fss/contracts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { runOnce } from "../../worker/src/runner/jobRunner.ts";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";

it.each(["action", "due", "rerun", "restore", "precision", "instant_zone", "date_zone", "expression", "owner", "cas", "ambiguous", "commercial", "unknown", "undated", "caller_event", "caller_precision", "conflict", "equivalent_open", "identical_open"] as const)("preserves completed action identity across %s", async scenario => {
  const fixture = await createAuthFixture();
  try {
    let token = (
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
    const command = <T extends object>(fields: T) => ({
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
                  interpretation: modelVersion === "fixture-v1" || scenario === "identical_open" ? "Promise to prepare summary" : "Commitment to prepare the repair summary",
                  locator: "text:0:48",
                  quote: "I will prepare the repair summary by October 12.",
                },
                ...(scenario==='conflict'?[{kind:'need' as const,status:'inferred' as const,interpretation:'Timing may remain unsettled',locator:'text:0:48',quote:'I will prepare the repair summary by October 12.'}]:[]),
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
      return { generation: result, claim: result.claims.find(value=>value.kind==='commitment')! };
    }

    const first=await process("fixture-v1",0);
    const review:CrmCommitmentReview=command({source,claimId:first.claim.claimId,claimRevision:1,claimHash:first.claim.claimHash,contextHash:first.generation.contextHash,expectedDecisionRevision:0,expectedCommitmentRevision:0,classification:"internal_promise",actor:"self",actionLabel:"Prepare the repair summary",due:{kind:"date",date:"2026-10-12",zone:"America/Chicago",expression:"by October 12"}});
    if(scenario==="instant_zone")review.due={kind:"instant",at:"2026-10-12T14:00:00.123Z",zone:"UTC",expression:"at 2pm UTC"};
    if(scenario==="precision") {
      const result=await post("/crm/commitments/review",{...review,due:{kind:"instant",at:"2026-10-12T14:00:00.000001Z",zone:"UTC",expression:"at 2pm UTC"}});
      expect(result.status).toBe(400);return;
    }
    if(scenario==='ambiguous'||scenario==='commercial')review.classification=scenario;
    if(scenario==='unknown')review.actor='unknown';
    if(scenario==='undated')review.due=null;
    if(scenario==='caller_precision'){
      expect((await post('/crm/commitments/review',{...review,sourceZoneReceipt:{sourceRevision:source.revision,sourceHash:source.contentHash,zone:'UTC',eventAt:'2026-10-01T14:00:00.000001Z'}})).status).toBe(400);return;
    }
    if(scenario==='caller_event'){
      expect((await post('/crm/commitments/review',{...review,sourceZoneReceipt:{sourceRevision:source.revision,sourceHash:source.contentHash,zone:'UTC',eventAt:'2026-10-02T14:00:00.000Z'}})).status).toBe(409);return;
    }
    const target={source:review.source,claimId:review.claimId,claimRevision:review.claimRevision,claimHash:review.claimHash,contextHash:review.contextHash,expectedDecisionRevision:review.expectedDecisionRevision};
    expect((await post("/crm/commitments/review/status",target)).body).toEqual({current:null});
    const queued=await post("/crm/commitments/review",review);expect(queued.status).toBe(200);
    expect((await post("/crm/commitments/review/status",target)).body).toMatchObject({current:{commitmentId:(queued.body as {result:{commitmentId:string}}).result.commitmentId,revision:1,state:"pending"}});
    const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined});
    await runOnce(fixture.db,{registry,owner:"commitment-projector",limit:20});
    const read=()=>post("/crm/commitments/read",{scope:{kind:"person",personId},limit:50});
    if(scenario==='ambiguous'||scenario==='commercial'||scenario==='unknown'||scenario==='undated'){
      expect((await read()).body).toMatchObject({items:[{state:'suggestion',task:null}]});
      expect((await post('/crm/commitments/read',{scope:{kind:'today'},limit:50})).body).toEqual({items:[],nextAfterId:null});return;
    }
    const task=((await read()).body as {items:{task:{taskId:string}}[]}).items[0]!.task;
    if(scenario==='equivalent_open'||scenario==='identical_open'){
      await process('fixture-v2',1);
      expect((await read()).body).toMatchObject({items:[{state:'applied',actionLabel:'Prepare the repair summary',quote:'I will prepare the repair summary by October 12.',task:{taskId:task.taskId,status:'open',version:1}}]});
      expect((await post('/crm/commitments/read',{scope:{kind:'today'},limit:50})).body).toMatchObject({items:[{task:{taskId:task.taskId,status:'open'}}]});
      expect((await post('/crm/commitments/complete',command({taskId:task.taskId,expectedVersion:1}))).status).toBe(200);return;
    }
    if(scenario==='conflict'){

      const other=first.generation.claims.find(value=>value.kind==='need')!;
      const conflict=await post('/crm/evidence/conflict/save',command({expectedConflictRevision:0,members:[target,{source,claimId:other.claimId,claimRevision:1,claimHash:other.claimHash,contextHash:first.generation.contextHash,expectedDecisionRevision:0}]}));expect(conflict.status).toBe(200);
      expect((await read()).body).toMatchObject({items:[{state:'review_required',actionLabel:null,due:null,quote:null,source:null}]});
      expect((await post('/crm/commitments/read',{scope:{kind:'today'},limit:50})).body).toEqual({items:[],nextAfterId:null});
      expect((await post('/crm/commitments/complete',command({taskId:task.taskId,expectedVersion:1}))).status).toBe(409);return;
    }
    const activationReceipt=(await fixture.db.query<{activation_receipt:unknown}>("SELECT activation_receipt FROM crm_internal_tasks WHERE workspace_id=$1 AND id=$2",[source.workspaceId,task.taskId])).rows[0]!.activation_receipt;
    const runtime=await fixture.database.appRuntimeSession();
    await expect(runtime.query("UPDATE crm_internal_tasks SET activation_receipt=activation_receipt || '{\"activatedAt\":\"2026-10-01T00:00:00.000Z\"}'::jsonb,version=version+1 WHERE workspace_id=$1 AND id=$2",[source.workspaceId,task.taskId])).rejects.toMatchObject({code:"23514",constraint:"crm_internal_task_guard"});
    const done=await post("/crm/commitments/complete",command({taskId:task.taskId,expectedVersion:1}));expect(done.status).toBe(200);
    const completedAt=(done.body as {result:{completedAt:string}}).result.completedAt;
    let next:CrmCommitmentReview={...review,commandId:randomUUID(),expectedCommitmentRevision:1};
    if(scenario==="action")next={...next,actionLabel:"Prepare a revised repair summary"};
    if(scenario==="due")next={...next,due:{kind:"date",date:"2026-10-13",zone:"America/Chicago",expression:"by October 13"}};
    if(scenario==="date_zone")next={...next,due:{kind:"date",date:"2026-10-12",zone:"UTC",expression:"by October 12"}};
    if(scenario==="instant_zone")next={...next,due:{kind:"instant",at:"2026-10-12T14:00:00.123Z",zone:"America/Chicago",expression:"9am Chicago"}};
    if(scenario==="expression")next={...next,due:{...review.due!,expression:"October twelfth"},actionLabel:"Prepare   the repair summary"};
    const originalToken=token;
    if(scenario==="owner"){
      await fixture.db.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[source.workspaceId,fixture.beta.admin.userId]);
      token=(await issueSessionFor(fixture,fixture.alpha,fixture.beta.admin)).accessToken;
      next={...next,expectedCommitmentRevision:0};
    }
    if(scenario==="cas")expect((await post("/crm/commitments/review",{...next,commandId:randomUUID(),expectedCommitmentRevision:999})).status).toBe(409);
    if(scenario==="rerun"||scenario==="restore"){
      if(scenario==="restore"){
        expect((await post("/crm/people/source/delete",command({personId,sourceId:source.sourceId,expectedRevision:source.revision}))).status).toBe(200);
        const restored=await post("/crm/people/source/restore",command({personId,sourceId:source.sourceId,expectedRevision:source.revision+1}));expect(restored.status).toBe(200);
        expect((await post("/crm/people/source/recapture",command({personId,sourceId:source.sourceId,expectedRevision:source.revision+2,excerpt:"I will prepare the repair summary by October 12.",occurredAt:"2026-10-01T14:00:00Z"}))).status).toBe(200);
        const page=(await post("/crm/people/read",{personId})).body as {sources:typeof source[]};
        const fresh=page.sources.find(value=>value.sourceId===source.sourceId)!;
        source={...source,revision:fresh.revision,contentHash:fresh.contentHash};
      }
      const fresh=await process("fixture-v2",1);
      next={...next,source,claimId:fresh.claim.claimId,claimHash:fresh.claim.claimHash,contextHash:fresh.generation.contextHash,expectedCommitmentRevision:scenario==="restore"?0:1};
    }
    if(scenario==="restore")expect((await post("/crm/commitments/review",review)).status).toBe(404);
    const reviewed=await post("/crm/commitments/review",next);expect(reviewed.status).toBe(200);
    if(scenario==="action"||scenario==="due")expect((await post("/crm/commitments/review",review)).status).toBe(409);
    await runOnce(fixture.db,{registry,owner:"commitment-projector-next",limit:20});
    const result=await read();expect(result.status).toBe(200);
    const current=(result.body as {items:{task:{taskId:string;status:string}|null}[]}).items[0]!.task;
    if(scenario==="action"||scenario==="due"||scenario==="date_zone"||scenario==="owner"){
      expect(current).toMatchObject({status:"open"});expect(current!.taskId).not.toBe(task.taskId);
    } else {
      expect((await post("/crm/commitments/read",{scope:{kind:"today"},limit:50})).body).toEqual({items:[],nextAfterId:null});
      expect(current===null||current.taskId===task.taskId).toBe(true);
    }
    if(scenario==="cas")expect((await post("/crm/commitments/review",{...next,commandId:randomUUID()})).status).toBe(409);
    token=originalToken;
    if(scenario==="restore"){
      const proof=(await fixture.db.query<{review_id:string|null;activation_receipt:unknown}>("SELECT review_id,activation_receipt FROM crm_internal_tasks WHERE workspace_id=$1 AND id=$2",[source.workspaceId,task.taskId])).rows[0]!;
      expect(proof).toEqual({review_id:null,activation_receipt:null});
      await expect(runtime.query("UPDATE crm_internal_tasks SET review_id=$3,activation_receipt=$4::jsonb,version=version+1 WHERE workspace_id=$1 AND id=$2",[source.workspaceId,task.taskId,(reviewed.body as {result:{commitmentId:string}}).result.commitmentId,JSON.stringify(activationReceipt)])).rejects.toMatchObject({code:"23514",constraint:"crm_internal_task_guard"});
      expect((reviewed.body as {result:{commitmentId:string}}).result.commitmentId).not.toBe((queued.body as {result:{commitmentId:string}}).result.commitmentId);
    }
    const history=await post("/crm/commitments/read",{scope:{kind:"history"},limit:50});
    expect(history.body).toMatchObject({items:[{taskId:task.taskId,status:"done",completedAt}],nextAfterId:null});
  }finally{await fixture.stop();}
});
