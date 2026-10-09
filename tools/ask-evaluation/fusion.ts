import { performance } from "node:perf_hooks";
import {
  candidateRankingSchema,
  evidenceGroupSchema,
  type CandidateRanking,
  type EvaluationFusionPort,
} from "./contracts.ts";

/** A group contributes once from each ranked list, independent of copy count. */
export const evaluationFusion: EvaluationFusionPort = {
  fuse({ lexical, vector, groups, rrfConstant, k }): CandidateRanking {
    const started = performance.now();
    const refuse = () =>
      candidateRankingSchema.parse({
        path: "fake_hybrid",
        dedupUnit: "trim_whitespace_lowercase_en_us_text_group",
        ranked: [],
        durationMs: performance.now() - started,
        qualityScoringState: "failed",
        failures: [{ code: "invalid_vector", stage: "fusion" }],
      });
    if (
      rrfConstant !== 60 ||
      k !== 10 ||
      !candidateRankingSchema.safeParse(lexical).success ||
      !candidateRankingSchema.safeParse(vector).success ||
      !evidenceGroupSchema.array().max(1000).safeParse(groups).success ||
      lexical.path !== "lexical" ||
      vector.path !== "fake_exact_vector" ||
      new Set(groups.map((group) => group.groupId)).size !== groups.length
    )
      return refuse();
    const members = groups.flatMap((group) => group.windowIds);
    if (
      new Set(members).size !== members.length ||
      groups.some(
        (group) => new Set(group.windowIds).size !== group.windowIds.length,
      )
    )
      return refuse();
    for (const ranking of [lexical, vector]) {
      if (
        ranking.qualityScoringState !== "scored" ||
        ranking.failures.length > 0 ||
        new Set(ranking.ranked.map((row) => row.groupId)).size !==
          ranking.ranked.length
      )
        return refuse();
      for (const [index, row] of ranking.ranked.entries()) {
        const group = groups.find((group) => group.groupId === row.groupId);
        if (
          group === undefined ||
          row.rank !== index + 1 ||
          row.firstOrdinal !== group.firstOrdinal ||
          row.windowIds.length !== group.windowIds.length ||
          new Set(row.windowIds).size !== row.windowIds.length ||
          row.windowIds.some((id) => !group.windowIds.includes(id)) ||
          (ranking.path === "lexical" && row.score !== null) ||
          (ranking.path !== "lexical" &&
            (row.score === null || row.score < -1 || row.score > 1))
        )
          return refuse();
      }
    }
    const ranked = groups
      .map((group) => {
        const l = lexical.ranked.find(
          (row) => row.groupId === group.groupId,
        )?.rank;
        const v = vector.ranked.find(
          (row) => row.groupId === group.groupId,
        )?.rank;
        return {
          ...group,
          score:
            (l === undefined ? 0 : 1 / (rrfConstant + l)) +
            (v === undefined ? 0 : 1 / (rrfConstant + v)),
        };
      })
      .filter((group) => group.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.firstOrdinal - b.firstOrdinal ||
          a.groupId.localeCompare(b.groupId),
      )
      .slice(0, k)
      .map((group, index) => ({
        groupId: group.groupId,
        windowIds: group.windowIds,
        firstOrdinal: group.firstOrdinal,
        score: group.score,
        rank: index + 1,
      }));
    return candidateRankingSchema.parse({
      path: "fake_hybrid",
      dedupUnit: "trim_whitespace_lowercase_en_us_text_group",
      ranked,
      durationMs: performance.now() - started,
      qualityScoringState: "scored",
      failures: [],
    });
  },
};
