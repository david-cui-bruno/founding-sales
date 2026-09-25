import type {
  FirmIdentityDto,
  FirmPageResponse,
  ImportCommitResponse,
  ImportIssueDto,
  ImportPreviewResponse,
  MergeConflict,
  PipelineStageDto,
} from '@fss/contracts';

/**
 * What the CRM windows are given, and what they may ask for (specification 14.2).
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

export const CRM_SCREENS = ['firm', 'pipeline', 'merge', 'add_firm', 'import'] as const;
export type CrmScreen = (typeof CRM_SCREENS)[number];

export interface PipelineColumn {
  readonly stage: PipelineStageDto;
  readonly firms: readonly FirmIdentityDto[];
}

export interface PipelineView {
  readonly columns: readonly PipelineColumn[];
  /** The open opportunity of each firm on the board, so a stage change can name it. */
  readonly opportunityIdByFirmId: Readonly<Record<string, string>>;
  /**
   * Firms with no open opportunity, which are in no column (lane g84). A firm just added
   * or imported is one until somebody opens an opportunity on it, and a board that left
   * them out showed nothing for what had just been added.
   */
  readonly unplacedFirms?: readonly FirmIdentityDto[];
}

/**
 * The Add firm form, as the person typed it (lane g84). Kept by the bridge so a refused
 * form comes back with every value still in it: the window is redrawn from the state on
 * every answer, and a form it redrew empty would make the person type it all again.
 */
export interface AddFirmDraft {
  readonly name: string;
  readonly website: string;
  /** An IANA zone, or empty for "not sure". */
  readonly timeZone: string;
  readonly contactName: string;
  readonly contactTitle: string;
  readonly contactEmail: string;
  readonly contactPhone: string;
}

export interface AddFirmView {
  readonly draft: AddFirmDraft;
  /** The fields the last refusal named, by the import column each field stands for. */
  readonly issues: readonly ImportIssueDto[];
  /** The firm a `duplicate_in_workspace` matched, so the form can offer to open it. */
  readonly duplicateFirmId: string | null;
}

/** A whole file refused, and where: the header or the line (lane g84). */
export interface ImportFileRefusalView {
  readonly reason: string;
  readonly column: string | null;
  readonly rowNumber: number | null;
}

/**
 * The Import screen (lane g84): the file's name, the server's preview of it, a refusal
 * of the whole file, or what the commit answered. The file's text stays in the main
 * process; the window is given what the server said about it.
 */
export interface ImportView {
  readonly fileName: string | null;
  readonly preview: ImportPreviewResponse | null;
  readonly fileRefusal: ImportFileRefusalView | null;
  readonly results: ImportCommitResponse | null;
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
  /** The Add firm form, while the window shows it (lane g84). */
  readonly addFirm?: AddFirmView | null;
  /** The Import screen, while the window shows it (lane g84). */
  readonly import?: ImportView | null;
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

/** A file the person chose or pasted, as text, and what to call it on screen. */
export interface ImportFile {
  readonly csv: string;
  readonly fileName: string;
}

export interface CrmBridge {
  state(): Promise<CrmState>;
  openFirm(input: { readonly firmId: string }): Promise<CrmState>;
  openPipeline(): Promise<CrmState>;
  saveContact(input: ContactEdit): Promise<CrmState>;
  changeStage(input: StageChange): Promise<CrmState>;
  resolveMerge(input: MergeResolution): Promise<CrmState>;
  /** Lane g84: the Add firm form, and sending it. */
  openAddFirm(): Promise<CrmState>;
  addFirm(input: AddFirmDraft): Promise<CrmState>;
  /** Lane g84: the Import screen, the preview of a file, and committing what it previewed. */
  openImport(): Promise<CrmState>;
  previewImport(input: ImportFile): Promise<CrmState>;
  commitImport(): Promise<CrmState>;
}

declare global {
  /** The bridge the preload script installs, exactly as G2's `callie` is installed. */
  var callieCrm: CrmBridge | undefined;
}
