import { randomUUID } from 'node:crypto';
import {
  FIRM_PAGE_VERSION,
  IMPORT_FILE_REFUSALS,
  addFirmRefusalSchema,
  addFirmResultSchema,
  enrollmentsResponseSchema,
  firmListResponseSchema,
  firmPageResponseSchema,
  importCommitResponseSchema,
  importFileRefusalResponseSchema,
  importPreviewResponseSchema,
  mergeRefusalSchema,
  pipelineBoardResponseSchema,
  pipelineStagesResponseSchema,
  sequenceVersionsResponseSchema,
  sequencesResponseSchema,
  type FirmIdentityDto,
  type MergeConflict,
  type PipelineStageDto,
} from '@fss/contracts';
import type {
  AddFirmDraft,
  AddFirmView,
  CheckRouteRequest,
  ConfirmRouteRequest,
  ContactEdit,
  CrmScreen,
  CrmState,
  EnrollRequest,
  FirmSequencesView,
  ImportFile,
  ImportFileRefusalView,
  ImportView,
  MergeResolution,
  PipelineView,
  StageChange,
} from '../renderer/firmWorkspaceContract.ts';
import type { AuthedClient } from './authedClient.ts';

/**
 * The CRM windows' half of the bridge, in the main process.
 *
 * Lane G3b built `firmWorkspace.ts`, `firmPage.ts`, `pipelineBoard.ts` and
 * `firmMerge.ts` and left them unwired: `globalThis.callieCrm` was declared in
 * `firmWorkspaceContract.ts` and installed by nobody, so the window could not be
 * opened. This is the missing half, written to G3b's contract without changing a line
 * of its renderer code — the six methods it declares, answered from the API.
 *
 * It is the same shape as the Today bridge and for the same reasons: the renderer
 * gets a state and never a token, every mutation goes through `command` so the 5.3
 * envelope cannot be forgotten, and a refusal arrives as a stable code that
 * `firmWorkspaceView.ts` turns into one fixed sentence.
 *
 * The board was assembled here until lane G9 added `POST /pipeline/board`. It is now
 * one API read: the columns, the firms already in them, and the open opportunity id
 * for the firms this caller may change. G6 wrote down why that map could not be
 * filled from `GET /firms` (`docs/decisions/g6-pipeline-board-opportunity-ids.md`)
 * and G9 answered it (`docs/decisions/g9-pipeline-board-read.md`). What this file
 * keeps is the fallback: a Firm page still tells the bridge the id of the opportunity
 * it opened, so a board loaded before the endpoint answered still offers the control
 * for a firm the person has looked at.
 *
 * Lane g84 (audit item G02) added the two ways a firm gets in from the Mac: **Add firm**,
 * one command (`POST /crm/firms/add`) for the firm, its first contact and that contact's
 * address and number; and **Import**, the admin's CSV preview and commit. The file's text
 * stays here, in the main process, between the preview and the commit, with one command
 * id per row; the window is given what the server said about the file, never the file.
 */

export const CRM_IPC_CHANNELS = {
  state: 'callie:crm:state',
  openFirm: 'callie:crm:open-firm',
  openPipeline: 'callie:crm:open-pipeline',
  saveContact: 'callie:crm:save-contact',
  changeStage: 'callie:crm:change-stage',
  resolveMerge: 'callie:crm:resolve-merge',
  // Lane g84: Add firm and Import.
  openAddFirm: 'callie:crm:open-add-firm',
  addFirm: 'callie:crm:add-firm',
  openImport: 'callie:crm:open-import',
  previewImport: 'callie:crm:preview-import',
  commitImport: 'callie:crm:commit-import',
  // Lane g88: the Firm page's pipeline start, enrolment and number confirmation.
  openOpportunity: 'callie:crm:open-opportunity',
  enroll: 'callie:crm:enroll',
  confirmRoute: 'callie:crm:confirm-route',
  // Lane g90: "Check again" on an address still being checked.
  checkRoute: 'callie:crm:check-route',
} as const;
export type CrmIpcChannel = (typeof CRM_IPC_CHANNELS)[keyof typeof CRM_IPC_CHANNELS];

/*
 * The stage list, the firm list, G9's board and a refused merge are parsed with
 * `@fss/contracts`' schemas for their routes (lane g78), the ones the routes' own tests
 * hold the real answers to. The board's id map is ids to ids, not any strings.
 */

