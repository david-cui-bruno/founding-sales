import { z } from 'zod';
import { knownCompanyExtractionSchema } from './companyFactExtraction';
import type { Account, AccountEvidenceBatch, AccountEvidenceReceipt, AccountEvidenceSnapshot } from '../../shared/contracts/accountContract';
export const researchLimitsSchema = z.strictObject({ maxCompanies: z.number().int().min(1).max(50), maxPages: z.number().int().min(1).max(10),
  maxBytes: z.number().int().min(1).max(1000000), maxCostMicros: z.number().int().positive().max(20000000),
  /** Explicit reviewed, durable opt-in for selected known-account extraction. */
  knownCompanyExtraction: knownCompanyExtractionSchema.optional() }).refine(value => !value.knownCompanyExtraction
    || value.knownCompanyExtraction.maxCostMicros <= value.maxCostMicros, 'Extraction exceeds research reservation');
export type ResearchLimits = z.infer<typeof researchLimitsSchema>;
export const audienceQuerySchema = z.strictObject({ residential: z.literal(true), regions: z.array(z.string().trim().min(1).max(200)).min(1).max(20), terms: z.array(z.string().trim().min(1).max(200)).min(1).max(20) });
export type AudienceQuery = { residential: boolean; regions: string[]; terms: string[] };
export type CompanyCandidate = { name: string; domain: string; sourceUrl: string };
/** Which bulk source finds companies. Absent on a stored configuration means the original cited web search;
 *  configurations never gain the key implicitly, so existing settings fingerprints and run ids are unchanged. */
export const discoveryProviderSchema = z.enum(['responses_cited', 'places']);
export type DiscoveryProvider = z.infer<typeof discoveryProviderSchema>;
export const effectiveDiscoveryProvider = (value: DiscoveryProvider | undefined): DiscoveryProvider => value ?? 'responses_cited';
/** One Places text-search page is at most 20 results; a Places batch never asks for more companies than one page. */
export const PLACES_MAX_COMPANIES = 20;
export interface CompanyDiscoveryPort { discover(query: AudienceQuery, limits: ResearchLimits, signal: AbortSignal): Promise<CompanyCandidate[]>; }
export interface CompanyPagePort { research(snapshot: AccountEvidenceSnapshot, limits: ResearchLimits, signal: AbortSignal): Promise<AccountEvidenceBatch>; }
export type ResearchJob = { id: string; accountId: string; limits: ResearchLimits; attempt: number; claimToken: string;
  /** Reserved before HTTP. An existing committed command means settlement only. */
  receiptCommandId: string; receiptCommitted: boolean; costMicros: number | null;
  /** Exact per-account fetch allowlist recorded when a bulk source created the company; absent means configuration sources only. */
  permittedSources?: string[] };
export type { AccountEvidenceReceipt };
export type ResearchClaim = { jobId: string; claimToken: string };
export interface AccountResearchStore {
  create(input: { commandId: string; name: string; domain: string | null }): Account | Promise<Account>;
  snapshot(accountId: string, asOf: string): AccountEvidenceSnapshot | Promise<AccountEvidenceSnapshot>;
  admitEvidence(batch: AccountEvidenceBatch, researchClaim?: ResearchClaim): AccountEvidenceReceipt | Promise<AccountEvidenceReceipt>;
  enqueue(input: { commandId: string; accountId: string; limits: ResearchLimits; permittedSources?: string[] }): void | Promise<void>;
  claimNext(asOf: string): ResearchJob | null | Promise<ResearchJob | null>;
  settle(input: { jobId: string; claimToken: string; status: 'completed' | 'parked'; receiptCommandId: string | null; costMicros: number | null }): void | Promise<void>;
}
export interface CompanyResearchWorker { runNext(signal: AbortSignal): Promise<'completed' | 'parked' | 'idle'>; }
/** Explicit operator-confirmed capability and worst-case ceilings, not inferred from a model name. */
export const researchCapabilitySchema = z.strictObject({ model: z.string().min(1).max(200), webSearch: z.literal(true),
  searchCostMicros: z.number().int().positive().max(20000000), modelCostMicros: z.number().int().positive().max(20000000) });
export type ResearchCapability = z.infer<typeof researchCapabilitySchema>;

/** Pre-account ledger, implemented by C1. Workspace and approved budget identity
 * are part of the durable key. reserveOnce is atomic across ALL command IDs:
 * reserve search+model ceilings cumulatively, compare fingerprints on replay,
 * and NEVER grant another HTTP attempt for an uncertain/previous reservation.
 * Complete persists candidates before account creation. Null actual spend retains
 * the entire reservation, including after a crash. Constructors cannot reserve. */
export type DiscoveryReservationInput = { commandId: string; workspaceId: string; budgetId: string; inputFingerprint: string;
  searchCostMicros: number; modelCostMicros: number };
export type DiscoveryReservationResult = { status: 'reserved' } | { status: 'replay'; candidates: CompanyCandidate[] | null } | { status: 'denied' };
export interface DiscoveryReservationStore {
  reserveOnce(input: DiscoveryReservationInput): DiscoveryReservationResult | Promise<DiscoveryReservationResult>;
  complete(input: Pick<DiscoveryReservationInput, 'commandId' | 'workspaceId' | 'budgetId' | 'inputFingerprint'> & {
    candidates: CompanyCandidate[]; costMicros: number | null;
  }): void | Promise<void>;
}
