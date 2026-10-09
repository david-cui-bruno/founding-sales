import { createHash } from "node:crypto";
import { evaluationFusion } from "./fusion.ts";
import { performance } from "node:perf_hooks";
import {
  withTransaction,
  type QueryResultRowLike,
  type SessionQueryable,
} from "@fss/domain/db/queryable.ts";
import {
  groupEvaluationWindows,
  rankingInputSchema,
  rankingOutputSchema,
  type EvaluationRankingInput,
  type EvaluationRankingOutput,
  type EvaluationVectorPort,
} from "./contracts.ts";

export const evaluationVectorNumericConfiguration = {
  version: "cosine-roundoff-v1",
  roundoffTolerance: 1e-12,
  overflowPolicy: "refuse",
  grouping: "max_member_before_top_k",
} as const;
export const evaluationVectorNumericConfigurationSha256 = createHash("sha256")
  .update(JSON.stringify(evaluationVectorNumericConfiguration))
  .digest("hex");

/** Disposable exact ranking only. Caller owns permitted corpus and publication. */
export function createEvaluationVectorPort(
  session: SessionQueryable,
): EvaluationVectorPort {
  return {
    rank: async (
      raw: EvaluationRankingInput,
    ): Promise<EvaluationRankingOutput> => {
      const parsed = rankingInputSchema.safeParse(raw);
      if (!parsed.success)
        return refused(
          {
            dimensions:
              Number.isInteger(raw.dimensions) &&
              raw.dimensions >= 1 &&
              raw.dimensions <= 4096
                ? raw.dimensions
                : 1,
            windows: [],
          },
          "invalid_vector",
        );
      const input = parsed.data;
      if (
        input.windows.reduce(
          (bytes, window) => bytes + Buffer.byteLength(window.text),
          0,
        ) > 800000
      )
        return refused(input, "corpus_bound");
      if (
        input.queryVector.length !== input.dimensions ||
        input.embeddings.some((row) => row.vector.length !== input.dimensions)
      )
        return refused(input, "vector_dimension_mismatch");
      const ids = new Set(input.windows.map((row) => row.id));
      if (
        ids.size !== input.windows.length ||
        new Set(input.windows.map((row) => row.ordinal)).size !==
          input.windows.length ||
        input.embeddings.length !== ids.size ||
        new Set(input.embeddings.map((row) => row.id)).size !== ids.size ||
        input.embeddings.some((row) => !ids.has(row.id))
      )
        return refused(input, "invalid_vector");
      const groups = groupEvaluationWindows(input.windows);
      if (
        new Set(input.lexicalGroupRanks.map((row) => row.groupId)).size !==
          input.lexicalGroupRanks.length ||
        input.lexicalGroupRanks.some(
          (row, index) =>
            row.rank !== index + 1 ||
            !groups.some((group) => group.groupId === row.groupId),
        )
      )
        return refused(input, "invalid_vector");
      for (const vector of [
        input.queryVector,
        ...input.embeddings.map((row) => row.vector),
      ]) {
        let norm = 0;
        for (const value of vector) {
          norm += value * value;
          if (!Number.isFinite(norm)) return refused(input, "vector_overflow");
        }
        if (norm === 0) return refused(input, "vector_zero_norm");
      }
      for (const row of input.embeddings) {
        let dot = 0;
        for (let index = 0; index < input.dimensions; index++) {
          dot += row.vector[index]! * input.queryVector[index]!;
          if (!Number.isFinite(dot)) return refused(input, "vector_overflow");
        }
      }
      if (
        input.queryVector.every((value) => value === 0) ||
        input.embeddings.some((row) => row.vector.every((value) => value === 0))
      )
        return refused(input, "vector_zero_norm");
      const started = performance.now();
      let rows: { window_id: string; score: number }[];
      let sqlGroups: { group_id: string; score: number }[] = [];
      let statementsExecuted = 0;
      let inputRows = 0;
      let evaluatedWindowScores = 0;
      const observed: SessionQueryable = {
        async query<Row extends QueryResultRowLike>(
          text: string,
          values?: readonly unknown[],
        ) {
          const result = await session.query<Row>(text, values);
          statementsExecuted++;
          return result;
        },
      };
      try {
        rows = await withTransaction(observed, async () => {
          await observed.query(
            "CREATE TEMP TABLE evaluation_vectors(window_id text PRIMARY KEY, embedding double precision[] NOT NULL) ON COMMIT DROP",
          );
          const staged = await observed.query(
            "INSERT INTO evaluation_vectors(window_id,embedding) SELECT id,ARRAY(SELECT jsonb_array_elements_text(vector)::double precision) FROM jsonb_to_recordset($1::jsonb) AS row(id text,vector jsonb)",
            [JSON.stringify(input.embeddings)],
          );
          inputRows = staged.rowCount ?? 0;
          const members = input.windows.map((window) => ({
            windowId: window.id,
            groupId: groups.find((group) =>
              group.windowIds.includes(window.id),
            )!.groupId,
            ordinal: window.ordinal,
          }));
          const result = (
            await observed.query<{
              raw_scores: { window_id: string; score: number | null }[];
              group_scores: { group_id: string; score: number }[];
            }>(
              `
    WITH raw AS MATERIALIZED (
      SELECT window_id,sum(v*q)/(sqrt(sum(v*v))*sqrt(sum(q*q))) AS raw_score
      FROM evaluation_vectors CROSS JOIN LATERAL unnest(embedding,$1::double precision[]) AS dimension(v,q)
      GROUP BY window_id
    ), scores AS MATERIALIZED (
      SELECT window_id,CASE WHEN raw_score BETWEEN -1-$5::double precision AND 1+$5::double precision
        THEN least(1::double precision,greatest(-1::double precision,raw_score)) ELSE NULL END AS score FROM raw
    ), members AS (SELECT * FROM unnest($2::text[],$3::text[],$4::integer[]) AS member(window_id,group_id,ordinal)),
    best_groups AS (
      SELECT group_id,max(score) AS score,min(ordinal) AS first_ordinal
      FROM scores JOIN members USING(window_id) GROUP BY group_id
      ORDER BY score DESC,first_ordinal,group_id COLLATE "C" LIMIT $6
    ) SELECT
      (SELECT jsonb_agg(jsonb_build_object('window_id',window_id,'score',score) ORDER BY window_id) FROM scores) AS raw_scores,
      (SELECT jsonb_agg(jsonb_build_object('group_id',group_id,'score',score) ORDER BY score DESC,first_ordinal,group_id COLLATE "C") FROM best_groups) AS group_scores`,
              [
                input.queryVector,
                members.map((row) => row.windowId),
                members.map((row) => row.groupId),
                members.map((row) => row.ordinal),
                evaluationVectorNumericConfiguration.roundoffTolerance,
                input.k,
              ],
            )
          ).rows[0];
          evaluatedWindowScores = result?.raw_scores.length ?? 0;
          if (
            result === undefined ||
            result.raw_scores.some(
              (row) => row.score === null || !Number.isFinite(row.score),
            )
          )
            throw new RangeError("vector_score_unavailable");
          sqlGroups = result.group_scores;
          return result.raw_scores.map((row) => ({
            window_id: row.window_id,
            score: row.score!,
          }));
        });
      } catch (error) {
        return refused(
          input,
          error instanceof RangeError
            ? "vector_overflow"
            : "adapter_unavailable",
          {
            elapsedMs: performance.now() - started,
            state: "failed_during_sql",
            statementsExecuted,
            inputRows,
            evaluatedWindowScores,
          },
        );
      }
      const ranked = sqlGroups.map((row, index) => {
        const group = groups.find((group) => group.groupId === row.group_id)!;
        return {
          groupId: group.groupId,
          windowIds: group.windowIds,
          firstOrdinal: group.firstOrdinal,
          score: row.score,
          rank: index + 1,
        };
      });
      const elapsedMs = performance.now() - started;
      const vector = {
        path: "fake_exact_vector" as const,
        dedupUnit: "trim_whitespace_lowercase_en_us_text_group" as const,
        ranked,
        durationMs: elapsedMs,
        qualityScoringState: "scored" as const,
        failures: [],
      };
      const lexical = {
        ...vector,
        path: "lexical" as const,
        ranked: input.lexicalGroupRanks.map((row) => {
          const group = groups.find((g) => g.groupId === row.groupId)!;
          return {
            groupId: row.groupId,
            windowIds: group.windowIds,
            firstOrdinal: group.firstOrdinal,
            score: null,
            rank: row.rank,
          };
        }),
      };
      const hybrid = evaluationFusion.fuse({
        lexical,
        vector,
        groups,
        rrfConstant: input.rrfConstant,
        k: input.k,
      });
      return rankingOutputSchema.parse({
        vector,
        hybrid,
        groups,
        rawWindowScores: input.windows.map((window) => ({
          windowId: window.id,
          score: rows.find((row) => row.window_id === window.id)!.score,
        })),
        sqlBounds: {
          inputWindows: input.windows.length,
          dimensions: input.dimensions,
          returnedVectorGroups: ranked.length,
          returnedHybridGroups: hybrid.ranked.length,
        },
        sqlObservation: {
          state: "executed",
          elapsedMs,
          statementsExecuted,
          inputRows,
          evaluatedWindowScores,
          databaseLoad: { state: "not_measured" },
        },
      });
    },
  };
}

