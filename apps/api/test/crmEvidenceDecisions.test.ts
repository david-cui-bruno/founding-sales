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

it("preserves a dated human confirmation on equivalent reprocessing with a new physical claim", async () => {
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
        excerpt: "We need help coordinating repairs.",
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
    const decided = await post(
      "/crm/evidence/decide",
      command({
        source,
        claimId: first.claim.claimId,
        claimRevision: first.claim.claimRevision,
        claimHash: first.claim.claimHash,
        contextHash: first.generation.contextHash,
        expectedDecisionRevision: 0,
        action: "confirm",
      }),
    );
    expect(decided.status).toBe(200);
    const before = await post("/crm/evidence/read", { source });
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      claims: [
        {
          claimId: first.claim.claimId,
          contextHash: first.generation.contextHash,
          effectiveState: "confirmed",
          decisionRevision: 1,
          decision: { action: "confirm" },
        },
      ],
    });
    const dated = before.body as {
      claims: { anchorId: string; decision: { decisionAt: string } }[];
    };
    const second = await process("fixture-v2", 1);
    expect(second.claim.claimId).not.toBe(first.claim.claimId);
    const after = await post("/crm/evidence/read", { source });
    expect(after.body).toMatchObject({
      claims: [
        {
          claimId: second.claim.claimId,
          anchorId: dated.claims[0]!.anchorId,
          effectiveState: "confirmed",
          decisionRevision: 1,
          decision: {
            action: "confirm",
            decisionAt: dated.claims[0]!.decision.decisionAt,
          },
          source: { occurredAt: "2026-10-01T14:00:00.000Z" },
        },
      ],
    });
  } finally {
    await fixture.stop();
  }
});

