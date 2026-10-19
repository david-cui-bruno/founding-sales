import type { QualificationFact, ResearchPurpose, SourceObservation } from '@fss/contracts';
import type { QualificationCandidateContext } from '../sourcing/qualificationCitationRoles.ts';
import type { ExtractionAnswer, ExtractionRequest } from './providers.ts';

export type { ResearchPurpose } from '@fss/contracts';
export const OFFICE_TARGET_VERSION = 'office-target-v1';
export const OFFICE_IDENTITY_VERSION = 'office-identity-v1';
export const OFFICE_ASSESSMENT_VERSION = 'firm-office-assessment-v1';
export const OFFICE_SELECTION_VERSION = 'office-select-v1';
export const OFFICE_CAPTURE_MILLISECONDS = 30 * 60 * 1000;
export const OFFICE_SOURCE_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;
export const OFFICE_OBSERVATION_BYTE_LIMIT = 100_000;
export const OFFICE_FACT_BYTE_LIMIT = 50_000;

/** Omission is legacy brief only. Never default an explicit unknown purpose. */
export interface ResearchPurposeInput {
  readonly purpose?: ResearchPurpose | undefined;
}
export interface DurableResearchPurpose {
  readonly purpose: ResearchPurpose;
}
export type OfficeCaptureStatus = 'bound' | 'target_missing' | 'target_ambiguous' | 'identity_missing';

/** Selectors name literal supplied blocks. They contain no model-authored quotations. */
export interface OfficeSelection {
  readonly kind: QualificationFact['kind'];
  readonly observationId: string;
  readonly blockId: string;
}
export interface OfficeExtractionRequest {
  readonly purpose: 'office_evidence';
  readonly selectionVersion: typeof OFFICE_SELECTION_VERSION;
  readonly candidate: QualificationCandidateContext;
  readonly observations: readonly SourceObservation[];
  readonly modelName: string;
  readonly maxOutputTokens: number;
}
export interface OfficeExtractionAnswer {
  readonly purpose: 'office_evidence';
  readonly selections: readonly OfficeSelection[];
  readonly modelName: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Adopt at the existing provider port, never as a second provider or reservation. */
export type ResearchExtractionRequest = (ExtractionRequest & { readonly purpose?: 'brief' }) | OfficeExtractionRequest;
export type ResearchExtractionAnswer = (ExtractionAnswer & { readonly purpose?: 'brief' }) | OfficeExtractionAnswer;
