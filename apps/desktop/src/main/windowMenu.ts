import { NAVIGATION_TARGETS, navigationTargetOf, type NavigationTarget } from '../shared/contract.ts';

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
 *
 * 1.0.12 moved Administration and the Dashboard into Settings. The menu is the sidebar:
 * the selling views with ⌘1–⌘5, then Settings with ⌘,, which opens the tab that used to
 * be Administration. The two keys that opened those views are the two tabs beside it, so
 * nobody loses the shortcut they had.
 *
 * 1.0.14 split Firms into Pipeline and Firms, which is a fifth selling view, so Sequences
 * takes ⌘5 and the two Settings tabs beside ⌘, move down to ⌘6 and ⌘7. One key cannot
 * mean two views, and the day's work has the low numbers.
 */

/** The menu's words and keys, in the sidebar's order. */
export const MENU_ROUTES: readonly { readonly target: NavigationTarget; readonly label: string; readonly accelerator: string }[] =
  Object.freeze([
    { target: 'today', label: 'Today', accelerator: 'CmdOrCtrl+1' },
    { target: 'replies', label: 'Replies', accelerator: 'CmdOrCtrl+2' },
    { target: 'pipeline', label: 'Pipeline', accelerator: 'CmdOrCtrl+3' },
    { target: 'firms', label: 'Firms', accelerator: 'CmdOrCtrl+4' },
    { target: 'sequences', label: 'Sequences', accelerator: 'CmdOrCtrl+5' },
    { target: 'social', label: 'Social', accelerator: 'CmdOrCtrl+6' },
    { target: 'ask', label: 'Ask', accelerator: 'CmdOrCtrl+7' },
  ]);

/** Settings and its three tabs, below a separator. ⌘, is where a Mac keeps this. */
export const MENU_SETTINGS: readonly { readonly target: NavigationTarget; readonly label: string; readonly accelerator: string }[] =
  Object.freeze([
    { target: 'settings/administration', label: 'Settings', accelerator: 'CmdOrCtrl+,' },
    { target: 'settings/dashboard', label: 'Dashboard', accelerator: 'CmdOrCtrl+8' },
    { target: 'settings/diagnostics', label: 'Diagnostics', accelerator: 'CmdOrCtrl+9' },
  ]);

export type MenuItem =
  | { readonly label: string; readonly accelerator: string; readonly click: () => void }
  | { readonly type: 'separator' }
  | { readonly role: 'minimize' | 'zoom' | 'close' | 'front' };

/**
 * The whole application menu: the app, Edit (so ⌘C and ⌘V work in every field), View,
 * and one Window menu with the views and the usual window controls. Built here rather
 * than appended to Electron's default menu, which already has a Window menu and so
 * showed two.
 */
export function windowMenuTemplate(
  show: (target: NavigationTarget) => void,
): readonly ({ readonly role: 'appMenu' | 'editMenu' | 'viewMenu' } | { readonly label: string; readonly submenu: readonly MenuItem[] })[] {
  const item = (entry: (typeof MENU_ROUTES)[number]): MenuItem => ({
    label: entry.label,
    accelerator: entry.accelerator,
    click: () => {
      show(entry.target);
    },
  });
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        ...MENU_ROUTES.map(item),
        { type: 'separator' },
        ...MENU_SETTINGS.map(item),
        { type: 'separator' },
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
      ],
    },
  ];
}

/**
 * The deep links this bundle answers to: `callie://` and one exact string, as a closed
 * set. Nothing from the URL becomes an argument, a path or a query — a link either is
 * one of these exact strings or it is ignored. That is what makes the scheme safe to
 * register at all: a `callie://` URL is something any web page can ask macOS to open,
 * so it must never be able to say anything but which view to show.
 *
 * `callie://admin` and `callie://dashboard` are 1.0.11's names, kept because links made
 * before this release still exist on the owner's Mac; each opens the Settings tab that
 * holds what it used to open.
 */
const RETIRED_LINKS: Readonly<Record<string, NavigationTarget>> = Object.freeze({
  admin: 'settings/administration',
  dashboard: 'settings/dashboard',
  settings: 'settings/administration',
});

export const DEEP_LINKS: readonly string[] = Object.freeze([
  ...NAVIGATION_TARGETS.map(target => `callie://${target}`),
  ...Object.keys(RETIRED_LINKS).map(name => `callie://${name}`),
]);

/** The target a deep link names, or null. `callie://firms/` is `callie://firms`. */
export function deepLinkRoute(url: string): NavigationTarget | null {
  const exact = url.endsWith('/') ? url.slice(0, -1) : url;
  if (!DEEP_LINKS.includes(exact)) return null;
  const name = exact.slice('callie://'.length);
  return navigationTargetOf(name) ?? RETIRED_LINKS[name] ?? null;
}
