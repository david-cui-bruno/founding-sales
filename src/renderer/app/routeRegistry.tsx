import type { ReactNode } from 'react';

import type { CalliePreloadApi } from '../../shared/preload';
import { AppleSpikePanel } from '../appleSpike/AppleSpikePanel';
import { DiagnosticsScreen } from '../foundation/DiagnosticsScreen';
import type { FoundationHealth } from '../foundation/useFoundationHealth';
import { FridayRoute } from '../features/friday/FridayRoute';
import { LeadFullPage } from '../features/leadInspector/LeadFullPage';
import { LeadsRoute } from '../features/leads/LeadsRoute';
import { PipelineRoute } from '../features/pipeline/PipelineRoute';
import { ReviewRoute } from '../features/review/ReviewRoute';
import { TodayRoute } from '../features/today/TodayRoute';
import type { AppRoute } from './routes';

export type RouteContext = {
  api: CalliePreloadApi;
  health: FoundationHealth;
  openLead(personId: string): void;
  openImport(): void;
  onReviewCountChange(count: number): void;
};

/**
 * Central route table. Conversations and Learnings stay disabled navigation
 * entries with their own approved plans; they never render blank screens.
 */
export function renderRoute(route: AppRoute, context: RouteContext): ReactNode {
  switch (route) {
    case 'today':
      return <TodayRoute api={context.api.today} onOpenLead={context.openLead} />;
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
    case 'review':
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
        <DiagnosticsScreen
          state={
            context.health.status === 'ready'
              ? { status: 'ready', health: context.health.health }
              : { status: context.health.status }
          }
          onRetry={context.health.retry}
        >
          <AppleSpikePanel api={context.api.appleSpike} />
        </DiagnosticsScreen>
      );
    case 'conversations':
    case 'learnings':
      // Disabled navigation entries cannot be reached through the rail; a
      // direct hash still lands on truthful copy instead of a blank screen.
      return (
        <section aria-labelledby="unavailable-route-title">
          <h1 id="unavailable-route-title">Coming soon</h1>
          <p>This workspace ships with its own implementation plan.</p>
        </section>
      );
  }
}

export { LeadFullPage };
