import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { z } from "zod";
import { dispatch } from "../../src/server.ts";
import { type AuthFixture } from "./authFixture.ts";
import { issueSessionFor } from "./sessionFixture.ts";
import { setupEvaluationCase } from "./askEvaluationFixture.ts";
import { createNativeCrmMailEvidence } from "@fss/domain/crm/nativeMailEvidence.ts";
import {
  categorySchema,
  frozenCorpusSchema,
  frozenSuiteSchema,
  frozenSplitSchema,
} from "../../../../tools/ask-evaluation/contracts.ts";
import {
  evaluationHash,
  originalTextHash,
} from "../../../../tools/ask-evaluation/corpus.ts";
import { DEVELOPMENT_COMPARISON_LABELS } from "../../../../tools/ask-evaluation/labels.ts";
const labelSchema = z.strictObject({
  caseId: z.string(),
  category: categorySchema,
  sourceKind: z.enum([
    "selected_note",
    "mail",
    "call_transcript",
    "meeting_transcript",
  ]),
  identityName: z.string(),
  originalText: z.string(),
  query: z.string(),
  relevantGrade: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  expectedOpenOpportunities: z.number().int().min(0).nullable(),
  acceptableClaimText: z.array(z.string()),
  forbiddenClaimText: z.array(z.string()),
  lifecycleScenario: z.enum([
    "none",
    "delete_before",
    "delete_during",
    "reassign_during",
    "revision_during",
    "audit_refusal",
  ]),
  sourceLabels: z
    .array(
      z.strictObject({
        slot: z.string(),
        originalText: z.string(),
        relevanceGrade: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      }),
    )
    .optional(),
});

