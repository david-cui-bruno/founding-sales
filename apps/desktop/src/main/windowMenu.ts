import { ROUTE_NAMES, routeNameOf, type RouteName } from '../shared/contract.ts';

/**
 * The Window menu and the deep links, as values (lane g65; wave 1's one window).
 *
 * Their own module, with no Electron in it, so both are asserted by the unit tests
 * without loading Electron: importing `electron` outside the app resolves to its npm
 * package, which downloads the Electron binary when it finds none — a network fetch in
 * the middle of `vitest`, and a race when two test files do it at once. `app.ts` builds
 * the real menu from the template and `main.ts` reads links with `deepLinkRoute`.
 *
 * There is one window. Every item here brings it forward and shows one view in it;
 * nothing opens a second window.
 */

/** The menu's words and keys, in the sidebar's order. */
export const MENU_ROUTES: readonly { readonly route: RouteName; readonly label: string; readonly accelerator: string }[] =
  Object.freeze([
    { route: 'today', label: 'Today', accelerator: 'CmdOrCtrl+1' },
    { route: 'replies', label: 'Replies', accelerator: 'CmdOrCtrl+2' },
    { route: 'firms', label: 'Firms', accelerator: 'CmdOrCtrl+3' },
    { route: 'sequences', label: 'Sequences', accelerator: 'CmdOrCtrl+4' },
    { route: 'admin', label: 'Administration', accelerator: 'CmdOrCtrl+5' },
    { route: 'dashboard', label: 'Dashboard', accelerator: 'CmdOrCtrl+6' },
  ]);

export type MenuItem =
  | { readonly label: string; readonly accelerator: string; readonly click: () => void }
  | { readonly type: 'separator' }
  | { readonly role: 'minimize' | 'zoom' | 'close' | 'front' };

/**
 * The whole application menu: the app, Edit (so ⌘C and ⌘V work in every field), View,
 * and one Window menu with the six views and the usual window controls. Built here
 * rather than appended to Electron's default menu, which already has a Window menu and
 * so showed two.
 */
export function windowMenuTemplate(
  show: (route: RouteName) => void,
): readonly ({ readonly role: 'appMenu' | 'editMenu' | 'viewMenu' } | { readonly label: string; readonly submenu: readonly MenuItem[] })[] {
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        ...MENU_ROUTES.map(entry => ({
          label: entry.label,
          accelerator: entry.accelerator,
          click: () => {
            show(entry.route);
          },
        })),
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];
}

/**
 * The deep links this bundle answers to: `callie://` and one of the six route names,
 * as a closed set. Nothing from the URL becomes an argument, a path or a query — a link
 * either is one of these exact strings or it is ignored. That is what makes the scheme
 * safe to register at all: a `callie://` URL is something any web page can ask macOS to
 * open, so it must never be able to say anything but which view to show.
 */
export const DEEP_LINKS: readonly string[] = Object.freeze(ROUTE_NAMES.map(name => `callie://${name}`));

/** The route a deep link names, or null. `callie://firms/` is `callie://firms`. */
export function deepLinkRoute(url: string): RouteName | null {
  const exact = url.endsWith('/') ? url.slice(0, -1) : url;
  if (!DEEP_LINKS.includes(exact)) return null;
  return routeNameOf(exact.slice('callie://'.length));
}
