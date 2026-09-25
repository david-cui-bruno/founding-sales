/**
 * The CRM core (specification 7.2, 7.3, 8.1, 9.1 and 9.2).
 *
 * Everything here goes through `RepositoryContext`, so there is no way to reach a row
 * without a `WorkspaceScope`, and every command takes the firm's row lock before it
 * decides whether the caller may change it. See `docs/greenfield/crm.md`.
 */

export {
  CRM_REFUSAL_CODES,
  ROUTE_ELIGIBILITIES,
  ROUTE_KINDS,
  ROUTE_SOURCES,
  TECHNICAL_VALIDATIONS,
  CONTROL_MODES,
  actorKind,
  actorUserId,
  type ContactRow,
  type ControlMode,
  type CrmRefusalCode,
  type CrmResult,
  type FirmRow,
  type MergeConflict,
  type OpportunityRow,
  type PipelineStageRow,
  type RouteEligibility,
  type RouteKind,
  type RouteRow,
  type RouteSource,
  type TechnicalValidation,
} from './types.ts';

export {
  decideAdminOnly,
  decideFirmMutation,
  decideFirmRead,
  firmReadIsAudited,
  type FirmMutationDecision,
  type FirmReadVisibility,
} from './authorization.ts';

export { recordCrmAuditEvent } from './audit.ts';

export {
  CRM_DOMAIN_EVENT_KINDS,
  MANUAL_MODE_ORIGINS,
  emitCrmDomainEvent,
  readCrmDomainEvents,
  type CrmDomainEventInput,
  type CrmDomainEventKind,
  type ManualModeOrigin,
} from './events.ts';

export {
  ROUTE_ELIGIBILITY_POLICY,
  ROUTE_ELIGIBILITY_POLICY_VERSION,
  decideRouteEligibility,
  type RouteEligibilityDecision,
  type RouteEligibilityInput,
  type RouteEligibilityPolicy,
} from './routePolicy.ts';

export {
  FIRM_ZONE_SOURCES,
  POSTAL_ZONE_RULE_VERSION,
  postalPrefix,
  postalZoneSource,
  zoneForPostalCode,
} from './zone.ts';

export {
  createFirm,
  loadFirmForUpdate,
  readFirm,
  reassignFirm,
  resolveZoneForFirm,
  updateFirm,
  type CreateFirmInput,
  type FirmPatch,
  type FirmZoneOutcome,
  type ReassignFirmInput,
  type ReassignFirmOutcome,
} from './firms.ts';

export {
  createContact,
  listContacts,
  readContact,
  updateContact,
  type ContactPatch,
  type CreateContactInput,
} from './contacts.ts';

export {
  addEmailRoute,
  addPhoneRoute,
  confirmPhoneRoute,
  listRoutes,
  retireRoute,
  verifyRoute,
  type AddRouteInput,
  type ConfirmPhoneRouteInput,
  type EmailRouteInput,
  type PhoneRouteInput,
  type VerifyRouteInput,
} from './routes.ts';

export { listEvidence, recordEvidence, type EvidenceRow, type RecordEvidenceInput } from './evidence.ts';

export {
  changeStage,
  listPipelineStages,
  openOpportunity,
  readOpenOpportunity,
  readOpportunity,
  reopenOpportunity,
  setManualControlMode,
  type ChangeStageInput,
  type ReopenOutcome,
} from './pipeline.ts';

export {
  createPipelineStage,
  renamePipelineStage,
  reorderPipelineStages,
  retirePipelineStage,
  type CreatePipelineStageInput,
  type RenamePipelineStageInput,
  type ReorderPipelineStagesInput,
  type RetirePipelineStageOutcome,
} from './stageAdmin.ts';

export {
  readPipelineBoardForActor,
  type PipelineBoardColumn,
  type PipelineBoardDto,
} from './board.ts';

export {
  canonicalFirmOf,
  listFirmAliases,
  mergeContacts,
  mergeFirms,
  type MergeContactsInput,
  type MergeFirmsInput,
  type MergeOutcome,
} from './merges.ts';

export {
  firmIdentityDtoOf,
  listFirmsForActor,
  readFirmForActor,
  type ContactDto,
  type FirmDetailDto,
  type FirmIdentityDto,
  type FirmReadDto,
  type RouteDto,
} from './dto.ts';

export {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  NARROW_MATCH_FIELDS,
  SEARCH_MATCH_FIELDS,
  SEQUENCE_STATUS_FILTERS,
  WIDE_MATCH_FIELDS,
  likePattern,
  searchFirms,
  type SearchFilters,
  type SearchHit,
  type SearchInput,
  type SearchMatchField,
  type SearchOutcome,
  type SequenceStatusFilter,
} from './search.ts';

export {
  CSV_REFUSALS,
  IMPORT_COLUMNS,
  IMPORT_ISSUE_CODES,
  MAX_IMPORT_ROWS,
  addFirm,
  canonicalE164,
  canonicalWebsite,
  commitImportRow,
  firmNameKey,
  headerColumn,
  parseCsv,
  previewCsvImport,
  websiteDomain,
  type AddFirmInput,
  type CsvRefusal,
  type CsvRow,
  type ImportColumn,
  type ImportContactDraft,
  type ImportFirmDraft,
  type ImportFirmMatch,
  type ImportIssue,
  type ImportIssueCode,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportRefusal,
  type ImportResult,
  type ImportRouteDraft,
  type ImportRowCommitted,
  type ImportRowOutcome,
  type ParsedCsv,
} from './import.ts';

export { exportFirms, type ExportInput, type FirmExport } from './exports.ts';

export {
  readFirmPage,
  type FirmHoldDto,
  type FirmPageDto,
  type OpportunitySummaryDto,
  type StageEventDto,
} from './firmPage.ts';

// Lane g90: email technical validation (7.4). The rules and the job are
// `routeValidation.ts`; the one write they make is `recordEmailRouteValidation`.
export {
  EMAIL_VALIDATION_ROUND_NEW,
  emailValidationJob,
  recordEmailRouteValidation,
  type RecordEmailValidationInput,
  type RecordEmailValidationOutcome,
} from './routes.ts';

export {
  DNS_LOOKUP_DEADLINE_MILLISECONDS,
  EMAIL_ADDRESS_MAXIMUM_LENGTH,
  EMAIL_VALIDATION_DEFER_REASONS,
  EMAIL_VALIDATION_FAIL_REASONS,
  EMAIL_VALIDATION_PASS_REASONS,
  EMAIL_VALIDATION_RULE_VERSION,
  EMAIL_VALIDATION_SWEEP_AFTER_MINUTES,
  EMAIL_VALIDATION_SWEEP_LIMIT,
  MEMBER_ENTERED_SOURCES,
  MEMBER_VOUCHED_CONFIDENCE,
  RESERVED_MAIL_DOMAINS,
  checkMailDomain,
  emailValidationCheckRound,
  emailValidationSweep,
  emailValidationSweepRounds,
  implicitMxVerdict,
  isReservedMailDomain,
  listEmailRoutesDueForValidation,
  mxVerdict,
  parseEmailAddress,
  parseRouteValidationPayload,
  requestEmailRouteValidation,
  runEmailRouteValidation,
  validateEmailAddress,
  vouchedConfidenceFor,
  type DnsLookup,
  type EmailRouteDueForValidation,
  type EmailValidationRequested,
  type EmailValidationReport,
  type EmailValidationVerdict,
  type MailDomainResolver,
  type MailExchangeRecord,
  type ParsedEmailAddress,
  type RequestEmailValidationInput,
  type RouteValidationPayload,
} from './routeValidation.ts';