export interface CrmBridgeDeps {
  readonly api: AuthedClient;
  /**
   * The version this build announces (lane g84). The import commit carries one command id
   * per row rather than one for the request, so it goes through `read` with its own
   * envelope, and the version is the half of that envelope `command` would have added.
   */
  readonly clientVersion: string;
  readonly session: {
    state(): Promise<{
      readonly online: boolean;
      readonly mayMutate: boolean;
      readonly device: { readonly role: 'admin' | 'salesperson' } | null;
    }>;
  };
}

export interface CrmBridgeHost {
  state(): Promise<CrmState>;
  openFirm(input: { readonly firmId: string }): Promise<CrmState>;
  openPipeline(): Promise<CrmState>;
  saveContact(input: ContactEdit): Promise<CrmState>;
  changeStage(input: StageChange): Promise<CrmState>;
  resolveMerge(input: MergeResolution): Promise<CrmState>;
  openAddFirm(): Promise<CrmState>;
  addFirm(input: AddFirmDraft): Promise<CrmState>;
  openImport(): Promise<CrmState>;
  previewImport(input: ImportFile): Promise<CrmState>;
  commitImport(): Promise<CrmState>;
  openOpportunity(): Promise<CrmState>;
  enroll(input: EnrollRequest): Promise<CrmState>;
  confirmRoute(input: ConfirmRouteRequest): Promise<CrmState>;
  checkRoute(input: CheckRouteRequest): Promise<CrmState>;
}

/**
 * "Check again"'s refusals, said about an address (lane g90). The codes are the route's,
 * shared with "Confirm this number", whose sentences name a number.
 */
const ADDRESS_REFUSAL_NOTICES: Readonly<Record<string, string>> = Object.freeze({
  route_version_stale: 'address_changed',
  route_invalid: 'address_invalid',
  route_retired: 'address_retired',
  route_unknown: 'address_unknown',
});

/** How many sequences the Firm page asks the versions of. A founder has a handful. */
export const FIRM_PAGE_SEQUENCE_LIMIT = 20;

/**
 * The contact patch `/contacts/update` takes (lane g88, audit C20). The route's command is
 * `{ contactId, patch }` and its patch is strict, and until g88 the bridge sent the fields
 * beside `contactId` instead — every save was a 400 — and left an empty title out, which in
 * a patch means "unchanged". An empty title is now the explicit `null` the patch reads as
 * "clear it", and the promotion is sent only when asked for.
 */
export function contactPatchBody(input: ContactEdit): Readonly<Record<string, unknown>> {
  return {
    contactId: input.contactId,
    patch: {
      fullName: input.fullName,
      title: input.title,
      ...(input.makePrimary ? { isPrimary: true } : {}),
    },
  };
}

/** `importPreviewRequestSchema`'s bound on a file, in characters. */
export const MAX_IMPORT_FILE_CHARACTERS = 512 * 1024;

/** The Add firm form before anything is typed. */
export const EMPTY_ADD_FIRM: AddFirmDraft = Object.freeze({
  name: '',
  website: '',
  timeZone: '',
  contactName: '',
  contactTitle: '',
  contactEmail: '',
  contactPhone: '',
});

/**
 * The form as `POST /crm/firms/add` takes it (lane g84): the values as typed, a blank
 * field left out, and no contact at all when every contact field is blank. Nothing is
 * checked or canonicalized here — a website, an address and a number are the domain's to
 * read, and a Mac that "fixed" one would be a second implementation of the rule that
 * refuses it.
 */
export function addFirmBody(draft: AddFirmDraft): Readonly<Record<string, unknown>> {
  const given = (value: string): boolean => value.trim().length > 0;
  const contactGiven = [draft.contactName, draft.contactTitle, draft.contactEmail, draft.contactPhone].some(given);
  return {
    firm: {
      name: draft.name,
      ...(given(draft.website) ? { website: draft.website } : {}),
      ...(given(draft.timeZone) ? { timeZone: draft.timeZone } : {}),
    },
    ...(contactGiven
      ? {
          contact: {
            fullName: draft.contactName,
            ...(given(draft.contactTitle) ? { title: draft.contactTitle } : {}),
            ...(given(draft.contactEmail) ? { email: draft.contactEmail } : {}),
            ...(given(draft.contactPhone) ? { phone: draft.contactPhone } : {}),
          },
        }
      : {}),
  };
}

