import { evaluationFusion } from "../../../tools/ask-evaluation/fusion.ts";
import {
  createFakeEvaluationEmbedding,
  createFakeEvaluationAnswer,
} from "../../../tools/ask-evaluation/fakeAdapters.ts";
import { expect, it } from "vitest";
import { createTestDatabase } from "@fss/domain/db/testing/testDatabase.ts";
import { createEvaluationVectorPort } from "../../../tools/ask-evaluation/vectors.ts";
import {
  evaluationTextGroupId,
  rankingOutputSchema,
  type EvaluationRankingInput,
} from "../../../tools/ask-evaluation/contracts.ts";

function example(): EvaluationRankingInput {
  return {
    mode: "fake_only",
    dimensions: 2,
    k: 10,
    rrfConstant: 60,
    windows: [
      { id: "aligned", ordinal: 0, text: "Aligned" },
      { id: "orthogonal", ordinal: 1, text: "Orthogonal" },
      { id: "opposite", ordinal: 2, text: "Opposite" },
    ],
    embeddings: [
      { id: "aligned", vector: [1, 0] },
      { id: "orthogonal", vector: [0, 1] },
      { id: "opposite", vector: [-1, 0] },
    ],
    queryVector: [1, 0],
    lexicalGroupRanks: [],
  };
}
it("ranks independently worked positive, orthogonal and negative cosine on disposable PostgreSQL", async () => {
  const database = await createTestDatabase();
  try {
    const result = await createEvaluationVectorPort(database.session).rank(
      example(),
    );
    expect(rankingOutputSchema.safeParse(result).success).toBe(true);
    expect(
      result.vector.ranked.map((row) => ({
        ids: row.windowIds,
        score: row.score,
      })),
    ).toEqual([
      { ids: ["aligned"], score: 1 },
      { ids: ["orthogonal"], score: 0 },
      { ids: ["opposite"], score: -1 },
    ]);
    expect(result.rawWindowScores).toEqual([
      { windowId: "aligned", score: 1 },
      { windowId: "orthogonal", score: 0 },
      { windowId: "opposite", score: -1 },
    ]);
    expect(result.sqlObservation).toMatchObject({
      state: "executed",
      inputRows: 3,
      evaluatedWindowScores: 3,
      databaseLoad: { state: "not_measured" },
    });
  } finally {
    await database.drop();
  }
});
it("fuses group ranks once per list with an independently worked reciprocal-rank tie", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.lexicalGroupRanks = [
      { groupId: evaluationTextGroupId("Orthogonal"), rank: 1 },
      { groupId: evaluationTextGroupId("Aligned"), rank: 2 },
    ];
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.hybrid.ranked.map((row) => row.windowIds)).toEqual([
      ["aligned"],
      ["orthogonal"],
      ["opposite"],
    ]);
    expect(result.hybrid.ranked[0]?.score).toBeCloseTo(0.0325224748810153, 14);
    expect(result.hybrid.ranked[1]?.score).toBeCloseTo(0.0325224748810153, 14);
    expect(result.hybrid.ranked[2]?.score).toBeCloseTo(
      0.015873015873015872,
      14,
    );
  } finally {
    await database.drop();
  }
});
it("reports a zero-norm vector as failure rather than a ranked match and allows the next run", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.queryVector = [0, 0];
    const port = createEvaluationVectorPort(database.session);
    const failed = await port.rank(input);
    expect(failed.vector.qualityScoringState).toBe("failed");
    expect(failed.vector.failures).toEqual([
      { code: "vector_zero_norm", stage: "vector_sql" },
    ]);
    expect(failed.sqlObservation.state).toBe("refused_before_sql");
    expect((await port.rank(example())).vector.ranked[0]?.windowIds).toEqual([
      "aligned",
    ]);
  } finally {
    await database.drop();
  }
});
it("refuses embedding dimensions that differ from the frozen query dimension", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.embeddings[0]!.vector = [1];
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.vector.failures).toEqual([
      { code: "vector_dimension_mismatch", stage: "vector_sql" },
    ]);
    expect(result.sqlObservation.state).toBe("refused_before_sql");
  } finally {
    await database.drop();
  }
});
it("refuses finite inputs whose intermediate squares overflow, then recovers on the same connection", async () => {
  const database = await createTestDatabase();
  try {
    const port = createEvaluationVectorPort(database.session);
    const input = example();
    input.embeddings[0]!.vector = [1e308, 1];
    const result = await port.rank(input);
    expect(result.vector.failures).toEqual([
      { code: "vector_overflow", stage: "vector_sql" },
    ]);
    expect(result.sqlObservation.state).toBe("refused_before_sql");
    expect((await port.rank(example())).vector.ranked).toHaveLength(3);
  } finally {
    await database.drop();
  }
});
it("refuses invented embedding identities instead of joining them to permitted windows", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.embeddings[0]!.id = "invented";
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.vector.failures).toEqual([
      { code: "invalid_vector", stage: "vector_sql" },
    ]);
    expect(result.rawWindowScores).toEqual([]);
    expect(result.sqlObservation.state).toBe("refused_before_sql");
  } finally {
    await database.drop();
  }
});
it("reports unknown lexical group IDs explicitly instead of inventing fusion membership", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.lexicalGroupRanks = [{ groupId: "invented", rank: 1 }];
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.hybrid.qualityScoringState).toBe("failed");
    expect(result.hybrid.failures).toEqual([
      { code: "invalid_vector", stage: "vector_sql" },
    ]);
    expect(result.sqlObservation.state).toBe("refused_before_sql");
  } finally {
    await database.drop();
  }
});
it("returns explicit invalid-vector failure for nonfinite adapter values rather than throwing", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.embeddings[0]!.vector = [NaN, 1];
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.vector.failures).toEqual([
      { code: "invalid_vector", stage: "vector_sql" },
    ]);
    expect(result.sqlObservation.state).toBe("refused_before_sql");
  } finally {
    await database.drop();
  }
});
it("groups repeated quotations before the top-ten cutoff and retains every member reference", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.windows = Array.from({ length: 12 }, (_, ordinal) => ({
      id: `copy_${ordinal}`,
      ordinal,
      text: ordinal < 11 ? "Repeated evidence" : "Distinct evidence",
    }));
    input.embeddings = input.windows.map((row) => ({
      id: row.id,
      vector: row.ordinal < 11 ? [1, 0] : [0, 1],
    }));
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(
      result.vector.ranked.map((row) => ({
        ids: row.windowIds,
        score: row.score,
      })),
    ).toEqual([
      {
        ids: [
          "copy_0",
          "copy_1",
          "copy_2",
          "copy_3",
          "copy_4",
          "copy_5",
          "copy_6",
          "copy_7",
          "copy_8",
          "copy_9",
          "copy_10",
        ],
        score: 1,
      },
      { ids: ["copy_11"], score: 0 },
    ]);
    expect(result.rawWindowScores).toHaveLength(12);
    expect(result.sqlObservation.evaluatedWindowScores).toBe(12);
  } finally {
    await database.drop();
  }
});
it("reports SQL failure and can rank again after the owning transaction rolls back", async () => {
  const database = await createTestDatabase();
  try {
    // Disposable infrastructure obstacle; behavior is asserted through the ranking port.
    await database.session.query(
      "CREATE TEMP TABLE evaluation_vectors(obstacle integer)",
    );
    const port = createEvaluationVectorPort(database.session);
    const failed = await port.rank(example());
    expect(failed.vector.qualityScoringState).toBe("failed");
    expect(failed.sqlObservation.state).toBe("failed_during_sql");
    expect(failed.sqlObservation.statementsExecuted).toBeGreaterThan(0);
    await database.session.query("DROP TABLE evaluation_vectors");
    expect((await port.rank(example())).vector.ranked).toHaveLength(3);
  } finally {
    await database.drop();
  }
});
it("uses declared fake embedding and answer scripts without adding provider or source authority", async () => {
  const window = {
    id: "worked",
    text: "Independent synthetic text.",
    source: {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      sourceId: "00000000-0000-4000-8000-000000000002",
      kind: "selected_note" as const,
      revision: 1,
      contentHash: "a".repeat(64),
      locator: "text:0:27",
      speaker: null,
      occurredAt: null,
      observedAt: "2026-10-09T00:00:00.000Z",
      completeness: "selected_excerpt" as const,
      availability: "available" as const,
    },
  };
  const embedding = createFakeEvaluationEmbedding({
    version: "worked-v1",
    dimensions: 2,
    vectors: { worked: [1, 0] },
    queryVector: [0, 1],
  });
  const signal = new AbortController().signal;
  expect((await embedding.embed([window], signal)).vectors).toEqual([
    { id: "worked", vector: [1, 0] },
  ]);
  expect(
    (await embedding.embedQuery("Independent query", signal)).vector,
  ).toEqual([0, 1]);
  const answer = createFakeEvaluationAnswer({
    version: "worked-v1",
    answersByQuery: {
      question: {
        claims: [
          { text: "Declared controlled answer.", windowIds: ["worked"] },
        ],
        abstained: false,
      },
    },
  });
  expect(
    await answer.answer({ query: "question", windows: [window] }, signal),
  ).toMatchObject({
    claims: [{ text: "Declared controlled answer.", windowIds: ["worked"] }],
    usage: {
      outcome: "observed",
      calls: 1,
      reservedCents: "0",
      observedCents: "0",
    },
  });
  expect(embedding.kind).toBe("fake");
  expect(answer.id).toBe("fake_answer");
});
it("accepts independently known identical three-dimensional vectors despite binary roundoff", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.dimensions = 3;
    input.queryVector = [1, 1, 1];
    input.embeddings = input.embeddings.map((row) => ({
      id: row.id,
      vector: [1, 1, 1],
    }));
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.vector.qualityScoringState).toBe("scored");
    expect(result.rawWindowScores).toEqual([
      { windowId: "aligned", score: 1 },
      { windowId: "orthogonal", score: 1 },
      { windowId: "opposite", score: 1 },
    ]);
    expect(result.vector.ranked.map((row) => row.windowIds)).toEqual([
      ["aligned"],
      ["orthogonal"],
      ["opposite"],
    ]);
  } finally {
    await database.drop();
  }
});
it("refuses over-limit aggregate UTF8 input instead of staging an oversized corpus", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.windows = Array.from({ length: 201 }, (_, ordinal) => ({
      id: `window_${ordinal}`,
      ordinal,
      text: "😀".repeat(1000),
    }));
    input.embeddings = input.windows.map((row) => ({
      id: row.id,
      vector: [1, 0],
    }));
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.vector.failures).toEqual([
      { code: "corpus_bound", stage: "vector_sql" },
    ]);
    expect(result.sqlObservation.state).toBe("refused_before_sql");
  } finally {
    await database.drop();
  }
});