it("refuses replay of a human decision after its exact source is deleted", async () => {
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
        excerpt: "We need help coordinating repairs.",
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
    const decision = command({
      source,
      claimId: first.claim.claimId,
      claimRevision: first.claim.claimRevision,
      claimHash: first.claim.claimHash,
      contextHash: first.generation.contextHash,
      expectedDecisionRevision: 0,
      action: "correct",
      correctedInterpretation: "Only emergency repairs need coordination",
      rationale: "Human reviewed the complete note",
    });
    const accepted = await post("/crm/evidence/decide", decision);
    expect(accepted.status).toBe(200);
    const anchorId = (accepted.body as { result: { anchorId: string } }).result
      .anchorId;
    const historyInput = {
      kind: source.kind,
      sourceId: source.sourceId,
      anchorId,
    };
    expect(
      (await post("/crm/evidence/decision/history/read", historyInput)).body,
    ).toMatchObject({
      availability: "available",
      decisions: [
        {
          action: "correct",
          revision: 1,
          correctedInterpretation: "Only emergency repairs need coordination",
          rationale: "Human reviewed the complete note",
          redacted: false,
        },
      ],
    });
    expect((await post("/crm/evidence/decide", decision)).body).toMatchObject({
      status: "accepted",
      replayed: true,
      result: { decisionRevision: 1 },
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
    const historyIndex = await post("/crm/evidence/decision/history/list", {
      kind: source.kind,
      sourceId: source.sourceId,
      limit: 1,
    });
    expect(historyIndex.status).toBe(200);
    expect(historyIndex.body).toMatchObject({
      anchors: [
        { anchorId, currentDecisionRevision: 1, basis: "deleted_redacted" },
      ],
      nextAfterId: null,
    });
    expect((await post("/crm/evidence/read", { source })).status).toBe(404);
    expect((await post("/crm/evidence/decide", decision)).status).toBe(404);
    const deletedHistory = await post(
      "/crm/evidence/decision/history/read",
      historyInput,
    );
    expect(deletedHistory.status).toBe(200);
    expect(deletedHistory.body).toMatchObject({
      availability: "deleted",
      decisions: [
        {
          action: "correct",
          revision: 1,
          correctedInterpretation: null,
          rationale: null,
          redacted: true,
          decisionAt: expect.any(String),
        },
      ],
    });
    expect(JSON.stringify(deletedHistory.body)).not.toContain("Only emergency");
    expect(JSON.stringify(deletedHistory.body)).not.toContain("Human reviewed");
    expect(JSON.stringify(deletedHistory.body)).not.toContain("We need help");
    expect(
      (
        await post(
          "/crm/people/source/restore",
          command({ personId, sourceId: source.sourceId, expectedRevision: 2 }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          "/crm/people/source/recapture",
          command({
            personId,
            sourceId: source.sourceId,
            expectedRevision: 3,
            excerpt: "We need help coordinating repairs.",
            occurredAt: "2026-10-01T14:00:00Z",
          }),
        )
      ).status,
    ).toBe(200);
    const recaptured = await post("/crm/people/read", { personId });
    const latestSource = (
      recaptured.body as { sources: (typeof selected)[] }
    ).sources.find((value) => value.sourceId === source.sourceId)!;
    source.revision = latestSource.revision;
    source.contentHash = latestSource.contentHash;
    await process("fixture-v2", 1);
    expect((await post("/crm/evidence/read", { source })).body).toMatchObject({
      claims: [
        { effectiveState: "unreviewed", decisionRevision: 0, decision: null },
      ],
    });
    expect(
      (await post("/crm/evidence/decision/history/read", historyInput)).body,
    ).toMatchObject({
      availability: "available",
      basis: "deleted_redacted",
      decisions: [
        {
          revision: 1,
          correctedInterpretation: null,
          rationale: null,
          redacted: true,
        },
      ],
    });
  } finally {
    await fixture.stop();
  }
});

it("requires fresh human review when reprocessing materially changes the interpretation", async () => {
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
        excerpt: "We need help coordinating repairs.",
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
    async function process(
      modelVersion: string,
      expectedRevision: number,
      interpretation: string,
    ) {
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
                  kind: "need",
                  status: "stated",
                  interpretation,
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
    const first = await process("fixture-v1", 0, "Needs repair coordination");
    expect(
      (
        await post(
          "/crm/evidence/decide",
          command({
            source,
            claimId: first.claim.claimId,
            claimRevision: 1,
            claimHash: first.claim.claimHash,
            contextHash: first.generation.contextHash,
            expectedDecisionRevision: 0,
            action: "confirm",
          }),
        )
      ).status,
    ).toBe(200);
    const replacement = await process(
      "fixture-v2",
      1,
      "Needs an emergency repair vendor",
    );
    const review = await post("/crm/evidence/read", { source });
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({
      claims: [
        {
          claimId: replacement.claim.claimId,
          effectiveState: "unreviewed",
          decisionRevision: 0,
          decision: null,
          reviewRequired: true,
        },
      ],
      reviewedHistory: [
        {
          interpretation: "Needs repair coordination",
          effectiveState: "confirmed",
          source: { occurredAt: "2026-10-01T14:00:00.000Z" },
        },
      ],
    });
    expect(
      (
        await post(
          "/crm/evidence/decide",
          command({
            source,
            claimId: first.claim.claimId,
            claimRevision: 1,
            claimHash: first.claim.claimHash,
            contextHash: first.generation.contextHash,
            expectedDecisionRevision: 1,
            action: "correct",
            correctedInterpretation: "Repair coordination is seasonal",
          }),
        )
      ).status,
    ).toBe(200);
    expect((await post("/crm/evidence/read", { source })).body).toMatchObject({
      claims: [
        { claimId: replacement.claim.claimId, effectiveState: "unreviewed" },
      ],
      reviewedHistory: [
        {
          claimId: first.claim.claimId,
          effectiveState: "corrected",
          decisionRevision: 2,
          decision: {
            correctedInterpretation: "Repair coordination is seasonal",
          },
        },
      ],
    });
    expect((await post("/crm/evidence/read", { source })).body).toMatchObject({
      projection: {
        scope: "bounded_source_page",
        counts: {
          current: 1,
          reviewedHistory: 1,
          confirmed: 0,
          dismissed: 0,
          corrected: 1,
          unreviewed: 1,
          reviewRequired: 1,
        },
        truncated: false,
        revisionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
  } finally {
    await fixture.stop();
  }
});

it("keeps original interpretation and dated decision history while refusing a stale correction", async () => {
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
        excerpt: "We need help coordinating repairs.",
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
    const target = {
      source,
      claimId: first.claim.claimId,
      claimRevision: 1,
      claimHash: first.claim.claimHash,
      contextHash: first.generation.contextHash,
    };
    const confirmation = command({
      ...target,
      expectedDecisionRevision: 0,
      action: "confirm",
    });
    expect((await post("/crm/evidence/decide", confirmation)).status).toBe(200);
    const correction = {
      ...target,
      action: "correct",
      correctedInterpretation: "Only emergency repairs need coordination",
      rationale: "Human distinction",
    };
    expect(
      (
        await post(
          "/crm/evidence/decide",
          command({ ...correction, expectedDecisionRevision: 0 }),
        )
      ).body,
    ).toMatchObject({
      status: "refused",
      reason: "decision_revision_conflict",
    });
    expect(
      (
        await post(
          "/crm/evidence/decide",
          command({ ...correction, expectedDecisionRevision: 1 }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await post("/crm/evidence/decide", confirmation)).body,
    ).toMatchObject({ status: "refused", reason: "decision_changed" });
    const reviewed = await post("/crm/evidence/read", { source });
    expect(reviewed.body).toMatchObject({
      claims: [
        {
          interpretation: "Needs repair coordination",
          quote: "We need help",
          effectiveState: "corrected",
          decisionRevision: 2,
          decision: {
            action: "correct",
            correctedInterpretation: "Only emergency repairs need coordination",
          },
          decisionHistory: [
            { revision: 2, action: "correct" },
            { revision: 1, action: "confirm" },
          ],
          decisionHistoryTruncated: false,
          source: { occurredAt: "2026-10-01T14:00:00.000Z" },
        },
      ],
    });
  } finally {
    await fixture.stop();
  }
});

it("resolves an explicit conflicting group without erasing either dated source", async () => {
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
        excerpt: "We need help coordinating repairs.",
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

    const firstSource = source;
    const first = await process("fixture-v1", 0);
    await post(
      "/crm/people/source/add",
      command({
        personId,
        sourceKey: "later-opposing-account",
        excerpt: "We need help with a different repair policy.",
        occurredAt: "2026-09-25T14:00:00Z",
      }),
    );
    const latest = await post("/crm/people/read", { personId });
    const other = (
      latest.body as { sources: (typeof selected)[] }
    ).sources.find((value) => value.sourceId !== firstSource.sourceId)!;
    source = {
      ...source,
      sourceId: other.sourceId,
      revision: other.revision,
      contentHash: other.contentHash,
    };
    const second = await process("fixture-v2", 1);
    const member = (entry: typeof first, exact: typeof source) => ({
      source: exact,
      claimId: entry.claim.claimId,
      claimRevision: 1,
      claimHash: entry.claim.claimHash,
      contextHash: entry.generation.contextHash,
      expectedDecisionRevision: 0,
    });
    const saveCommand = command({
      expectedConflictRevision: 0,
      members: [member(first, firstSource), member(second, source)],
    });
    const saved = await post("/crm/evidence/conflict/save", saveCommand);
    expect(saved.status).toBe(200);
    const conflictId = (saved.body as { result: { conflictId: string } }).result
      .conflictId;
    const discovered = await post("/crm/evidence/conflict/list", {
      kind: firstSource.kind,
      sourceId: firstSource.sourceId,
      limit: 1,
    });
    expect(discovered.status).toBe(200);
    expect(discovered.body).toMatchObject({
      conflicts: [{ conflictId, revision: 1, state: "open" }],
      nextAfterId: null,
    });
    const opened = await post("/crm/evidence/conflict/read", { conflictId });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({
      conflictId,
      revision: 1,
      state: "open",
      members: expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({
            sourceId: firstSource.sourceId,
            occurredAt: "2026-10-01T14:00:00.000Z",
          }),
        }),
        expect.objectContaining({
          source: expect.objectContaining({
            sourceId: source.sourceId,
            occurredAt: "2026-09-25T14:00:00.000Z",
          }),
        }),
      ]),
    });
    expect(
      (
        await post(
          "/crm/evidence/conflict/resolve",
          command({
            conflictId,
            expectedConflictRevision: 1,
            resolution: "keep_both",
            rationale: "Both accounts are retained pending clarification",
          }),
        )
      ).status,
    ).toBe(200);
    const resolved = await post("/crm/evidence/conflict/read", { conflictId });
    expect(resolved.body).toMatchObject({
      revision: 2,
      state: "resolved",
      resolution: "keep_both",
      members: expect.any(Array),
    });
    expect((resolved.body as { members: unknown[] }).members).toHaveLength(2);
    expect(
      (await post("/crm/evidence/conflict/save", saveCommand)).status,
    ).toBe(409);
  } finally {
    await fixture.stop();
  }
});
