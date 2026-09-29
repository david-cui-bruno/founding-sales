import {
  researchFirmResponseSchema,
  researchRunResultSchema,
  researchAddLinkResultSchema,
  researchSettingsResultSchema,
} from '@fss/contracts';
import {
  researchStateSchema,
  type ResearchFirmView,
  type ResearchState,
} from '../renderer/researchContract.ts';
import type { AuthedClient } from './authedClient.ts';
import type { ApiOutcome } from './apiClient.ts';

/**
 * Research's half of the bridge, in the main process (lane R; specification 14.2).
 *
 * The window sees a `ResearchState` and nothing else: no access token, no command id,
 * and no way to ask for anything this file does not offer. What it offers is four
 * things — read a firm's research, run it again, add a link, read or change the
 * settings — and the list is the authority boundary in its most enforceable form.
 * There is no operation that enrols, sends, dials, creates a contact or promotes a
 * route, and a bridge that cannot name them cannot be talked into them.
 *
 * Three decisions are worth naming.
 *
 * **Nothing here is cached.** A brief holds quotes from a firm's pages and the name of
 * a person at it, so it is read from the cloud each time and is simply absent without
 * it. `ResearchState` is not part of `DesktopState` and cannot reach the encrypted
 * 24-hour cache at all (5.3).
 *
 * **A source URL is never opened from here.** The section renders the source as an
 * ordinary link and `app.ts`'s `setWindowOpenHandler` hands an `https:` URL to
 * `shell.openExternal` — the seam that already exists. There is no new channel,
 * because a channel that opens a URL the renderer chose is exactly what that handler
 * was narrowed to prevent in 1.0.12.
 *
 * **The settings read is the settings command.** `/research/settings` answers `{}` and
 * updates fields through one admin-only path, so this bridge has one method for both
 * and a salesperson is given `settings: null` rather than a refusal to render.
 */

export interface ResearchBridgeDeps {
  readonly api: AuthedClient;
  /** The session manager: the token, the version gate, the online rule, the role. */
  readonly session: {
    state(): Promise<{
      readonly online: boolean;
      readonly mayMutate: boolean;
      readonly device: { readonly role: 'admin' | 'salesperson' } | null;
    }>;
  };
}

export interface ResearchSettingsPatch {
  readonly enabled?: boolean | undefined;
  readonly dailyFirmCeiling?: number | undefined;
  readonly dailyCostCeilingCents?: number | undefined;
  readonly monthlyCostCeilingCents?: number | undefined;
  readonly maxPagesPerFirm?: number | undefined;
}

export interface ResearchBridgeHost {
  /** Drop everything on an identity transition (1.0.13, P0-A). */
  forget(): Promise<ResearchState>;
  state(): Promise<ResearchState>;
  open(input: { readonly firmId: string }): Promise<ResearchState>;
  run(input: { readonly firmId: string }): Promise<ResearchState>;
  addLink(input: { readonly firmId: string; readonly url: string }): Promise<ResearchState>;
  saveSettings(input: ResearchSettingsPatch): Promise<ResearchState>;
}

export function createResearchBridge(deps: ResearchBridgeDeps): ResearchBridgeHost {
  let firm: ResearchFirmView | null = null;
  let settings: ResearchState['settings'] = null;
  let worstCaseRunCents: number | null = null;
  let spend: ResearchState['spend'] = null;
  let notice: string | null = null;
  let role: ResearchState['role'] = null;

  const snapshot = async (): Promise<ResearchState> => {
    const session = await deps.session.state();
    const seen = session.device?.role ?? null;
    // A role that changed under an open window drops what was read under the old one:
    // an admin's budget is not a salesperson's to keep looking at (the rule
    // `settingsBridge.ts` follows for the same reason).
    if (seen !== role) {
      role = seen;
      settings = null;
      worstCaseRunCents = null;
    }
    return researchStateSchema.parse({
      firm,
      settings,
      worstCaseRunCents,
      spend,
      notice,
      mayMutate: session.mayMutate,
      role,
    });
  };

  const note = (outcome: ApiOutcome<unknown>, accepted: string | null): boolean => {
    notice = outcome.ok ? accepted : outcome.reason;
    return outcome.ok;
  };

  const load = async (firmId: string): Promise<void> => {
    const answer = await deps.api.read('/research/firm', value => researchFirmResponseSchema.parse(value), { firmId });
    if (!answer.ok) {
      // A refusal is an answer: `not_found` is a firm this person may not see, and the
      // section shows nothing rather than an empty list that claims there is nothing.
      firm = null;
      spend = null;
      note(answer, null);
      return;
    }
    firm = {
      firmId,
      brief: answer.value.brief,
      facts: answer.value.facts,
      judgments: answer.value.judgments,
      runs: answer.value.runs,
      links: answer.value.links,
    };
    spend = answer.value.spend;
    notice = null;
  };

  /** Admin only, and a salesperson is simply not asked: the read is the budget. */
  const loadSettings = async (patch: ResearchSettingsPatch): Promise<boolean> => {
    const answer = await deps.api.command('/research/settings', { ...patch }, value =>
      researchSettingsResultSchema.parse(value),
    );
    if (!answer.ok) {
      settings = null;
      worstCaseRunCents = null;
      return note(answer, null);
    }
    settings = answer.value.settings;
    worstCaseRunCents = answer.value.worstCaseRunCents;
    spend = answer.value.spend;
    notice = null;
    return true;
  };

  return {
    async forget() {
      firm = null;
      settings = null;
      worstCaseRunCents = null;
      spend = null;
      notice = null;
      role = null;
      return await snapshot();
    },

    state: snapshot,

    async open(input) {
      await load(input.firmId);
      // The settings ride along for an admin, so the section can show the month's
      // spend beside the firm without a second round trip. A salesperson is not asked.
      const session = await deps.session.state();
      if (session.device?.role === 'admin' && settings === null) {
        const kept = notice;
        await loadSettings({});
        notice = kept;
      }
      return await snapshot();
    },

    async run(input) {
      const answer = await deps.api.command('/research/firm/run', { firmId: input.firmId }, value =>
        researchRunResultSchema.parse(value),
      );
      if (note(answer, 'research_queued')) {
        // Re-read, keeping the command's notice: the run is queued, so the page gains
        // a `running` row rather than a brief. The server decided, not us.
        const kept = notice;
        await load(input.firmId);
        notice = kept;
      }
      return await snapshot();
    },

    async addLink(input) {
      const url = input.url.trim();
      const answer = await deps.api.command('/research/firm/links/add', { firmId: input.firmId, url }, value =>
        researchAddLinkResultSchema.parse(value),
      );
      if (note(answer, 'research_link_added')) {
        const kept = notice;
        await load(input.firmId);
        notice = kept;
      }
      return await snapshot();
    },

    async saveSettings(input) {
      await loadSettings(input);
      if (notice === null && Object.keys(input).length > 0) notice = 'research_settings_saved';
      return await snapshot();
    },
  };
}