it("refuses mismatched group membership at the public fusion boundary", async () => {
  const database = await createTestDatabase();
  try {
    const result = await createEvaluationVectorPort(database.session).rank(
      example(),
    );
    const vector = structuredClone(result.vector);
    vector.ranked[0]!.windowIds = ["invented"];
    const fused = evaluationFusion.fuse({
      lexical: { ...result.vector, path: "lexical", ranked: [] },
      vector,
      groups: result.groups,
      rrfConstant: 60,
      k: 10,
    });
    expect(fused.qualityScoringState).toBe("failed");
    expect(fused.ranked).toEqual([]);
    expect(fused.failures).toEqual([
      { code: "invalid_vector", stage: "fusion" },
    ]);
  } finally {
    await database.drop();
  }
});
it.each([
  [
    "duplicate embedding identity",
    (input: EvaluationRankingInput) => {
      input.embeddings[1]!.id = "aligned";
    },
  ],
  [
    "missing embedding",
    (input: EvaluationRankingInput) => {
      input.embeddings.pop();
    },
  ],
  [
    "duplicate encounter ordinal",
    (input: EvaluationRankingInput) => {
      input.windows[1]!.ordinal = 0;
    },
  ],
  [
    "infinite input",
    (input: EvaluationRankingInput) => {
      input.queryVector = [Infinity, 0];
    },
  ],
  [
    "query dimensions",
    (input: EvaluationRankingInput) => {
      input.queryVector = [1];
    },
  ],
  [
    "duplicate lexical contribution",
    (input: EvaluationRankingInput) => {
      input.lexicalGroupRanks = [
        { groupId: evaluationTextGroupId("Aligned"), rank: 1 },
        { groupId: evaluationTextGroupId("Aligned"), rank: 2 },
      ];
    },
  ],
] as const)("explicitly refuses %s", async (_name, change) => {
  const database = await createTestDatabase();
  try {
    const input = example();
    change(input);
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.vector.qualityScoringState).toBe("failed");
    expect(result.vector.failures).toHaveLength(1);
    expect(result.sqlObservation.state).toBe("refused_before_sql");
  } finally {
    await database.drop();
  }
});
it("uses the best member score while retaining lower-scoring duplicate citations", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.windows[1]!.text = "  ALIGNED ";
    input.embeddings[0]!.vector = [0, 1];
    input.embeddings[1]!.vector = [1, 0];
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.vector.ranked[0]).toMatchObject({
      windowIds: ["aligned", "orthogonal"],
      score: 1,
      firstOrdinal: 0,
    });
    expect(result.rawWindowScores.slice(0, 2)).toEqual([
      { windowId: "aligned", score: 0 },
      { windowId: "orthogonal", score: 1 },
    ]);
    expect(result.hybrid.ranked[0]?.score).toBeCloseTo(0.01639344262295082, 14);
  } finally {
    await database.drop();
  }
});
it("scores the maximum bounded window count and UTF8 corpus without cutting members before grouping", async () => {
  const database = await createTestDatabase();
  try {
    const input = example();
    input.dimensions = 1;
    input.queryVector = [1];
    input.windows = Array.from({ length: 1000 }, (_, ordinal) => ({
      id: `window_${ordinal}`,
      ordinal,
      text: "x".repeat(800),
    }));
    input.embeddings = input.windows.map((row) => ({
      id: row.id,
      vector: [1],
    }));
    const result = await createEvaluationVectorPort(database.session).rank(
      input,
    );
    expect(result.vector.qualityScoringState).toBe("scored");
    expect(result.vector.ranked).toHaveLength(1);
    expect(result.vector.ranked[0]?.windowIds).toHaveLength(1000);
    expect(result.rawWindowScores).toHaveLength(1000);
    expect(result.sqlBounds).toMatchObject({
      inputWindows: 1000,
      dimensions: 1,
      returnedVectorGroups: 1,
    });
  } finally {
    await database.drop();
  }
});
it("honors cancellation at the fake adapter boundary without providing a result", async () => {
  const abort = new AbortController();
  abort.abort();
  const port = createFakeEvaluationEmbedding({
    version: "abort-v1",
    dimensions: 2,
    vectors: {},
    queryVector: [1, 0],
  });
  await expect(port.embedQuery("ignored", abort.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});
