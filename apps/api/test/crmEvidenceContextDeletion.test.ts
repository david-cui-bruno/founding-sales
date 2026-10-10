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
import { seedFirm } from "./support/crmSeed.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";

it("deletes original A-bearing evidence after recontextualization while preserving B-only evidence", async () => {
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
    const importedInput = {
      text: "We need help coordinating repairs.",
      subtype: "pasted_text",
      label: "Dated correspondence",
      direction: "unknown",
      occurredAt: "2026-10-01T14:00:00Z",
      participants: [],
      attachments: [],
    };
    const preview = await post("/crm/imports/preview", importedInput);
    const previewHash = (preview.body as { previewHash: string }).previewHash;
    expect(
      (
        await post(
          "/crm/imports/commit",
          command({
            ...importedInput,
            personId,
            firmId: null,
            importKey: "dated-human-history",
            previewHash,
            parserVersion: "selected-v1",
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

    const firmA = await seedFirm(fixture, {
      name: "Original evidence firm A",
      assignedUserId: fixture.alpha.admin.userId,
    });
    const firmB = await seedFirm(fixture, {
      name: "Independent evidence firm B",
      assignedUserId: fixture.alpha.admin.userId,
    });
    const relate = async (firmId: string, exact: typeof source) => {
      const evidence = {
        sourceId: exact.sourceId,
        sourceRevision: exact.revision,
        contentHash: exact.contentHash,
      };
      const saved = await post(
        "/crm/relationships/save",
        command({
          personId,
          firmId,
          status: "current",
          startDate: null,
          endDate: null,
          evidence,
        }),
      );
      expect(saved.status).toBe(200);
      return (
        saved.body as { result: { relationshipId: string; revision: number } }
      ).result;
    };
    const context = async (
      relationship: { relationshipId: string; revision: number },
      exact: typeof source,
    ) => {
      expect(
        (
          await post(
            "/crm/relationships/context/save",
            command({
              personId,
              relationshipId: relationship.relationshipId,
              relationshipRevision: relationship.revision,
              evidence: {
                sourceId: exact.sourceId,
                sourceRevision: exact.revision,
                contentHash: exact.contentHash,
              },
            }),
          )
        ).status,
      ).toBe(200);
    };
    await context(await relate(firmA, source), source);
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
    const originalObservedAt = (before.body as { originalObservedAt: string })
      .originalObservedAt;
    const changedInput = {
      ...importedInput,
      occurredAt: "2026-10-03T14:00:00Z",
    };
    const changedPreview = await post("/crm/imports/preview", changedInput);
    expect(
      (
        await post(
          "/crm/imports/correct",
          command({
            ...changedInput,
            sourceId: source.sourceId,
            expectedSourceRevision: 1,
            expectedMetadataRevision: 1,
            previewHash: (changedPreview.body as { previewHash: string })
              .previewHash,
            parserVersion: "selected-v1",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await post("/crm/evidence/decision/history/read", historyInput)).body,
    ).toMatchObject({
      basis: "source_unavailable",
      originalEventAt: "2026-10-01T14:00:00.000Z",
      originalObservedAt,
    });
    expect((await post("/crm/people/read", { personId })).body).toMatchObject({
      sources: [{ occurredAt: "2026-10-03T14:00:00.000Z" }],
    });
    const originalSource = { ...source };
    const changedSource = { ...source, revision: 2 };
    expect(
      (
        await post(
          "/crm/people/source/add",
          command({
            personId,
            sourceKey: "independent-B",
            excerpt: "We need help coordinating repairs.",
            occurredAt: "2026-10-02T14:00:00Z",
          }),
        )
      ).status,
    ).toBe(200);
    const people = (await post("/crm/people/read", { personId })).body as {
      sources: { sourceId: string; revision: number; contentHash: string }[];
    };
    const independent = people.sources.find(
      (value) => value.sourceId !== originalSource.sourceId,
    )!;
    const sourceB = {
      ...source,
      sourceId: independent.sourceId,
      revision: independent.revision,
      contentHash: independent.contentHash,
    };
    const relationB = await relate(firmB, sourceB);
    await context(relationB, changedSource);
    await context(relationB, sourceB);
    source = sourceB;
    const second = await process("fixture-v2", 1);
    const bDecision = await post(
      "/crm/evidence/decide",
      command({
        source,
        claimId: second.claim.claimId,
        claimRevision: 1,
        claimHash: second.claim.claimHash,
        contextHash: second.generation.contextHash,
        expectedDecisionRevision: 0,
        action: "correct",
        correctedInterpretation: "Independent B history survives",
      }),
    );
    expect(bDecision.status).toBe(200);
    const bHistory = {
      kind: source.kind,
      sourceId: source.sourceId,
      anchorId: (bDecision.body as { result: { anchorId: string } }).result
        .anchorId,
    };
    const terminalPreview = await post(
      "/retention/deletions/preview",
      command({ targetKind: "firm", firmId: firmA }),
    );
    expect(terminalPreview.status).toBe(200);
    const shown = (
      terminalPreview.body as {
        result: {
          requestId: string;
          previewHash: string;
          redacts: Record<string, number>;
        };
      }
    ).result;
    expect(shown.redacts["crm_claim_review_anchors"]).toBe(1);
    expect(shown.redacts["crm_selected_sources"]).toBe(1);
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
    expect((await post("/crm/people/read", { personId })).body).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          sourceId: originalSource.sourceId,
          availability: "deleted",
          excerpt: null,
        }),
        expect.objectContaining({
          sourceId: sourceB.sourceId,
          availability: "available",
          excerpt: "We need help coordinating repairs.",
        }),
      ]),
    });
    expect(
      (await post("/crm/evidence/decision/history/read", historyInput)).body,
    ).toMatchObject({
      basis: "deleted_redacted",
      originalEventAt: null,
      originalObservedAt: null,
      decisions: [{ correctedInterpretation: null, redacted: true }],
    });
    expect(
      (await post("/crm/evidence/decision/history/read", bHistory)).body,
    ).toMatchObject({
      basis: "available",
      decisions: [
        {
          correctedInterpretation: "Independent B history survives",
          redacted: false,
        },
      ],
    });
  } finally {
    await fixture.stop();
  }
});