/** A refusal of the whole file, when the answer is one; otherwise null. */
export function fileRefusalOf(body: unknown): ImportFileRefusalView | null {
  const parsed = importFileRefusalResponseSchema.safeParse(body);
  if (!parsed.success) return null;
  if (!(IMPORT_FILE_REFUSALS as readonly string[]).includes(parsed.data.reason)) return null;
  return { reason: parsed.data.reason, column: parsed.data.column, rowNumber: parsed.data.rowNumber };
}

/**
 * The board, as columns. Retired-and-empty stages are dropped by the renderer.
 *
 * `opportunityIdByFirmId` is what lets a column offer a stage change, and it is still
 * sparse: the server sends an id only for a firm this caller could actually change,
 * so a colleague's column renders G3b's `stage-change-unavailable` rather than a
 * control whose click would be refused. Kept exported because the Firm-page fallback
 * below composes the same view from the stage list and the firm list.
 */
export function pipelineViewOf(
  stages: readonly PipelineStageDto[],
  firms: readonly FirmIdentityDto[],
  opportunityIdByFirmId: Readonly<Record<string, string>> = {},
): PipelineView {
  return {
    columns: stages.map(stage => ({
      stage,
      firms: firms.filter(firm => firm.stageKey === stage.key),
    })),
    opportunityIdByFirmId: { ...opportunityIdByFirmId },
  };
}

