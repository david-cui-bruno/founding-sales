import {
  CalendarCheck2,
  ChartColumn,
  ClipboardCheck,
  GraduationCap,
  MessagesSquare,
  Settings,
  SquareKanban,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { MouseEvent } from 'react';

import { routeHash, type AppRoute } from './routes';

type NavigationItem = {
  route: AppRoute;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
};

const navigationItems: readonly NavigationItem[] = [
  { route: 'today', label: 'Today', icon: CalendarCheck2, enabled: true },
  { route: 'leads', label: 'Leads', icon: Users, enabled: true },
  { route: 'pipeline', label: 'Pipeline', icon: SquareKanban, enabled: true },
  {
    route: 'conversations',
    label: 'Conversations',
    icon: MessagesSquare,
    enabled: false,
  },
  { route: 'learnings', label: 'Learnings', icon: GraduationCap, enabled: false },
  { route: 'friday', label: 'Friday', icon: ChartColumn, enabled: true },
  { route: 'review', label: 'Review', icon: ClipboardCheck, enabled: true },
  { route: 'settings', label: 'Settings', icon: Settings, enabled: true },
];

export type NavigationRailProps = {
  route: AppRoute;
  onNavigate(route: AppRoute): void;
  reviewCount: number;
};

/**
 * Fixed primary navigation. Anchors are real hash links handled in-window;
 * unbuilt destinations stay visible but disabled instead of routing to blank
 * screens.
 */
export function NavigationRail({
  route,
  onNavigate,
  reviewCount,
}: NavigationRailProps) {
  const onItemClick =
    (item: NavigationItem) => (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      if (item.enabled) {
        onNavigate(item.route);
      }
    };

  return (
    <nav className="nav-rail" aria-label="Primary">
      <p className="nav-rail__brand" aria-hidden="true">
        Callie
      </p>
      <ul className="nav-rail__list">
        {navigationItems.map((item) => {
          const Icon = item.icon;
          const current = item.route === route;

          return (
            <li key={item.route}>
              <a
                className={
                  current
                    ? 'nav-rail__item nav-rail__item--current'
                    : 'nav-rail__item'
                }
                href={routeHash(item.route)}
                aria-current={current ? 'page' : undefined}
                aria-disabled={item.enabled ? undefined : 'true'}
                title={item.enabled ? undefined : `${item.label} is coming soon`}
                onClick={onItemClick(item)}
              >
                <Icon className="nav-rail__icon" aria-hidden="true" size={18} />
                <span className="nav-rail__label">{item.label}</span>
                {item.route === 'review' && reviewCount > 0 && (
                  <span className="nav-rail__badge" aria-label={`${reviewCount} items awaiting review`}>
                    {reviewCount}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
