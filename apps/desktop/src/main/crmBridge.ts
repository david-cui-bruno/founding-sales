import {
  firmListResponseSchema,
  firmPageResponseSchema,
  mergeRefusalSchema,
  pipelineBoardResponseSchema,
  pipelineStagesResponseSchema,
  type FirmIdentityDto,
  type MergeConflict,
  type PipelineStageDto,
} from '@fss/contracts';
import type {
  ContactEdit,
  CrmScreen,
  CrmState,
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
 */

export const CRM_IPC_CHANNELS = {
  state: 'callie:crm:state',
  openFirm: 'callie:crm:open-firm',
  openPipeline: 'callie:crm:open-pipeline',
  saveContact: 'callie:crm:save-contact',
  changeStage: 'callie:crm:change-stage',
  resolveMerge: 'callie:crm:resolve-merge',
} as const;
export type CrmIpcChannel = (typeof CRM_IPC_CHANNELS)[keyof typeof CRM_IPC_CHANNELS];

/*
 * The stage list, the firm list, G9's board and a refused merge are parsed with
 * `@fss/contracts`' schemas for their routes (lane g78), the ones the routes' own tests
 * hold the real answers to. The board's id map is ids to ids, not any strings.
 */

export interface CrmBridgeDeps {
  readonly api: AuthedClient;
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
    };
  };

  const loadFirm = async (firmId: string): Promise<void> => {
    const page = await deps.api.read('/crm/firm-page', value => firmPageResponseSchema.parse(value), { firmId });
    if (!page.ok) {
      notice = page.reason;
      return;
    }
    firm = page.value;
    if (page.value.visibility === 'assigned_or_admin' && page.value.opportunity !== null) {
      opportunityIdByFirmId[page.value.read.firm.id] = page.value.opportunity.id;
    }
    screen = 'firm';
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
      await loadFirm(input.firmId);
      return await snapshot();
    },

    async openPipeline() {
      notice = null;
      await loadPipeline();
      return await snapshot();
    },

    async saveContact(input) {
      const answer = await deps.api.command(
        '/contacts/update',
        {
          contactId: input.contactId,
          fullName: input.fullName,
          ...(input.title === null ? {} : { title: input.title }),
          ...(input.makePrimary ? { isPrimary: true } : {}),
        },
        () => null,
      );
      notice = answer.ok ? 'saved' : answer.reason;
      if (answer.ok && firm !== null) await loadFirm(firm.read.firm.id);
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
