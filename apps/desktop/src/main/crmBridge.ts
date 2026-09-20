import { z } from 'zod';
import {
  firmIdentityDtoSchema,
  firmPageResponseSchema,
  mergeConflictSchema,
  pipelineStageDtoSchema,
  type FirmIdentityDto,
  type MergeConflict,
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
 * The board is assembled here rather than by an endpoint. There is no `/pipeline/board`
 * in the API and this lane does not own one; what exists is the configured stages and
 * the firm list, and putting the firms into their columns is presentation. The one
 * thing it must not invent is *which* firms a person may see — that is the list the
 * API returned, and nothing here adds to it.
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

const stagesSchema = z.object({ stages: z.array(pipelineStageDtoSchema) });
const firmsSchema = z.object({ firms: z.array(firmIdentityDtoSchema) });
const mergeRefusalSchema = z.object({ conflicts: z.array(mergeConflictSchema) });

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
 * `opportunityIdByFirmId` is what lets a column offer a stage change, and it is
 * deliberately sparse. `GET /firms` returns `FirmIdentityDto`, which carries the open
 * opportunity's *stage* and not its id — Appendix F's first row is about what a
 * colleague may see, and an id is not on it. So the only opportunity ids this window
 * has are the ones a Firm page gave it, and every other column renders G3b's
 * `stage-change-unavailable`. See `docs/decisions/g6-pipeline-board-opportunity-ids.md`;
 * closing the gap is a change to the CRM read, which is not this lane's.
 */
export function pipelineViewOf(
  stages: readonly z.infer<typeof pipelineStageDtoSchema>[],
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
    const stages = await deps.api.read('/pipeline/stages', value => stagesSchema.parse(value));
    if (!stages.ok) {
      notice = stages.reason;
      return;
    }
    // The same read the Firm list uses, and the same visibility: the API decides who
    // is in it, and this only puts them into columns.
    const firms = await deps.api.read('/firms', value => firmsSchema.parse(value));
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
      notice = answer.reason;
      return await snapshot();
    },
  };
}

/** Turn a refused merge body into the conflicts screen, when it carries them. */
export function conflictsOf(body: unknown): readonly MergeConflict[] {
  const parsed = mergeRefusalSchema.safeParse(body);
  return parsed.success ? parsed.data.conflicts : [];
}
