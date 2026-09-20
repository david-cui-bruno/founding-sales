/**
 * Research discovery and enrichment (specification 1.1 invariant 8, 7.4, 9.1, 10.3,
 * 13.2 and Appendix C).
 *
 * Read `docs/greenfield/research.md` first. The short version:
 *
 *   * research creates **candidate** firms, evidence, coordinates and **suggestions**;
 *   * it never enrolls a contact, opens an opportunity, or sends or dials anything —
 *     and `test/research/invariant8.test.ts` proves both the absence of any import
 *     that could and the absence of any row that would;
 *   * a route becomes `usable` only under a versioned policy with published history;
 *   * every provider call is capped through G5's counters, priced and, when it fails,
 *     named, per provider and per workspace business date;
 *   * a provider is an interface. The only implementations in this repository are the
 *     recorded fixtures under `testing/`.
 */

export {
  RESEARCH_PROVIDER_KINDS,
  RESEARCH_REFUSAL_CODES,
  RESEARCH_SUGGESTION_KINDS,
  RESEARCH_SUGGESTION_STATES,
  FILLABLE_CANONICAL_FIELDS,
  accept,
  isFillableCanonicalField,
  numeric,
  refuse,
  type FillableCanonicalField,
  type ResearchProviderKind,
  type ResearchRefusalCode,
  type ResearchResult,
  type ResearchSuggestionKind,
  type ResearchSuggestionState,
} from './types.ts';

export {
  RESEARCH_PAGE_PATHS,
  SHARED_PLATFORM_HOSTS,
  isPublicResearchAddress,
  permittedFirmSources,
  researchSourcePolicy,
  websiteRootOf,
  type SourceDisposition,
  type WebsiteRoot,
} from './sourcePolicy.ts';

export {
  MAX_BLOCKS,
  MAX_PAGE_BYTES,
  MAX_TEXT_CHARACTERS,
  blocksFromPlainText,
  mailtoTargets,
  mediaTypeOf,
  parsePageText,
  type PageBlock,
  type PageText,
} from './pageText.ts';

export {
  BUSINESS_EMAIL_ROLE_LOCAL_PARTS,
  FREE_MAIL_DOMAINS,
  businessEmailCandidates,
  findBusinessEmail,
  onCompanyDomain,
  withheldEmails,
  type BusinessEmailFinding,
  type BusinessEmailPage,
  type BusinessEmailRefusal,
  type BusinessEmailResult,
  type BusinessEmailSelection,
} from './businessEmail.ts';

export {
  COMPANY_FACT_KEYS,
  isCompanyFactKey,
  isNonContactFact,
  targetFitVerdict,
  validateFactSelections,
  type CompanyFact,
  type CompanyFactKey,
  type FactRefusal,
  type FactSelection,
  type FactSource,
  type FactValidation,
} from './facts.ts';

export {
  COORDINATE_ZONE_RULE_VERSION,
  COORDINATE_ZONE_STATES,
  RESEARCH_FIRM_ZONE_SOURCES,
  coordinateZoneSource,
  isUsableCoordinate,
  zoneForCoordinate,
  type Coordinate,
} from './zone.ts';

export {
  readFirmCoordinate,
  recordFirmCoordinate,
  resolveResearchFirmZone,
  type FirmCoordinate,
  type FirmCoordinateInput,
  type ResearchZoneOutcome,
} from './firmZone.ts';

export type {
  DiscoveryCandidate,
  DiscoveryPage,
  DiscoveryProvider,
  DiscoveryRequest,
  ExtractionProvider,
  ExtractionRequest,
  ExtractionSource,
  FetchedPage,
  PageFetchProvider,
  PageFetchRequest,
  PageFetchResult,
  ProviderOutcome,
  ResearchProviders,
} from './providers.ts';

export {
  evidenceRetentionExpiry,
  listProviders,
  readBusinessTimeZone,
  readProvider,
  readProviderLedger,
  readResearchSettings,
  readSpendMicros,
  recordProviderCall,
  updateProvider,
  updateResearchSettings,
  type ApprovedProvider,
  type ProviderLedgerEntry,
  type ProviderPatch,
  type RecordProviderCallInput,
  type ResearchSettings,
  type ResearchSettingsPatch,
} from './configuration.ts';

export {
  activeRoutePolicy,
  decideEligibilityUnderPolicy,
  isAtLeastAsStrict,
  publishRoutePolicy,
  readRoutePolicyVersion,
  routePolicyHistory,
  type PublishRoutePolicyInput,
  type PublishedRoutePolicy,
  type RouteFinding,
} from './routeEligibility.ts';

export {
  CEILING_REFUSALS,
  RESEARCH_COUNTER_KINDS,
  claimResearchClearance,
  researchEnqueueAllowed,
  type ClaimClearanceInput,
  type ResearchClearance,
  type ResearchWorkKind,
} from './ceilings.ts';

export {
  SUPPRESSING_SOURCES,
  firmSuppressionKey,
  isFirmSuppressed,
  suppressedFirmIds,
} from './suppression.ts';

export {
  AUTOMATIC_FILL_CONFIDENCE,
  decideSuggestionEffect,
  listSuggestions,
  recordSuggestion,
  reviewSuggestion,
  type RecordedSuggestion,
  type ReviewOutcome,
  type ReviewSuggestionInput,
  type SuggestionEffect,
  type SuggestionFinding,
  type SuggestionSummary,
} from './suggestions.ts';

export {
  DUPLICATE_SIGNAL_CONFIDENCE,
  duplicatePairKey,
  findDuplicateCandidates,
  suggestDuplicate,
  websiteHost,
  type DuplicateCandidate,
  type DuplicateSignal,
} from './duplicates.ts';

export {
  firmIsResearchable,
  queryHash,
  runDiscoveryPage,
  type DiscoveryRunInput,
  type DiscoveryRunReport,
} from './discovery.ts';

export {
  nextFirmResearchRevision,
  runFirmEnrichment,
  type EnrichmentRunInput,
  type EnrichmentRunReport,
} from './enrichment.ts';

export {
  enqueueDiscoveryPage,
  enqueueFirmEnrichment,
  parseDiscoveryPagePayload,
  parseEnrichmentPayload,
  type DiscoveryPageJobPayload,
  type EnqueuedResearchJob,
  type EnrichmentJobPayload,
} from './jobs.ts';
