import {
  CalendarCheck2,
  ClipboardCheck,
  Settings,
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
  { route: 'accounts', label: 'Accounts', icon: Users, enabled: true },
  { route: 'campaigns', label: 'Campaigns', icon: ClipboardCheck, enabled: true },
  { route: 'settings', label: 'Settings', icon: Settings, enabled: true },
];