export function createCrmBridge(deps: CrmBridgeDeps): CrmBridgeHost {
  let screen: CrmScreen = 'pipeline';
  let firm: CrmState['firm'] = null;
  let pipeline: PipelineView | null = null;
  let merge: CrmState['merge'] = null;
  let notice: string | null = null;
  let addFirmView: AddFirmView | null = null;
  let importView: ImportView | null = null;
  /** The previewed file's text and one command id per row it may commit (lane g84). */
  let importCsv: string | null = null;
  let importCommandIds = new Map<number, string>();
  /** The open Firm page's Sequences section (lane g88). */
  let sequences: FirmSequencesView | null = null;
  /** Every opportunity id a Firm page has told this window about. */
  const opportunityIdByFirmId: Record<string, string> = {};

  /**
   * A firm's name for the merge screen: from what this window already holds — the merge
   * it is showing, the Firm page, the board — and otherwise from one `/firms` read. The
   * id itself only if the firm is in none of them, so the screen still says which two
   * records it is about.
   */
  const firmNameOf = async (firmId: string): Promise<string> => {
    if (merge?.sourceFirmId === firmId) return merge.sourceName;
    if (merge?.targetFirmId === firmId) return merge.targetName;
    if (firm?.read.firm.id === firmId) return firm.read.firm.name;
    const onBoard = pipeline?.columns.flatMap(column => column.firms).find(entry => entry.id === firmId);
    if (onBoard !== undefined) return onBoard.name;
    const firms = await deps.api.read('/firms', value => firmListResponseSchema.parse(value));
    return (firms.ok ? firms.value.firms.find(entry => entry.id === firmId)?.name : undefined) ?? firmId;
  };

  const snapshot = async (): Promise<CrmState> => {
    const session = await deps.session.state();
    return {
      screen,
      role: session.device?.role ?? 'salesperson',
      online: session.online,
      mayMutate: session.mayMutate,
      notice,
      firm,
      pipeline,
      merge,
      addFirm: addFirmView,
      import: importView,
      sequences: screen === 'firm' ? sequences : null,
    };
  };

  /**
   * The Firm page's Sequences section (lane g88, audit G03): the published versions, by
   * the sequence's name, and the live enrollments at this firm. Three existing reads —
   * `/sequences`, each sequence's `/sequences/versions`, and `/enrollments` for the firm —
   * rather than a new endpoint, because a founder has a handful of sequences. A read that
   * fails leaves the section saying so, never an empty list that reads as "none".
   */
  const loadSequences = async (firmId: string): Promise<void> => {
    const list = await deps.api.read('/sequences', value => sequencesResponseSchema.parse(value));
    const enrolled = await deps.api.read('/enrollments', value => enrollmentsResponseSchema.parse(value), { firmId });
    if (!list.ok || !enrolled.ok) {
      sequences = { published: [], enrollments: [], readError: list.ok ? (enrolled.ok ? null : enrolled.reason) : list.reason };
      return;
    }
    const labels = new Map<string, string>();
    const published: { sequenceVersionId: string; label: string }[] = [];
    for (const sequence of list.value.sequences.slice(0, FIRM_PAGE_SEQUENCE_LIMIT)) {
      if (sequence.archivedAt !== null) continue;
      const versions = await deps.api.read('/sequences/versions', value => sequenceVersionsResponseSchema.parse(value), {
        sequenceId: sequence.id,
      });
      if (!versions.ok) {
        sequences = { published: [], enrollments: [], readError: versions.reason };
        return;
      }
      for (const version of versions.value.versions) {
        const label = `${sequence.name} v${String(version.version)}`;
        labels.set(version.id, label);
        if (version.state === 'published') published.push({ sequenceVersionId: version.id, label });
      }
    }
    sequences = {
      published,
      enrollments: enrolled.value.enrollments.map(entry => ({
        enrollmentId: entry.id,
        contactId: entry.contactId,
        label: labels.get(entry.sequenceVersionId) ?? 'A sequence',
        state: entry.state,
        startedAt: entry.startedAt,
      })),
      readError: null,
    };
  };

  /** Leave Add firm and Import, and let the file's text go. */
  const leaveCapture = (): void => {
    addFirmView = null;
    importView = null;
    importCsv = null;
    importCommandIds = new Map();
  };

  const loadFirm = async (firmId: string): Promise<void> => {
    // Lane g90: the second version, whose routes carry their technical validation.
    const page = await deps.api.read('/crm/firm-page', value => firmPageResponseSchema.parse(value), {
      firmId,
      pageVersion: FIRM_PAGE_VERSION,
    });
    if (!page.ok) {
      notice = page.reason;
      return;
    }
    firm = page.value;
    if (page.value.visibility === 'assigned_or_admin' && page.value.opportunity !== null) {
      opportunityIdByFirmId[page.value.read.firm.id] = page.value.opportunity.id;
    }
    screen = 'firm';
    sequences = null;
    if (page.value.visibility === 'assigned_or_admin') await loadSequences(page.value.read.firm.id);
  };

  const loadPipeline = async (): Promise<void> => {
    // One read. The API decides which firms are in it, which columns exist and which
    // ids this caller may act on; nothing here adds to any of the three.
    const board = await deps.api.read('/pipeline/board', value => pipelineBoardResponseSchema.parse(value), {});
    if (board.ok) {
      pipeline = {
        columns: board.value.columns.map(column => ({ stage: column.stage, firms: column.firms })),
        // The server's map first, then anything a Firm page told this window. The
        // two agree for a firm in both; the fallback only ever adds a firm the
        // person has already opened, which is a firm they were already permitted
        // to see the opportunity of.
        opportunityIdByFirmId: { ...opportunityIdByFirmId, ...board.value.opportunityIdByFirmId },
        unplacedFirms: board.value.unplacedFirms,
      };
      screen = 'pipeline';
      return;
    }

    // The board endpoint is not answering. Rather than show nothing, fall back to
    // the two reads that built this view before it existed; every column then
    // renders `stage-change-unavailable` except the firms already opened.
    const stages = await deps.api.read('/pipeline/stages', value => pipelineStagesResponseSchema.parse(value));
    if (!stages.ok) {
      notice = stages.reason;
      return;
    }
    const firms = await deps.api.read('/firms', value => firmListResponseSchema.parse(value));
    pipeline = pipelineViewOf(stages.value.stages, firms.ok ? firms.value.firms : [], opportunityIdByFirmId);
    screen = 'pipeline';
  };

  return {
    async state() {
      if (pipeline === null && firm === null) await loadPipeline();
      return await snapshot();
    },

    async openFirm(input) {
      notice = null;
      leaveCapture();
      await loadFirm(input.firmId);
      return await snapshot();
    },

    async openPipeline() {
      notice = null;
      leaveCapture();
      await loadPipeline();
      return await snapshot();
    },

    async openAddFirm() {
      notice = null;
      leaveCapture();
      addFirmView = { draft: EMPTY_ADD_FIRM, issues: [], duplicateFirmId: null };
      screen = 'add_firm';
      return await snapshot();
    },

    async addFirm(input) {
      const answer = await deps.api.command('/crm/firms/add', addFirmBody(input), value => addFirmResultSchema.parse(value));
      if (answer.ok) {
        // Added: the window moves to the new firm's page, which is the proof it exists.
        addFirmView = null;
        notice = 'firm_added';
        await loadFirm(answer.value.firmId);
        return await snapshot();
      }
      // Refused: the form comes back with what was typed and every field the server named.
      const refusal = answer.offline ? null : addFirmRefusalSchema.safeParse(answer.refusal);
      addFirmView = {
        draft: input,
        issues: refusal?.success === true ? (refusal.data.issues ?? []) : [],
        duplicateFirmId: refusal?.success === true ? (refusal.data.firmId ?? null) : null,
      };
      notice = answer.reason;
      screen = 'add_firm';
      return await snapshot();
    },

    async openImport() {
      notice = null;
      leaveCapture();
      importView = { fileName: null, preview: null, fileRefusal: null, results: null };
      screen = 'import';
      return await snapshot();
    },

    async previewImport(input) {
      notice = null;
      screen = 'import';
      if (input.csv.length > MAX_IMPORT_FILE_CHARACTERS) {
        // The API's own bound on the file (`importPreviewRequestSchema`), said before the
        // file is sent rather than as a 400 about a body.
        importCsv = null;
        importCommandIds = new Map();
        importView = { fileName: input.fileName, preview: null, fileRefusal: null, results: null };
        notice = 'import_file_too_large';
        return await snapshot();
      }
      const answer = await deps.api.read('/import/preview', value => importPreviewResponseSchema.parse(value), {
        csv: input.csv,
      });
      if (answer.ok) {
        importCsv = input.csv;
        // One id per row that may commit, minted once per preview: pressing Import again on
        // the same preview replays what landed rather than importing it twice (5.3).
        importCommandIds = new Map(
          answer.value.rows
            .filter(row => row.outcome === 'create' || row.outcome === 'attach')
            .map(row => [row.rowNumber, randomUUID()] as const),
        );
        importView = { fileName: input.fileName, preview: answer.value, fileRefusal: null, results: null };
        return await snapshot();
      }
      importCsv = null;
      importCommandIds = new Map();
      const fileRefusal = answer.offline ? null : fileRefusalOf(answer.refusal);
      importView = { fileName: input.fileName, preview: null, fileRefusal, results: null };
      notice = fileRefusal === null ? answer.reason : null;
      return await snapshot();
    },

    async commitImport() {
      const preview = importView?.preview ?? null;
      const rows =
        preview === null
          ? []
          : preview.rows
              .filter(row => row.outcome === 'create' || row.outcome === 'attach')
              .map(row => ({ rowNumber: row.rowNumber, commandId: importCommandIds.get(row.rowNumber) ?? randomUUID() }));
      if (importCsv === null || importView === null || rows.length === 0) {
        notice = 'import_nothing_to_commit';
        return await snapshot();
      }
      // Not `command`: the envelope is one command id per row, which the server hashes
      // each row's receipt under, and a request-level id would be refused as malformed.
      const answer = await deps.api.read('/import/commit', value => importCommitResponseSchema.parse(value), {
        clientVersion: deps.clientVersion,
        csv: importCsv,
        rows,
      });
      if (!answer.ok) {
        const fileRefusal = answer.offline ? null : fileRefusalOf(answer.refusal);
        if (fileRefusal !== null) importView = { ...importView, fileRefusal };
        notice = fileRefusal === null ? answer.reason : null;
        return await snapshot();
      }
      importView = { ...importView, results: answer.value };
      notice = answer.value.counts.refused === 0 ? 'imported' : 'imported_with_refusals';
      return await snapshot();
    },

    async saveContact(input) {
      const answer = await deps.api.command('/contacts/update', contactPatchBody(input), () => null);
      notice = answer.ok ? 'saved' : answer.reason;
      if (answer.ok && firm !== null) await loadFirm(firm.read.firm.id);
      return await snapshot();
    },

    /**
     * "Add to pipeline" (lane g88): open the firm's opportunity at the first stage. An
     * enrolment serves an open opportunity (11.2), and a firm just added has none.
     */
    async openOpportunity() {
      if (firm === null) {
        notice = 'firm_unknown';
        return await snapshot();
      }
      const firmId = firm.read.firm.id;
      const answer = await deps.api.command('/opportunities/open', { firmId }, () => null);
      notice = answer.ok ? 'opportunity_opened' : answer.reason;
      await loadFirm(firmId);
      return await snapshot();
    },

    /**
     * Enrol a contact of the open Firm page (lane g88, audit G03). The firm and its open
     * opportunity are the page's, never the window's word; the server decides everything
     * else — the version is published, the contact has no live enrolment, the firm's zone
     * is known — and its refusal is the notice.
     */
    async enroll(input) {
      const page = firm;
      if (page === null || page.visibility !== 'assigned_or_admin' || page.opportunity?.status !== 'open') {
        notice = 'opportunity_not_open';
        return await snapshot();
      }
      const answer = await deps.api.command(
        '/enrollments/enroll',
        {
          sequenceVersionId: input.sequenceVersionId,
          opportunityId: page.opportunity.id,
          firmId: page.read.firm.id,
          contactId: input.contactId,
        },
        () => null,
      );
      notice = answer.ok ? 'enrolled' : answer.reason;
      await loadFirm(page.read.firm.id);
      return await snapshot();
    },

    /** "Confirm this number" (lane g88): the phone route at the version the page showed. */
    async confirmRoute(input) {
      const answer = await deps.api.command(
        '/contacts/routes/confirm',
        { routeKind: 'phone', routeId: input.routeId, routeVersion: input.routeVersion },
        () => null,
      );
      notice = answer.ok ? 'route_confirmed' : answer.reason;
      if (firm !== null) await loadFirm(firm.read.firm.id);
      return await snapshot();
    },

    /**
     * "Check again" (lane g90): one more check of an address at the version the page
     * showed. The route's own refusals are said about an address, not a number.
     */
    async checkRoute(input) {
      const answer = await deps.api.command(
        '/contacts/routes/check',
        { routeKind: 'email', routeId: input.routeId, routeVersion: input.routeVersion },
        () => null,
      );
      notice = answer.ok ? 'route_check_queued' : (ADDRESS_REFUSAL_NOTICES[answer.reason] ?? answer.reason);
      if (firm !== null) await loadFirm(firm.read.firm.id);
      return await snapshot();
    },

    async changeStage(input) {
      const answer = await deps.api.command(
        '/opportunities/stage',
        {
          opportunityId: input.opportunityId,
          toStageKey: input.toStageKey,
          ...(input.reason === null ? {} : { reason: input.reason }),
        },
        () => null,
      );
      notice = answer.ok ? 'stage_changed' : answer.reason;
      if (answer.ok) await loadPipeline();
      return await snapshot();
    },

    async resolveMerge(input) {
      const answer = await deps.api.command(
        '/merges/firms',
        {
          sourceFirmId: input.sourceFirmId,
          targetFirmId: input.targetFirmId,
          resolutions: input.resolutions,
        },
        () => null,
      );
      if (answer.ok) {
        notice = 'merged';
        merge = null;
        await loadFirm(input.targetFirmId);
        return await snapshot();
      }
      // A merge refused for conflicts is not an error: it is the screen. G3b's
      // `firmMerge.ts` renders the list and will not submit until every field has
      // been decided (7.2: "Conflicts are shown for resolution").
      //
      // Until lane g78 this line was all there was: the transport kept only the code,
      // `merge` was never set, and the conflict screen could not appear (D05). The
      // refusal's body now travels with it, and a replay carries the conflicts too.
      notice = answer.reason;
      const conflicts = conflictsOf(answer.offline ? null : answer.refusal);
      if (conflicts.length > 0) {
        merge = {
          sourceFirmId: input.sourceFirmId,
          sourceName: await firmNameOf(input.sourceFirmId),
          targetFirmId: input.targetFirmId,
          targetName: await firmNameOf(input.targetFirmId),
          conflicts,
        };
        screen = 'merge';
      }
      return await snapshot();
    },
  };
}

/** Turn a refused merge body into the conflicts screen, when it carries them. */
export function conflictsOf(body: unknown): readonly MergeConflict[] {
  const parsed = mergeRefusalSchema.safeParse(body);
  return parsed.success ? (parsed.data.conflicts ?? []) : [];
}
