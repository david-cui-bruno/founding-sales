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

it("retains unrelated Today work after a moved copy loses its current firm authority", async () => {
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
    const adminToken = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const configure = (body: unknown) =>
      dispatch(
        {
          method: "POST",
          path: "/crm/processing/purpose/save",
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${adminToken}` },
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
    const firmA = await seedFirm(fixture, {
      name: "Private A promise",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const firmB = await seedFirm(fixture, {
      name: "Permitted B promise",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    let personId = await seedContact(fixture, {
      firmId: firmA,
      fullName: "Original A correspondent",
    });
    expect(
      (await post("/crm/people/bridge", command({ contactIds: [personId] })))
        .status,
    ).toBe(200);
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
          await configure(
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
    await runOnce(fixture.db, {
      registry,
      owner: "commitment-projector",
      limit: 20,
    });
    const firstRead = await post("/crm/commitments/read", {
      scope: { kind: "person", personId },
      limit: 50,
    });
    expect(firstRead.status).toBe(200);
    const firstTask = (
      firstRead.body as { items: { task: { taskId: string } }[] }
    ).items[0]!.task.taskId;
    const firstPersonId = personId;
    const firstSource = { ...source };
    personId = await seedContact(fixture, {
      firmId: firmB,
      fullName: "Original B correspondent",
    });
    expect(
      (await post("/crm/people/bridge", command({ contactIds: [personId] })))
        .status,
    ).toBe(200);
    expect(
      (
        await post(
          "/crm/people/source/add",
          command({
            personId,
            sourceKey: "independent-B",
            excerpt: "I will prepare the repair summary by October 12.",
            occurredAt: "2026-10-01T14:00:00Z",
          }),
        )
      ).status,
    ).toBe(200);
    const bPage = (await post("/crm/people/read", { personId })).body as {
      sources: {
        workspaceId: string;
        sourceId: string;
        revision: number;
        contentHash: string;
      }[];
    };
    const bSource = bPage.sources[0]!;
    source = {
      workspaceId: bSource.workspaceId,
      sourceId: bSource.sourceId,
      revision: bSource.revision,
      contentHash: bSource.contentHash,
      kind: "selected_note",
      locator: null,
    };
    const second = await process("fixture-v2", 1);
    const bReview = command({
      source,
      claimId: second.claim.claimId,
      claimRevision: 1,
      claimHash: second.claim.claimHash,
      contextHash: second.generation.contextHash,
      expectedDecisionRevision: 0,
      expectedCommitmentRevision: 0,
      classification: "internal_promise",
      actor: "self",
      actionLabel: "Prepare permitted B summary",
      due: {
        kind: "date",
        date: "2026-10-12",
        zone: "America/Chicago",
        expression: "by October 12",
      },
    });
    expect((await post("/crm/commitments/review", bReview)).status).toBe(200);
    await runOnce(fixture.db, {
      registry,
      owner: "independent-B-projector",
      limit: 20,
    });
    const secondRead = await post("/crm/commitments/read", {
      scope: { kind: "person", personId },
      limit: 50,
    });
    expect(secondRead.status).toBe(200);
    const secondTask = (
      secondRead.body as { items: { task: { taskId: string } }[] }
    ).items[0]!.task.taskId;
    const both = await get("/today/actions/v2");
    expect(both.status).toBe(200);
    expect(
      (both.body as { actions: { kind: string }[] }).actions.filter(
        (item) => item.kind === "promise",
      ),
    ).toHaveLength(2);
    // Captured A remains assigned. Only the source's later, actual current C
    // authority changes; it must not be inferred as semantic claim context.
    const firmC = await seedFirm(fixture, {
      name: "Current C authority",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    await fixture.db.query(
      "UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2",
      [source.workspaceId, firstPersonId, firmC],
    );
    expect(
      (await post("/crm/processing/source/read", firstSource)).status,
    ).toBe(200);
    await fixture.db.query(
      "UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2",
      [source.workspaceId, firmC, fixture.alpha.admin.userId],
    );
    expect(
      (await post("/crm/processing/source/read", firstSource)).status,
    ).toBe(404);
    const remaining = await get("/today/actions/v2");
    expect(remaining.status).toBe(200);
    expect(remaining.body).toMatchObject({
      actions: [{ kind: "promise", target: { taskId: secondTask } }],
    });
    expect(JSON.stringify(remaining.body)).not.toContain(firstTask);
    expect(JSON.stringify(remaining.body)).not.toContain("Private A promise");
    expect(
      (
        await post(
          "/crm/commitments/complete",
          command({ taskId: secondTask, expectedVersion: 1 }),
        )
      ).status,
    ).toBe(200);
  } finally {
    await fixture.stop();
  }
});
