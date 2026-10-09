import { createHash,randomUUID } from "node:crypto";
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

it("redacts initial A promise proof after a B re-review without erasing a B-only promise on the same copy", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const options = {
      session: fixture.db,
      auth: fixture.deps,
      supportedClientVersions: fixture.deps.config.supportedClientVersions,
      sendingEnabled: false,
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
        options,
      );
    const get = (path: string) =>
      dispatch(
        {
          method: "GET",
          path,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
          body: null,
        },
        options,
      );
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...fields,
    });
    const firmA = await seedFirm(fixture, {
      name: "Historical review A",
      assignedUserId: fixture.alpha.admin.userId,
    });
    const firmB = await seedFirm(fixture, {
      name: "Actual captured B",
      assignedUserId: fixture.alpha.admin.userId,
    });
    const personId = await seedContact(fixture, {
      firmId: firmB,
      fullName: "B-captured correspondent",
    });
    expect(
      (await post("/crm/people/bridge", command({ contactIds: [personId] })))
        .status,
    ).toBe(200);
    const quoteA = "I will prepare the repair summary by October 12.";
    const quoteB = "I will prepare the invoice by October 13.";
    const excerpt = quoteA + " " + quoteB;
    expect(
      (
        await post(
          "/crm/people/source/add",
          command({
            personId,
            sourceKey: "captured-under-B",
            excerpt,
            occurredAt: "2026-10-01T14:00:00Z",
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
    const copied = page.sources[0]!;
    let source = {
      workspaceId: copied.workspaceId,
      sourceId: copied.sourceId,
      revision: copied.revision,
      contentHash: copied.contentHash,
      kind: "selected_note" as const,
      locator: null,
    };
    // Controlled legacy relationship movement; capture-time B authority is not rewritten.
    await fixture.db.query(
      "UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2",
      [source.workspaceId, personId, firmA],
    );
    const initialEvidence={sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash};
    const initialRelationship=await post('/crm/relationships/save',command({personId,firmId:firmA,status:'current',startDate:null,endDate:null,evidence:initialEvidence}));
    expect(initialRelationship.status).toBe(200);
    const initialRelation=(initialRelationship.body as {result:{relationshipId:string;revision:number}}).result;
    expect((await post('/crm/relationships/context/save',command({personId,relationshipId:initialRelation.relationshipId,relationshipRevision:initialRelation.revision,evidence:initialEvidence}))).status).toBe(200);
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
      // Isolated fake-model evaluation grant; public production controls remain disabled.
      await fixture.db.query(
        "UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1",
        [source.workspaceId],
      );
      expect(
        (await post("/crm/processing/request", command({ source }))).status,
      ).toBe(200);
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
                  locator: `text:0:${quoteA.length}`,
                  quote: quoteA,
                },
                {
                  kind: "commitment",
                  status: "stated",
                  interpretation: "Promise to prepare invoice",
                  locator: `text:${quoteA.length + 1}:${excerpt.length}`,
                  quote: quoteB,
                },
              ],
            }),
          },
        },
      });
      await runOnce(fixture.db, { registry, owner: modelVersion, limit: 20 });
      const result = crmProcessingResultSchema.parse(
        (await post("/crm/processing/read", { source })).body,
      );
      if (!("generationId" in result) || result.claims.length !== 2)
        throw new Error("Controlled extraction unavailable");
      return result;
    }
    const projector = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
    });
    const review = async (
      generation: Awaited<ReturnType<typeof process>>,
      quote: string,
      expectedCommitmentRevision: number,
      actionLabel: string,
      date: string,
    ) => {
      const claim = generation.claims.find((value) => value.quote === quote)!;
      const result = await post(
        "/crm/commitments/review",
        command({
          source,
          claimId: claim.claimId,
          claimRevision: 1,
          claimHash: claim.claimHash,
          contextHash: generation.contextHash,
          expectedDecisionRevision: 0,
          expectedCommitmentRevision,
          classification: "internal_promise",
          actor: "self",
          actionLabel,
          due: {
            kind: "date",
            date,
            zone: "America/Chicago",
            expression: "by October",
          },
        }),
      );
      expect(result.status).toBe(200);
      await runOnce(fixture.db, {
        registry: projector,
        owner: "promise-projector",
        limit: 20,
      });
      return (result.body as { result: { commitmentId: string } }).result
        .commitmentId;
    };
    const first = await process("fixture-v1", 0);
    const historicalId = await review(
      first,
      quoteA,
      0,
      "Prepare repair summary",
      "2026-10-12",
    );
    // Controlled canonical correction fixture: old A context is revision-bound,
    // while immutable original capture authority remains genuinely B.
    const correctedExcerpt=excerpt+' ';
    await fixture.db.query("UPDATE crm_selected_sources SET excerpt=$3,content_hash=$4,revision=revision+1 WHERE workspace_id=$1 AND id=$2",[source.workspaceId,source.sourceId,correctedExcerpt,createHash('sha256').update(correctedExcerpt).digest('hex')]);
    const correctedPage=(await post('/crm/people/read',{personId})).body as {sources:{sourceId:string;revision:number;contentHash:string}[]};
    const corrected=correctedPage.sources.find(item=>item.sourceId===source.sourceId)!;
    source={...source,revision:corrected.revision,contentHash:corrected.contentHash};
    const evidence = {
      sourceId: source.sourceId,
      sourceRevision: source.revision,
      contentHash: source.contentHash,
    };
    const relationship = await post(
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
    expect(relationship.status).toBe(200);
    const relation = (
      relationship.body as {
        result: { relationshipId: string; revision: number };
      }
    ).result;
    expect(
      (
        await post(
          "/crm/relationships/context/save",
          command({
            personId,
            relationshipId: relation.relationshipId,
            relationshipRevision: relation.revision,
            evidence,
          }),
        )
      ).status,
    ).toBe(200);
    const next = await process("fixture-v2", 1);
    expect(
      await review(next, quoteA, 1, "Prepare repair summary", "2026-10-12"),
    ).toBe(historicalId);
    const independentId = await review(
      next,
      quoteB,
      0,
      "Prepare independent invoice",
      "2026-10-13",
    );
    const read = () =>
      post("/crm/commitments/read", {
        scope: { kind: "person", personId },
        limit: 50,
      });
    const before = await read();
    expect(before.status).toBe(200);
    const items = (
      before.body as {
        items: {
          commitmentId: string;
          task: { taskId: string; version: number };
          actionLabel: string;
        }[];
      }
    ).items;
    const independent = items.find(
      (item) => item.commitmentId === independentId,
    )!;
    expect(independent).toMatchObject({
      actionLabel: "Prepare independent invoice",
      task: { version: 1 },
    });
    expect((await get("/today/actions/v2")).status).toBe(200);
    const authority=(await fixture.db.query<{original_access_closure:{firmIds:string[]};context_snapshot:{firmIds:string[]};initial_context_snapshot:{firmIds:string[]}}> ("SELECT r.initial_context_snapshot,r.context_snapshot,s.original_access_closure FROM crm_commitment_reviews r JOIN crm_selected_sources s ON s.workspace_id=r.workspace_id AND s.id=(r.target->'source'->>'sourceId')::uuid WHERE r.workspace_id=$1 AND r.id=$2",[source.workspaceId,historicalId])).rows[0]!;
    expect(authority.original_access_closure.firmIds).toEqual([firmB]);
    expect(authority.context_snapshot.firmIds).toEqual([firmB]);
    const originalReview=(await fixture.db.query<{initial_context_snapshot:{firmIds:string[]}}> ("SELECT initial_context_snapshot FROM crm_commitment_reviews WHERE workspace_id=$1 AND id=$2",[source.workspaceId,historicalId])).rows[0]!;
    expect(originalReview.initial_context_snapshot.firmIds).toContain(firmA);
    const preview = await post(
      "/retention/deletions/preview",
      command({ targetKind: "firm", firmId: firmA }),
    );
    expect(preview.status).toBe(200);
    const shown = (
      preview.body as {
        result: {
          requestId: string;
          previewHash: string;
          redacts: Record<string, number>;
        };
      }
    ).result;
    // Initial A proof must count even though the latest review and copy are B-scoped.
    expect.soft(shown.redacts["crm_commitment_reviews"]).toBe(1);
    expect.soft(shown.redacts["crm_internal_tasks"]).toBe(1);
    const committed = await post(
      "/retention/deletions/commit",
      command({ requestId: shown.requestId, previewHash: shown.previewHash }),
    );
    expect(committed.status).toBe(200);
    expect.soft(committed.body).toMatchObject({
      result: {
        redacted: { crm_commitment_reviews: 1, crm_internal_tasks: 1 },
      },
    });
    const after = await read();
    expect(after.status).toBe(200);
    expect.soft(after.body).toMatchObject({
      items: [
        {
          commitmentId: independentId,
          actionLabel: "Prepare independent invoice",
          quote: quoteB,
          task: { taskId: independent.task.taskId, status: "open" },
        },
      ],
    });
    expect
      .soft(JSON.stringify(after.body))
      .not.toContain("Prepare repair summary");
    expect((await post("/crm/people/read", { personId })).body).toMatchObject({
      sources: [
        { sourceId: source.sourceId, availability: "available", excerpt:correctedExcerpt },
      ],
    });
    const today = await get("/today/actions/v2");
    expect(today.status).toBe(200);
    expect(today.body).toMatchObject({
      actions: expect.arrayContaining([
        expect.objectContaining({
          kind: "promise",
          target: expect.objectContaining({ taskId: independent.task.taskId }),
        }),
      ]),
    });
    const completion = await post(
      "/crm/commitments/complete",
      command({
        taskId: independent.task.taskId,
        expectedVersion: independent.task.version,
      }),
    );
    expect.soft(completion.status).toBe(200);
    expect.soft(completion.body).toMatchObject({
      result: { taskId: independent.task.taskId, version: 2 },
    });
  } finally {
    await fixture.stop();
  }
});
