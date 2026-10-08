/**
 * Where the one window is (wave 1, lane W1-D; Settings since 1.0.12).
 *
 * Until wave 1 every sidebar row opened its own `BrowserWindow`. There is one window now,
 * with the sidebar always on its left, and the column on its right shows one view at a
 * time. A route names that view: the sidebar sets it, the Window menu's ⌘1–⌘5 and ⌘, and
 * a deep link set it through `callie:navigate`, and a Today or reply card sets it to the
 * firm it is about.
 *
 * Administration and the Dashboard were two of the six routes until 1.0.12; they are now
 * two of Settings' three tabs, and `settings/<tab>` is the route. The old names are still
 * understood — `admin`, `admin/<section>` and `dashboard` are links that exist on the
 * owner's Mac and menu items people have learned — and each maps onto the tab that holds
 * what it used to open.
 *
 * Today can name an exact reply, meeting or owned sender setting. Those identities
 * survive route serialization; the destination reads the current authorized context.
 *
 * Since 1.0.14 the board and the firms are two routes rather than one (David, 29
 * September 2026). `pipeline` is the board of opportunities being worked; `firms` is
 * every firm on file, the cold ones included; `firm/<id>` is one firm's page and lights
 * Firms up, wherever it was opened from.
 */

import { SETTINGS_TABS, routeNameOf, type RouteName, type SettingsTab } from '../shared/contract.ts';
import type {TodayActionTarget} from '@fss/contracts';

export { NAVIGATION_TARGETS, ROUTE_NAMES, SETTINGS_TABS, navigationTargetOf, routeNameOf } from '../shared/contract.ts';
export type { NavigationTarget, RouteName, SettingsTab } from '../shared/contract.ts';

/** Where Settings scrolls to when Needs you opened it. */
const ADMIN_SECTIONS = ['calling-number', 'sending-admin', 'alerts'] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export type Route =
  | { readonly name: 'today' | 'pipeline' | 'firms' | 'sequences' | 'social' }
  | { readonly name: 'replies'; readonly messageId?: string }
  | { readonly name: 'firm'; readonly firmId: string; readonly meetingId?: string }
  | {
      readonly name: 'settings';
      readonly tab: SettingsTab;
      /**
       * Where inside the tab to scroll, when Needs you sent the person there. Not part
       * of the route's text: `settings/administration` is one place, whether or not
       * somebody arrived at it pointed at the calling-number section.
       */
      readonly section?: AdminSection;
      readonly mailboxId?: string;
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function routeForAction(target:TodayActionTarget):Route{
  if(target.kind==='reply')return {name:'replies',messageId:target.messageId};
  if(target.kind==='meeting')return {name:'firm',firmId:target.firmId,meetingId:target.meetingId};
  return {name:'settings',tab:target.tab,section:target.section,mailboxId:target.mailboxId};
}

/** The tab that holds what an old `admin/<section>` link used to open. */
function tabForSection(section: AdminSection): SettingsTab {
  return section === 'alerts' ? 'diagnostics' : 'administration';
}

const settingsTabOf = (value: string | undefined): SettingsTab | null =>
  SETTINGS_TABS.find(tab => tab === value) ?? null;

const sectionOf = (value: string | undefined): AdminSection | null =>
  ADMIN_SECTIONS.find(section => section === value) ?? null;

/** `today`, `firm/<uuid>`, `settings/diagnostics`, an old `admin/alerts`, or null. */
export function routeOf(text: string): Route | null {
  const [head, tail, ...rest] = text.split('/');
  if (head === 'settings' && tail === 'administration' && rest.length === 2 && rest[0] === 'sending-admin' && rest[1] !== undefined && UUID.test(rest[1])) return { name: 'settings', tab: tail, section: 'sending-admin', mailboxId: rest[1] };
  if (head === 'replies' && tail !== undefined && rest.length === 0) return UUID.test(tail) ? { name: 'replies', messageId: tail } : null;
  if (head === 'firm' && rest.length === 2 && rest[0] === 'meeting' && tail !== undefined && UUID.test(tail) && rest[1] !== undefined && UUID.test(rest[1])) return { name: 'firm', firmId: tail, meetingId: rest[1] };
  if (rest.length > 0) return null;
  if (head === 'firm') return tail !== undefined && UUID.test(tail) ? { name: 'firm', firmId: tail } : null;
  if (head === 'settings') {
    if (tail === undefined) return { name: 'settings', tab: 'administration' };
    const tab = settingsTabOf(tail);
    return tab === null ? null : { name: 'settings', tab };
  }
  // The routes 1.0.11 used. `admin/<section>` opens the tab that section lives on and
  // asks it to scroll there, which is what Needs you's Open always meant.
  if (head === 'admin') {
    if (tail === undefined) return { name: 'settings', tab: 'administration' };
    const section = sectionOf(tail);
    return section === null ? null : { name: 'settings', tab: tabForSection(section), section };
  }
  if (head === 'dashboard' && tail === undefined) return { name: 'settings', tab: 'dashboard' };
  if (tail !== undefined) return null;
  const name = routeNameOf(head);
  if (name === null) return null;
  return name === 'settings' ? { name: 'settings', tab: 'administration' } : { name };
}

export function routeText(route: Route): string {
  if (route.name === 'firm') return `firm/${route.firmId}${route.meetingId === undefined ? '' : `/meeting/${route.meetingId}`}`;
  if (route.name === 'replies' && route.messageId !== undefined) return `replies/${route.messageId}`;
  if (route.name === 'settings') return `settings/${route.tab}${route.mailboxId !== undefined && route.section === 'sending-admin' ? `/sending-admin/${route.mailboxId}` : ''}`;
  return route.name;
}

/** The sidebar row a route lights up: a firm is under Firms, every tab under Settings. */
export function sidebarRowOf(route: Route): RouteName {
  return route.name === 'firm' ? 'firms' : route.name;
}

// ---------------------------------------------------------------------------
// The shell's two entry points, for the views
// ---------------------------------------------------------------------------

/**
 * The React shell installs these once. A view calls `navigate` to go somewhere else (a
 * Today card to its firm), and `routeShown` when its own answer moved it — the CRM
 * bridge opened a firm from the board, the legacy Settings module switched its own tab —
 * so the route and the sidebar stay true without the view being mounted again.
 */
let navigateTo: (route: Route) => void = () => undefined;
let noteShown: (route: Route) => void = () => undefined;

export function setNavigator(navigate: (route: Route) => void, shown: (route: Route) => void): void {
  navigateTo = navigate;
  noteShown = shown;
}

export function navigate(route: Route): void {
  navigateTo(route);
}

export function routeShown(route: Route): void {
  noteShown(route);
}

/** What every hand-rolled view module exports. `mount` draws into `container`; `unmount` stops drawing. */
export interface View {
  mount(container: HTMLElement, route: Route): void;
  unmount(): void;
}
