import { createHash } from 'node:crypto';
import { frozenCorpusSchema, frozenManifestSchema, type FrozenCorpus, type FrozenManifest } from './contracts.ts';

export const evaluationHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const originalTextHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/** Development-only validation; sealed labels never enter this runner boundary. */
export function validateDevelopment(input: {phase: string; manifest: FrozenManifest; development: FrozenCorpus}) {
  if (input.phase !== 'development_baseline') throw new RangeError('manifest_mismatch');
  const manifest = frozenManifestSchema.parse(input.manifest);
  const corpus = frozenCorpusSchema.parse(input.development);
  const {corpusSha256, ...definition} = corpus;
  const windows = corpus.sources.flatMap(source => source.windows);
  if (manifest.mode !== 'fake_only' || corpus.cases.length > 80 ||
      !corpus.id.startsWith('dev_') ||
      corpus.cases.some(row => !row.id.startsWith('dev_') || !row.actorFixtureId.startsWith('dev_')) ||
      corpus.sources.some(source => !source.id.startsWith('dev_')) ||
      windows.some(window => !window.id.startsWith('dev_')) ||
      windows.length > manifest.envelope.maxWindowsPerCorpus ||
      new Set(windows.map(row => row.id)).size !== windows.length ||
      new Set(windows.map(row => row.ordinal)).size !== windows.length ||
      new Set(corpus.cases.map(row => row.id)).size !== corpus.cases.length ||
      evaluationHash(definition) !== corpusSha256 || manifest.corpusSha256 !== corpusSha256 ||
      manifest.sourceManifestSha256 !== evaluationHash(corpus.sources) ||
      manifest.refWindowMappingSha256 !== evaluationHash(windows) ||
      manifest.splitSha256 !== evaluationHash(corpus.cases.map(row => row.id)) ||
      manifest.configurationSha256 !== evaluationHash({candidate:manifest.candidate,envelope:manifest.envelope})) {
    throw new RangeError('manifest_mismatch');
  }
  const ids = new Set(windows.map(row => row.id));
  if (corpus.cases.some(row => row.corpusId !== corpus.id ||
      row.relevance.some(item => !ids.has(item.windowId)) ||
      row.acceptableClaims.some(claim => claim.supportedBy.some(id => !ids.has(id))))) {
    throw new RangeError('manifest_mismatch');
  }
  return {manifest,corpus,windows};
}
