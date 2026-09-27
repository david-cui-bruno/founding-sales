import { z } from 'zod';
import {
  enrollmentDtoSchema,
  firmIdentityDtoSchema,
  firmPageResponseSchema,
  importCommitResponseSchema,
  importIssueSchema,
  importPreviewResponseSchema,
  instant,
  mergeRefusalSchema,
  pipelineStagesResponseSchema,
  uuid,
} from '@fss/contracts';

/**
 * What the Firms view is given, and what it may ask for (specification 14.2).
 *
 * "Electron owns presentation... It contains no authoritative sequence,
 * suppression, policy, eligibility, or send logic."
 *
 * So this file has no rule in it. Every shape below is composed from the schemas
 * `@fss/contracts` already publishes for the routes the bridge reads:
 * `firmPageResponseSchema` is the discriminated union the read matrix produced,
 * `pipelineStageDtoSchema` is the workspace's configured stages, and a merge conflict is
 * the element of the list `mergeRefusalSchema` carries. The view's whole job is to show
 * them and to disable what cannot be done.
 *
 * Since 1.0.13 the state is a **schema**, not an interface, because it crosses the
 * operation registry (`src/shared/operations.ts`): both sides of the bridge parse it, so
 * a state that grew a field it should not have fails at the boundary rather than
 * reaching the page. Composing it from the contracts' own schemas is the opposite of a
 * second definition — there is one spelling of a firm page, and this names it.
 *
 * In particular the renderer does **not** decide who may edit a firm. It is told:
 * a page that arrived as `any_active_member` has no contacts to edit, because the
 * API did not send any, and there is nowhere in the type for them to be.
 */

export const CRM_SCREENS = ['firm', 'pipeline', 'merge', 'add_firm', 'import'] as const;
export type CrmScreen = (typeof CRM_SCREENS)[number];

/**
 * Two element schemas taken from the exported wrappers that carry them rather than
 * written out again: a stage as the stage list has it, and a conflict as a refused merge
 * carries it. `@fss/contracts` exports the wrappers, and one spelling of each shape is
 * the whole point of composing the state from the contracts at all.
 */
const pipelineStageDtoSchema = pipelineStagesResponseSchema.shape.stages.element;
const mergeConflictSchema = mergeRefusalSchema.shape.conflicts.unwrap().element;

export const pipelineColumnSchema = z.object({
  stage: pipelineStageDtoSchema,
  firms: z.array(firmIdentityDtoSchema),
});
export type PipelineColumn = z.infer<typeof pipelineColumnSchema>;

export const pipelineViewSchema = z.object({
  columns: z.array(pipelineColumnSchema),
  /** The open opportunity of each firm on the board, so a stage change can name it. */
  opportunityIdByFirmId: z.record(uuid, uuid),
  /**
   * Firms with no open opportunity, which are in no column (lane g84). A firm just added
   * or imported is one until somebody opens an opportunity on it, and a board that left
   * them out showed nothing for what had just been added.
   */
  unplacedFirms: z.array(firmIdentityDtoSchema).optional(),
});
export type PipelineView = z.infer<typeof pipelineViewSchema>;

/**
 * The Add firm form, as the person typed it (lane g84). Kept by the bridge so a refused
 * form comes back with every value still in it.
 */
export const addFirmDraftSchema = z.object({
  name: z.string().max(300),
  website: z.string().max(500),
  /** An IANA zone, or empty for "not sure". */
  timeZone: z.string().max(64),
  contactName: z.string().max(200),
  contactTitle: z.string().max(200),
  contactEmail: z.string().max(320),
  contactPhone: z.string().max(40),
});
export type AddFirmDraft = z.infer<typeof addFirmDraftSchema>;

export const addFirmViewSchema = z.object({
  draft: addFirmDraftSchema,
  /** The fields the last refusal named, by the import column each field stands for. */
  issues: z.array(importIssueSchema),
  /** The firm a `duplicate_in_workspace` matched, so the form can offer to open it. */
  duplicateFirmId: uuid.nullable(),
});
export type AddFirmView = z.infer<typeof addFirmViewSchema>;

