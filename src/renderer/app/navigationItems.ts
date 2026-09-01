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

import type { AppRoute } from './routes';

export type NavigationItem = {
  route: AppRoute;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
};

/**
 * Single source of truth for primary destinations. The navigation rail and
 * the command palette both render from this list so they can never disagree
 * about which routes exist or which are still disabled.
 */
export const navigationItems: readonly NavigationItem[] = [
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
