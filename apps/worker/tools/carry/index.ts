/**
 * The data carry from the previous DynamoDB table (lane G11).
 *
 * Under a write watermark, firms, evidence, every suppression and the template
 * bodies move from the old table into PostgreSQL through an encrypted artifact
 * outside git, with a manifest of per-kind counts and a content hash per item; the
 * artifact is shredded with an audit row. Postures are never copied. The old stack
 * becomes read-only and is never switched back to.
 *
 * See `docs/greenfield/carry-runbook.md` for the numbered steps David runs, and
 * `docs/decisions/g11-*.md` for what this lane decided where the spec was silent.
 */

export {
  CARRY_ARTIFACT_SCHEMA,
  ageCipher,
  ageDecryptArguments,
  ageEncryptArguments,
  aesGcmCipher,
  openArtifact,
  sealArtifact,
  type ArtifactCipher,
  type CarryReceipt,
  type OpenRefusal,
  type OpenResult,
  type RunCommand,
  type SealedArtifact,
} from './artifact.ts';

export {
  OldTableAdapterError,
  loadDynamoQuery,
  loadS3SuppressionJournal,
  type OldTableLocation,
} from './awsClients.ts';

export {
  CARRY_EXIT_CODES,
  CARRY_SUBCOMMANDS,
  REQUIRED_OPTIONS,
  main,
  parseCarryCommand,
  spawnCommand,
  type CarrySubcommand,
  type ParseRefusal,
  type ParseResult,
  type ParsedCarryCommand,
} from './cli.ts';

export {
  MAX_PAGES_PER_PREFIX,
  OldTableReadError,
  pagedOldTableReader,
  recordedFixtureReader,
  type DynamoQuery,
  type DynamoQueryPage,
  type DynamoQueryRequest,
  type OldTableReader,
} from './dynamoPort.ts';

export {
  exportReport,
  runCarryExport,
  type CarryExportInput,
  type CarryExportResult,
  type CarryExportValue,
  type ExportRefusal,
} from './export.ts';

export {
  carryCommandId,
  importReport,
  openCarryArtifact,
  runCarryImport,
  type CarryImportInput,
  type CarryImportReport,
  type CarryImportResult,
  type ImportRefusal,
  type KindCounts,
} from './import.ts';

export {
  CARRY_MANIFEST_SCHEMA,
  buildManifest,
  canonicalJson,
  compareParity,
  manifestCounts,
  manifestDigest,
  manifestItems,
  recordContentHash,
  type CarryManifest,
  type ManifestItem,
  type ManifestKindSummary,
  type ParityKindReport,
  type ParityReport,
} from './manifest.ts';

export {
  CARRY_KINDS,
  OLD_PREFIXES,
  classifyOldKey,
  isFirmSuppressionKey,
  readOldRecord,
  type CarriedEvidence,
  type CarriedEvidenceSource,
  type CarriedFirm,
  type CarriedRoute,
  type CarriedSuppression,
  type CarriedTemplate,
  type CarryKind,
  type OldItem,
  type OldRecord,
  type ReadRefusal,
  type ReadResult,
} from './oldShapes.ts';

export {
  shredCarryArtifact,
  type ShredOutcome,
  type ShredRefusal,
  type ShredResult,
} from './shred.ts';

export {
  CARRY_TEMPLATE_SEAM,
  CarryTemplateSeamError,
  deferredTemplateCounts,
  importTemplateVersions,
  templateVersionDrafts,
  type TemplateCarryCounts,
  type TemplateImporter,
  type TemplateVersionDraft,
} from './templates.ts';

export {
  CARRY_WATERMARK_SCHEMA,
  isAfterWatermark,
  readWatermark,
  type CarryWatermark,
  type WatermarkRefusal,
  type WatermarkResult,
} from './watermark.ts';
