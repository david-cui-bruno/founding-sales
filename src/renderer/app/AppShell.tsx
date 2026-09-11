import type { ReviewBadgeState } from './useReviewSummary';
import type { ReactNode } from 'react';

import { NavigationRail } from './NavigationRail';
import type { AppRoute } from './routes';

export type AppShellProps = {
  route: AppRoute;
  onNavigate(route: AppRoute): void;
  reviewCount: ReviewBadgeState;
  children: ReactNode;
};

/**
 * Route-independent application frame: skip link, fixed navigation rail,
 * and the single labelled main content region. Route toolbars live in each
 * route's PageHeader; there is no shared top bar.
 */
export function AppShell({
  route,
  onNavigate,
  reviewCount,
  children,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <a className="app-shell__skip-link" href="#main-content">
        Skip to content
      </a>
      <NavigationRail
        route={route}
        onNavigate={onNavigate}
        reviewCount={reviewCount}
      />
      <div className="app-shell__workspace">
        <main tabIndex={-1} id="main-content" className="app-shell__main">
          {children}
        </main>
      </div>
    </div>
  );
}
