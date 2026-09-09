import type { ReactNode } from 'react';

import type { CalliePreloadApi } from '../../shared/preload';
import { AppleSpikePanel } from '../appleSpike/AppleSpikePanel';
import { SettingsScreen } from '../foundation/SettingsScreen';
import { SourcingStatusRow } from '../foundation/SourcingStatusRow';
import type { FoundationHealth } from '../foundation/useFoundationHealth';
import { ConversationsRoute } from '../features/conversations/ConversationsRoute';
import { FridayRoute } from '../features/friday/FridayRoute';
import { LeadFullPage } from '../features/leadInspector/LeadFullPage';
import { LeadsRoute } from '../features/leads/LeadsRoute';
import { LearningsRoute } from '../features/learnings/LearningsRoute';
import { PipelineRoute } from '../features/pipeline/PipelineRoute';
import { ReviewRoute } from '../features/review/ReviewRoute';
import { TodayRoute } from '../features/today/TodayRoute';
import { NativeDeskRoute } from '../features/today/NativeDeskRoute';
import type { AppRoute } from './routes';
import type { DensityState } from './useDensity';
import type { ThemeState } from './useTheme';

export type RouteContext = {
  api: CalliePreloadApi;
  health: FoundationHealth;
  theme: ThemeState;
  density: DensityState;
  openLead(personId: string): void;
  openImport(): void;
  onReviewCountChange(count: number): void;
};

/** Central route table. Every navigation entry renders a real workspace. */
export function renderRoute(route: AppRoute, context: RouteContext): ReactNode {
  switch (route) {
    case 'today':
      return (
        <TodayRoute
          api={context.api.today}
          workspaceApi={context.api.daily ? context.api : undefined}
          discoveryApi={context.api.discovery}
          leadApi={context.api.leadDetail}
          onOpenLead={context.openLead}
        />
      );
    case 'accounts':
    case 'campaigns':
      return <NativeDeskRoute api={context.api} surface={route} onOpenLead={context.openLead} />;
    case 'leads':
      return (
        <LeadsRoute
          api={context.api.leads}
          onOpenLead={context.openLead}
          onOpenImport={context.openImport}
        />
      );
    case 'pipeline':
      return (
        <PipelineRoute api={context.api.pipeline} onOpenLead={context.openLead} />
      );
    case 'conversations':
      return (
        <ConversationsRoute
          api={context.api.conversations}
          onOpenLead={context.openLead}
        />
      );
    case 'learnings':
      return (
        <LearningsRoute
          api={context.api.learnings}
          onOpenLead={context.openLead}
        />
      );
    case 'inbox':
      return (
        <ReviewRoute
          api={context.api.review}
          onOpenLead={context.openLead}
          onOpenCountChange={context.onReviewCountChange}
        />
      );
    case 'friday':
      return <FridayRoute api={context.api.friday} onOpenLead={context.openLead} />;
    case 'settings':
      return (
        <SettingsScreen
          state={
            context.health.status === 'ready'
              ? { status: 'ready', health: context.health.health }
              : { status: context.health.status }
          }
          onRetry={context.health.retry}
          theme={context.theme}
          density={context.density}
          shell={context.api.shell}
          recovery={context.api.recovery}
          localWorkspaceApi={context.api.localWorkspace}
          outreachApi={context.api.outreach}
          sourcing={<SourcingStatusRow api={context.api.sourcing} />}
        >
          <AppleSpikePanel api={context.api.appleSpike} />
        </SettingsScreen>
      );
  }
}

export { LeadFullPage };
