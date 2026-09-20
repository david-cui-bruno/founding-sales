import type {
  FirmIdentityDto,
  FirmPageResponse,
  MergeConflict,
  PipelineStageDto,
} from '@fss/contracts';

/**
 * What the CRM windows are given, and the four things they may ask for
 * (specification 14.2).
 *
 * "Electron owns presentation... It contains no authoritative sequence,
 * suppression, policy, eligibility, or send logic."
 *
 * So this file has no rule in it. Every type below is a shape the API already
 * decided: `FirmPageResponse` is the discriminated union the read matrix produced,
 * `PipelineStageDto` is the workspace's configured stages, `MergeConflict` is the
 * list the merge command refused with. The renderer's whole job is to show them and
 * to disable what cannot be done.
 *
 * In particular the renderer does **not** decide who may edit a firm. It is told:
 * a page that arrived as `any_active_member` has no contacts to edit, because the
 * API did not send any, and there is nowhere in the type for them to be.
 */

export const CRM_SCREENS = ['firm', 'pipeline', 'merge'] as const;
export type CrmScreen = (typeof CRM_SCREENS)[number];

export interface PipelineColumn {
  readonly stage: PipelineStageDto;
  readonly firms: readonly FirmIdentityDto[];
}

export interface PipelineView {
  readonly columns: readonly PipelineColumn[];
  /** The open opportunity of each firm on the board, so a stage change can name it. */
  readonly opportunityIdByFirmId: Readonly<Record<string, string>>;
}

export interface MergeView {
  readonly sourceFirmId: string;
  readonly sourceName: string;
  readonly targetFirmId: string;
  readonly targetName: string;
  /** Empty means the merge has nothing left to resolve and may be submitted. */
  readonly conflicts: readonly MergeConflict[];
}

export interface CrmState {
  readonly screen: CrmScreen;
  /** The caller's role, for the one thing a role changes here: the merge command. */
  readonly role: 'admin' | 'salesperson';
  /** Whether the cloud answered the last time we asked. */
  readonly online: boolean;
  /** Whether a mutating command may be attempted at all (offline, or too old). */
  readonly mayMutate: boolean;
  /** A stable code, never a sentence composed here. */
  readonly notice: string | null;
  readonly firm: FirmPageResponse | null;
  readonly pipeline: PipelineView | null;
  readonly merge: MergeView | null;
}

export interface ContactEdit {
  readonly contactId: string;
  readonly fullName: string;
  readonly title: string | null;
  readonly makePrimary: boolean;
}

export interface StageChange {
  readonly opportunityId: string;
  readonly toStageKey: string;
  /** Section 8.1: a Lost change requires one. The server enforces it; this sends it. */
  readonly reason: string | null;
}

export interface MergeResolution {
  readonly sourceFirmId: string;
  readonly targetFirmId: string;
  /** Field name to the chosen value, one per conflict the API listed. */
  readonly resolutions: Readonly<Record<string, string>>;
}

export interface CrmBridge {
  state(): Promise<CrmState>;
  openFirm(input: { readonly firmId: string }): Promise<CrmState>;
  openPipeline(): Promise<CrmState>;
  saveContact(input: ContactEdit): Promise<CrmState>;
  changeStage(input: StageChange): Promise<CrmState>;
  resolveMerge(input: MergeResolution): Promise<CrmState>;
}

declare global {
  /** The bridge the preload script installs, exactly as G2's `callie` is installed. */
  var callieCrm: CrmBridge | undefined;
}