function refused(
  input: Pick<EvaluationRankingInput, "dimensions" | "windows">,
  code:
    | "vector_zero_norm"
    | "vector_dimension_mismatch"
    | "vector_overflow"
    | "invalid_vector"
    | "adapter_unavailable"
    | "corpus_bound",
  sql?: {
    elapsedMs: number;
    state: "failed_during_sql";
    statementsExecuted: number;
    inputRows: number;
    evaluatedWindowScores: number;
  },
): EvaluationRankingOutput {
  const ranking = {
    dedupUnit: "trim_whitespace_lowercase_en_us_text_group" as const,
    ranked: [],
    durationMs: sql?.elapsedMs ?? 0,
    qualityScoringState: "failed" as const,
    failures: [{ code, stage: "vector_sql" as const }],
  };
  return rankingOutputSchema.parse({
    vector: { ...ranking, path: "fake_exact_vector" },
    hybrid: { ...ranking, path: "fake_hybrid" },
    groups: [],
    rawWindowScores: [],
    sqlBounds: {
      inputWindows: input.windows.length,
      dimensions: input.dimensions,
      returnedVectorGroups: 0,
      returnedHybridGroups: 0,
    },
    sqlObservation: {
      state: sql?.state ?? "refused_before_sql",
      elapsedMs: sql?.elapsedMs ?? 0,
      statementsExecuted: sql?.statementsExecuted ?? 0,
      inputRows: sql?.inputRows ?? 0,
      evaluatedWindowScores: sql?.evaluatedWindowScores ?? 0,
      databaseLoad: { state: "not_measured" },
    },
  });
}
