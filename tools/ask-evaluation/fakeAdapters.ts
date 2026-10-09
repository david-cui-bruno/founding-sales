import { z } from "zod";
import {
  answerOutputSchema,
  embeddingOutputSchema,
  queryEmbeddingOutputSchema,
  type EvaluationAnswerAdapter,
  type EvaluationEmbeddingAdapter,
} from "./contracts.ts";
const versionSchema = z.string().min(1).max(100);
function usage(input: string, output: string = "") {
  return {
    outcome: "observed" as const,
    calls: 1,
    inputTokens: Math.ceil(input.length / 4),
    outputTokens: Math.ceil(output.length / 4),
    reservedCents: "0" as const,
    observedCents: "0" as const,
  };
}
/** Explicit fixture scripts only; never reads labels, environment, files or network. */
export function createFakeEvaluationEmbedding(config: {
  version: string;
  dimensions: number;
  vectors: Readonly<Record<string, readonly number[]>>;
  queryVector: readonly number[];
}): EvaluationEmbeddingAdapter {
  const version = versionSchema.parse(config.version);
  const dimensions = z.number().int().min(1).max(4096).parse(config.dimensions);
  const vectors = structuredClone(config.vectors),
    queryVector = [...config.queryVector];
  return {
    kind: "fake",
    id: "fake_embedding",
    version,
    dimensions,
    async embed(input, signal) {
      signal.throwIfAborted();
      await Promise.resolve();
      signal.throwIfAborted();
      return embeddingOutputSchema.parse({
        vectors: input.map((window) => {
          const vector = vectors[window.id];
          if (vector === undefined) throw new Error("fake_script_missing");
          return { id: window.id, vector: [...vector] };
        }),
        usage: usage(input.map((window) => window.text).join("\n")),
      });
    },
    async embedQuery(query, signal) {
      signal.throwIfAborted();
      await Promise.resolve();
      signal.throwIfAborted();
      return queryEmbeddingOutputSchema.parse({
        vector: queryVector,
        usage: usage(query),
      });
    },
  };
}
/** Scripted claims are candidate output, never an automatic gold judgment. */
export function createFakeEvaluationAnswer(config: {
  version: string;
  answersByQuery: Readonly<
    Record<
      string,
      { claims: { text: string; windowIds: string[] }[]; abstained: boolean }
    >
  >;
}): EvaluationAnswerAdapter {
  const version = versionSchema.parse(config.version),
    scripts = structuredClone(config.answersByQuery);
  return {
    kind: "fake",
    id: "fake_answer",
    version,
    async answer(input, signal) {
      signal.throwIfAborted();
      await Promise.resolve();
      signal.throwIfAborted();
      const script = scripts[input.query];
      if (script === undefined) throw new Error("fake_script_missing");
      return answerOutputSchema.parse({
        ...structuredClone(script),
        usage: usage(
          input.query +
            "\n" +
            input.windows.map((window) => window.text).join("\n"),
          script.claims.map((claim) => claim.text).join("\n"),
        ),
      });
    },
  };
}
