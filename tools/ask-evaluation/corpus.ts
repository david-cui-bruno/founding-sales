import { createHash } from "node:crypto";
import {
  frozenCorpusSchema,
  frozenManifestSchema,
  type FrozenCorpus,
  type FrozenManifest,
} from "./contracts.ts";

export const evaluationHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const originalTextHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** Development-only validation; sealed labels never enter this runner boundary. */
export function validateDevelopment(input: {
  phase: string;
  manifest: FrozenManifest;
  development: FrozenCorpus;
}) {
  if (input.phase !== "development_baseline")
    throw new RangeError("manifest_mismatch");
  return validateFrozenCorpus(input, "dev_");
}

/** Candidate callers reach this only after the full preregistered execution gate. */
export function validateFrozenCorpus(
  input: {
    manifest: FrozenManifest;
    development: FrozenCorpus;
  },
  prefix: "dev_" | "holdout_",
) {
  const manifest = frozenManifestSchema.parse(input.manifest);
  const corpus = frozenCorpusSchema.parse(input.development);
  const { corpusSha256, ...definition } = corpus;
  const windows = corpus.sources.flatMap((source) => source.windows);
  if (
    manifest.mode !== "fake_only" ||
    corpus.cases.length > 80 ||
    !corpus.id.startsWith(prefix) ||
    corpus.cases.some(
      (row) =>
        !row.id.startsWith(prefix) || !row.actorFixtureId.startsWith(prefix),
    ) ||
    corpus.sources.some((source) => !source.id.startsWith(prefix)) ||
    windows.some((window) => !window.id.startsWith(prefix)) ||
    windows.length > manifest.envelope.maxWindowsPerCorpus ||
    new Set(windows.map((row) => row.id)).size !== windows.length ||
    new Set(windows.map((row) => row.ordinal)).size !== windows.length ||
    new Set(corpus.cases.map((row) => row.id)).size !== corpus.cases.length ||
    evaluationHash(definition) !== corpusSha256 ||
    manifest.corpusSha256 !== corpusSha256 ||
    manifest.sourceManifestSha256 !== evaluationHash(corpus.sources) ||
    manifest.refWindowMappingSha256 !== evaluationHash(windows) ||
    manifest.splitSha256 !==
      evaluationHash(corpus.cases.map((row) => row.id)) ||
    manifest.configurationSha256 !==
      evaluationHash({
        candidate: manifest.candidate,
        envelope: manifest.envelope,
      })
  ) {
    throw new RangeError("manifest_mismatch");
  }
  for (const item of corpus.cases) {
    if (item.request.operation !== "passages") continue;
    if (!("sources" in item.request.scope))
      throw new RangeError("manifest_mismatch");
    const requestSources = item.request.scope.sources;
    if (
      requestSources === undefined ||
      requestSources.some(
        (request) =>
          !windows.some((window) => {
            const source = window.source;
            return (
              request.workspaceId === source.workspaceId &&
              request.sourceId === source.sourceId &&
              request.kind === source.kind &&
              request.revision === source.revision &&
              request.contentHash === source.contentHash &&
              (request.locator === null || request.locator === source.locator)
            );
          }),
      )
    )
      throw new RangeError("manifest_mismatch");
  }
  const canonicalSources = new Set<string>();
  const recipes = {
    selected_note: "synthetic_selected_note",
    mail: "synthetic_copied_mail",
    call_transcript: "synthetic_call_transcript",
    meeting_transcript: "synthetic_meeting_transcript",
  };
  for (const source of corpus.sources) {
    const first = source.windows[0]!;
    const identity = (window: typeof first) =>
      JSON.stringify([
        window.source.workspaceId,
        window.source.kind,
        window.source.sourceId,
        window.source.revision,
        window.source.contentHash,
      ]);
    const key = identity(first);
    if (
      canonicalSources.has(key) ||
      recipes[source.kind] !== source.setupId ||
      source.windows.some(
        (window) =>
          window.source.kind !== source.kind ||
          window.source.contentHash !== source.originalSha256 ||
          identity(window) !== key,
      ) ||
      new Set(source.windows.map((window) => window.source.locator)).size !==
        source.windows.length
    )
      throw new RangeError("manifest_mismatch");
    canonicalSources.add(key);
  }
  const ids = new Set(windows.map((row) => row.id));
  if (
    corpus.cases.some(
      (row) =>
        row.corpusId !== corpus.id ||
        row.relevance.some((item) => !ids.has(item.windowId)) ||
        row.acceptableClaims.some((claim) =>
          claim.supportedBy.some((id) => !ids.has(id)),
        ),
    )
  ) {
    throw new RangeError("manifest_mismatch");
  }
  return { manifest, corpus, windows };
}

/** Full copied extent is established by authenticated per-window reads, not a manifest claim. */
export function coversOriginalExtent(
  windows: FrozenCorpus["sources"][number]["windows"],
  observed: ReadonlyMap<string, { extent: number; text: string }>,
): boolean {
  const ranges = new Map<number, { start: number; end: number }[]>();
  let extent: number | undefined;
  for (const window of windows) {
    const value = observed.get(window.id);
    const match =
      /^(?:utterance:(0|[1-9]\d{0,5}):)?text:(0|[1-9]\d{0,7}):(0|[1-9]\d{0,7})$/u.exec(
        window.source.locator,
      );
    if (
      value === undefined ||
      match === null ||
      !Number.isSafeInteger(value.extent) ||
      value.extent < 1
    )
      return false;
    if (extent !== undefined && extent !== value.extent) return false;
    extent = value.extent;
    const utterance = match[1] === undefined ? -1 : Number(match[1]);
    if (
      (window.source.kind === "selected_note" ||
        window.source.kind === "mail") !==
      (utterance === -1)
    )
      return false;
    const start = Number(match[2]),
      end = Number(match[3]);
    if (end - start !== value.text.length) return false;
    const list = ranges.get(utterance) ?? [];
    list.push({ start, end });
    ranges.set(utterance, list);
  }
  let covered = 0;
  for (const list of ranges.values()) {
    list.sort((a, b) => a.start - b.start);
    let expectedStart = 0;
    for (const range of list) {
      if (range.start !== expectedStart || range.end <= range.start)
        return false;
      covered += range.end - range.start;
      expectedStart = range.end;
    }
  }
  return covered === extent;
}
