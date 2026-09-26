/**
 * Where the one window is (wave 1, lane W1-D).
 *
 * Until wave 1 every sidebar row opened its own `BrowserWindow`. There is one window now,
 * with the sidebar always on its left, and the column on its right shows one view at a
 * time. A route names that view: the sidebar sets it, the Window menu's ⌘1–⌘6 and a
 * deep link set it through `callie:navigate`, and a Today or reply card sets it to the
 * firm it is about.
 *
 * The six names the menu and the deep links may use are a closed set. `firm/<id>` is the
 * one route with an argument, and only the page sets it — never the main process.
 */

import { routeNameOf, type RouteName } from '../shared/contract.ts';

export { ROUTE_NAMES, routeNameOf, type RouteName } from '../shared/contract.ts';

/** Where Administration scrolls to when Needs you opened it. */
export const ADMIN_SECTIONS = ['calling-number', 'sending-admin', 'alerts'] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

export type Route =
  | { readonly name: 'today' | 'replies' | 'firms' | 'sequences' | 'dashboard' }
  | { readonly name: 'firm'; readonly firmId: string }
  | { readonly name: 'admin'; readonly section?: AdminSection };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `today`, `firm/<uuid>`, `admin/calling-number`…, or null for anything else. */
export function routeOf(text: string): Route | null {
  const [head, tail, ...rest] = text.split('/');
  if (rest.length > 0) return null;
  if (head === 'firm') return tail !== undefined && UUID.test(tail) ? { name: 'firm', firmId: tail } : null;
  if (head === 'admin' && tail !== undefined) {
    const section = ADMIN_SECTIONS.find(entry => entry === tail);
    return section === undefined ? null : { name: 'admin', section };
  }
  if (tail !== undefined) return null;
  const name = routeNameOf(head);
  return name === null ? null : name === 'admin' ? { name: 'admin' } : { name };
}

export function routeText(route: Route): string {
  if (route.name === 'firm') return `firm/${route.firmId}`;
  if (route.name === 'admin' && route.section !== undefined) return `admin/${route.section}`;
  return route.name;
}

/** The sidebar row a route lights up: a firm is under Firms. */
export function sidebarRowOf(route: Route): RouteName {
  return route.name === 'firm' ? 'firms' : route.name;
}

// ---------------------------------------------------------------------------
// The shell's two entry points, for the views
// ---------------------------------------------------------------------------

/**
 * `renderer.ts` installs these once. A view calls `navigate` to go somewhere else (a
 * Today card to its firm), and `routeShown` when its own answer moved it — the CRM
 * bridge opened a firm from the board — so the route and the sidebar stay true without
 * the view being mounted again.
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

/** What every view module exports. `mount` draws into `container`; `unmount` stops drawing. */
export interface View {
  mount(container: HTMLElement, route: Route): void;
  unmount(): void;
}