/** Prepare and freeze actual copies only; caller keeps this disposable fixture alive for gated evaluation. */
export async function prepareEvaluationSuite(fixture: AuthFixture) {
  const raw = await readFile(
    new URL(
      "../../../../tools/ask-evaluation/labels.holdout.json",
      import.meta.url,
    ),
    "utf8",
  );
  const sealed = z
    .strictObject({
      version: z.literal("synthetic-labels-v1"),
      state: z.literal("sealed_until_root_decision_freeze"),
      labels: z.array(labelSchema).length(40),
    })
    .parse(JSON.parse(raw));
  const development = DEVELOPMENT_COMPARISON_LABELS.map((label) =>
    labelSchema.parse(label),
  );
  const all = [...development, ...sealed.labels];
  expect(development).toHaveLength(80);
  expect(new Set(all.map((label) => label.caseId)).size).toBe(120);
  const originalSets = [development, sealed.labels].map(
    (labels) =>
      new Set(
        labels.flatMap((label) =>
          (label.sourceLabels ?? [{ originalText: label.originalText }]).map(
            (source) => originalTextHash(source.originalText),
          ),
        ),
      ),
  );
  expect([...originalSets[0]!].some((hash) => originalSets[1]!.has(hash))).toBe(
    false,
  );
  for (const labels of [development, sealed.labels]) {
    expect(new Set(labels.map((label) => label.sourceKind)).size).toBe(4);
    expect(new Set(labels.map((label) => label.category)).size).toBe(8);
  }
  const token = (
    await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
  ).accessToken;
  const paths: string[] = [];
  const post = (path: string, body: unknown) => {
    paths.push(path);
    return dispatch(
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
        crmMailEvidence: createNativeCrmMailEvidence(),
      },
    );
  };
  const bindings = [],
    caseCorpora = [];
  for (const [index, label] of all.entries()) {
    const { firmId, copies, opportunityRecords } = await setupEvaluationCase(
      fixture,
      post,
      (() => {
        const { sourceLabels, ...required } = label;
        return {
          ...required,
          ...(sourceLabels === undefined ? {} : { sourceLabels }),
        };
      })(),
      index,
    );
    const split = index < 80 ? "development" : "holdout";
    const definition = {
      id: `${label.caseId}_corpus`,
      fixtureVersion: "synthetic-v1",
      sources: copies.map((copy) => ({
        id: `${label.caseId}_source_${copy.slot}`,
        kind: label.sourceKind,
        setupId: `synthetic_${label.sourceKind === "mail" ? "copied_mail" : label.sourceKind}`,
        originalSha256: copy.contentHash,
        windows: [
          {
            id: `${label.caseId}_window_${copy.slot}`,
            source: copy.source,
            textSha256: originalTextHash(copy.text),
            chunkerVersion: "lexical-original-v1",
            ordinal: copy.ordinal,
          },
        ],
      })),
      cases: [
        {
          id: label.caseId,
          category: label.category,
          actorFixtureId: `${label.caseId}_actor`,
          corpusId: `${label.caseId}_corpus`,
          request:
            label.expectedOpenOpportunities === null
              ? {
                  operation: "passages",
                  scope: {
                    sources: copies.map((copy) => ({
                      workspaceId: copy.source.workspaceId,
                      sourceId: copy.source.sourceId,
                      kind: copy.source.kind,
                      revision: copy.source.revision,
                      contentHash: copy.source.contentHash,
                      locator: null,
                    })),
                  },
                  query: label.query,
                  limit: 50,
                }
              : {
                  operation: "opportunities",
                  scope: { firmId },
                  status: "open",
                  limit: 20,
                },
          relevance: (
            label.sourceLabels ?? [
              { slot: "original", relevanceGrade: label.relevantGrade },
            ]
          ).map((gold) => ({
            windowId: `${label.caseId}_window_${gold.slot}`,
            grade: gold.relevanceGrade,
          })),
          acceptableClaims:
            label.acceptableClaimText.length === 0
              ? []
              : [
                  {
                    id: `${label.caseId}_claim`,
                    acceptableTextVariants: label.acceptableClaimText,
                    supportedBy: [`${label.caseId}_window_original`],
                    forbiddenTextVariants: label.forbiddenClaimText,
                  },
                ],
          mustAbstain: label.lifecycleScenario !== "none",
          expectedRefusal:
            label.lifecycleScenario === "none"
              ? null
              : {
                  stage: "final_read",
                  code: "source_unavailable",
                  scenario: label.lifecycleScenario,
                },
          exactExpected:
            label.expectedOpenOpportunities === null
              ? null
              : {
                  operation: "opportunities",
                  scope: { firmId },
                  dateBasis: "opportunity_opened_at",
                  count: String(label.expectedOpenOpportunities),
                  records: opportunityRecords,
                  truncated: false,
                  coverage: {
                    scope: "current_permitted_crm_state",
                    acquisition: "unverified",
                    semantic: "not_requested",
                  },
                },
          labelVersion: "independent-v1",
          labelAuthoringState: "independent_before_candidate_outputs",
          lifecycleScenario: label.lifecycleScenario,
        },
      ],
    };
    const parsed = frozenCorpusSchema
      .omit({ corpusSha256: true })
      .parse(definition);
    const corpus = frozenCorpusSchema.parse({
      ...parsed,
      corpusSha256: evaluationHash(parsed),
    });
    bindings.push({
      caseId: label.caseId,
      split,
      corpusSha256: corpus.corpusSha256,
      sourceManifestSha256: evaluationHash(corpus.sources),
      labelSha256: evaluationHash(label),
    });
    caseCorpora.push({ split, corpus, label });
  }
  const splitDefinition = {
    developmentCaseIds: development.map((label) => label.caseId),
    holdoutCaseIds: sealed.labels.map((label) => label.caseId),
    labelSha256: evaluationHash(all),
  };
  const split = frozenSplitSchema.parse({
    ...splitDefinition,
    splitSha256: evaluationHash(splitDefinition),
  });
  const suiteDefinition = {
    version: "ask-evaluation-suite-v1",
    suiteId: "synthetic_full_suite",
    fixtureVersion: "synthetic-v1",
    caseBindings: bindings,
    split,
  };
  const suite = frozenSuiteSchema.parse({
    ...suiteDefinition,
    suiteSha256: evaluationHash(suiteDefinition),
  });
  const devSources = caseCorpora
    .filter((row) => row.split === "development")
    .flatMap((row) =>
      row.corpus.sources.flatMap((source) =>
        source.windows.map((window) => window.source.sourceId),
      ),
    );
  const heldSources = caseCorpora
    .filter((row) => row.split === "holdout")
    .flatMap((row) =>
      row.corpus.sources.flatMap((source) =>
        source.windows.map((window) => window.source.sourceId),
      ),
    );
  expect(new Set([...devSources, ...heldSources]).size).toBe(360);
  expect(heldSources.some((id) => devSources.includes(id))).toBe(false);
  expect(paths.filter((path) => path === "/ask/read")).toHaveLength(0);
  const receipt = {
    state: "canonical_preparation_only_before_candidate_outputs",
    suite,
    caseCorpora,
    sourceManifestSha256: evaluationHash(
      caseCorpora.map((row) => row.corpus.sources),
    ),
    sealedLabelFileSha256: createHash("sha256").update(raw).digest("hex"),
    developmentCaseCount: 80,
    holdoutCaseCount: 40,
    copiedWindowCount: 360,
    holdoutRetrievalExecuted: false,
    holdoutCandidateExecuted: false,
    modelCalls: 0,
    realCalls: 0,
    activationAllowed: false,
  };
  return { receipt, post };
}
