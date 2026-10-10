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

it("preserves capture-time legacy ACL after current association changes without inventing a firm subject", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const adminToken = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: "POST",
          path,
          query: new URLSearchParams(),
          headers: {
            authorization: `Bearer ${path === "/crm/processing/purpose/save" || path.startsWith("/retention/") ? adminToken : token}`,
          },
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
    const firmA = await seedFirm(fixture, {
      name: "Captured legacy A",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const firmB = await seedFirm(fixture, {
      name: "Current legacy B",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const personId = await seedContact(fixture, {
      firmId: firmA,
      fullName: "Legacy private owner",
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
            sourceKey: "legacy-acl-source",
            excerpt: "We need help coordinating repairs.",
            occurredAt: "2026-10-01T14:00:00Z",
          }),
        )
      ).status,
    ).toBe(200);
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
        crmExtraction: { allowControlledEvaluation:true,
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
                  interpretation: "Needs repair coordination",
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
    const corrected = await post(
      "/crm/evidence/decide",
      command({
        source,
        claimId: first.claim.claimId,
        claimRevision: 1,
        claimHash: first.claim.claimHash,
        contextHash: first.generation.contextHash,
        expectedDecisionRevision: 0,
        action: "correct",
        correctedInterpretation: "Repairs were discussed in October",
      }),
    );
    const anchorId = (corrected.body as { result: { anchorId: string } }).result
      .anchorId;
    const historyInput = {
      kind: source.kind,
      sourceId: source.sourceId,
      anchorId,
    };
    const before = await post(
      "/crm/evidence/decision/history/read",
      historyInput,
    );
    expect(before.body).toMatchObject({
      originalEventAt: "2026-10-01T14:00:00.000Z",
      originalObservedAt: expect.any(String),
      decisions: [{ decisionAt: expect.any(String) }],
    });
    expect(first.claim.context.firmIds).toEqual([]);
    const persisted = (
      await fixture.db.query(
        "SELECT to_jsonb(a)->'original_access_closure' AS original_access_closure FROM crm_claim_review_anchors a WHERE workspace_id=$1 AND id=$2",
        [source.workspaceId, anchorId],
      )
    ).rows[0];
    expect(persisted?.["original_access_closure"]).toEqual({
      firmIds: [firmA],
      personIds: [personId],
    });
    // Controlled fixture association drift, followed by loss of the original firm's authority.
    await fixture.db.query(
      "UPDATE contacts SET firm_id=$3 WHERE workspace_id=$1 AND id=$2",
      [source.workspaceId, personId, firmB],
    );
    // A real second connection holds the original authority while the protected
    // public history read waits, then commits reassignment before publication.
    const readerPid = (
      await fixture.db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
    ).rows[0]!.pid;
    const writer = await fixture.database.appRuntimeSession();
    await writer.query("RESET ROLE");
    await writer.query("BEGIN");
    await writer.query(
      "SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
      [source.workspaceId, firmA],
    );
    const pending = post("/crm/evidence/decision/history/read", historyInput);
    let waited = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = (
        await writer.query<{ waiting: boolean }>(
          "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
          [readerPid],
        )
      ).rows[0];
      if (state?.waiting === true) {
        waited = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await writer.query(
      "UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2",
      [source.workspaceId, firmA, fixture.alpha.admin.userId],
    );
    await writer.query("COMMIT");
    expect(waited).toBe(true);
    expect((await pending).status).toBe(404);
    expect((await post("/crm/people/read", { personId })).body).toMatchObject({
      person: { firm: { firmId: firmB } },
      sources: [],
    });
    expect(
      (
        await post("/crm/processing/source/read", {
          ...source,
          locator: "text:0:12",
        })
      ).status,
    ).toBe(404);
    expect(
      (await post("/crm/evidence/decision/history/read", historyInput)).status,
    ).toBe(404);
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
    expect(shown.redacts["crm_selected_sources"]).toBe(1);
    expect(shown.redacts["crm_claim_review_anchors"]).toBe(1);
    expect(
      (
        await post(
          "/retention/deletions/commit",
          command({
            requestId: shown.requestId,
            previewHash: shown.previewHash,
          }),
        )
      ).status,
    ).toBe(200);
    const erased = (
      await fixture.db.query(
        "SELECT availability,excerpt FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2",
        [source.workspaceId, source.sourceId],
      )
    ).rows[0];
    expect(erased).toEqual({ availability: "deleted", excerpt: null });
  } finally {
    await fixture.stop();
  }
});