/** A whole file refused, and where: the header or the line (lane g84). */
export const importFileRefusalViewSchema = z.object({
  reason: z.string().max(80),
  column: z.string().max(200).nullable(),
  rowNumber: z.number().int().nullable(),
});
export type ImportFileRefusalView = z.infer<typeof importFileRefusalViewSchema>;

/**
 * The Import screen (lane g84): the file's name, the server's preview of it, a refusal
 * of the whole file, or what the commit answered. The file's text stays in the main
 * process — since 1.0.13 it never leaves it, because the file is chosen by macOS's own
 * dialog on the main side — and the window is given what the server said about it.
 */
export const importViewSchema = z.object({
  fileName: z.string().max(400).nullable(),
  preview: importPreviewResponseSchema.nullable(),
  fileRefusal: importFileRefusalViewSchema.nullable(),
  results: importCommitResponseSchema.nullable(),
});
export type ImportView = z.infer<typeof importViewSchema>;

export const mergeViewSchema = z.object({
  sourceFirmId: uuid,
  sourceName: z.string().max(300),
  targetFirmId: uuid,
  targetName: z.string().max(300),
  /** Empty means the merge has nothing left to resolve and may be submitted. */
  conflicts: z.array(mergeConflictSchema),
});
export type MergeView = z.infer<typeof mergeViewSchema>;
export type MergeConflict = MergeView['conflicts'][number];

/**
 * The Firm page's Sequences section (lane g88, audit G03): the published versions a
 * contact here may be enrolled in, and the enrollments already running at the firm. Each
 * is labelled with the sequence's name and version, which is what a person recognises.
 */
export const firmSequencesViewSchema = z.object({
  published: z.array(z.object({ sequenceVersionId: uuid, label: z.string().max(300) })),
  enrollments: z.array(
    z.object({
      enrollmentId: uuid,
      contactId: uuid,
      label: z.string().max(300),
      state: enrollmentDtoSchema.shape.state,
      startedAt: instant,
    }),
  ),
  /** The refusal code of a read that failed, or null. A failed read is not "none". */
  readError: z.string().max(80).nullable(),
});
export type FirmSequencesView = z.infer<typeof firmSequencesViewSchema>;

export const crmStateSchema = z.strictObject({
  screen: z.enum(CRM_SCREENS),
  /** The caller's role, for the one thing a role changes here: the merge command. */
  role: z.enum(['admin', 'salesperson']),
  /** Whether the cloud answered the last time we asked. */
  online: z.boolean(),
  /** Whether a mutating command may be attempted at all (offline, or too old). */
  mayMutate: z.boolean(),
  /** A stable code, never a sentence composed here. */
  notice: z.string().max(200).nullable(),
  firm: firmPageResponseSchema.nullable(),
  pipeline: pipelineViewSchema.nullable(),
  merge: mergeViewSchema.nullable(),
  /** The Add firm form, while the window shows it (lane g84). */
  addFirm: addFirmViewSchema.nullable(),
  /** The Import screen, while the window shows it (lane g84). */
  import: importViewSchema.nullable(),
  /** The Firm page's Sequences section (lane g88). */
  sequences: firmSequencesViewSchema.nullable(),
});
export type CrmState = z.infer<typeof crmStateSchema>;

/** Enrol one contact of the open Firm page in one published version (lane g88). */
export interface EnrollRequest {
  readonly sequenceVersionId: string;
  readonly contactId: string;
}

/** Check one address of the open Firm page again, at the version on screen (lane g90). */
export interface CheckRouteRequest {
  readonly routeId: string;
  readonly routeVersion: number;
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

/** A file the person chose, as text, and what to call it on screen. Main-process only. */
export interface ImportFile {
  readonly csv: string;
  readonly fileName: string;
}
