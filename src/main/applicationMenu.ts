import type { MenuItemConstructorOptions } from 'electron';

/**
 * Fixed routes reachable from the native application menu. This list mirrors
 * the renderer hash router (`src/renderer/app/routes.ts`) but stays constant
 * here so executeJavaScript payloads are never built from user input.
 */
export const menuNavigationRoutes = [
  'today',
  'accounts',
  'campaigns',
  'settings',
] as const;

export type MenuNavigationRoute = (typeof menuNavigationRoutes)[number];

/**
 * Constant executeJavaScript payloads, one per fixed route. The renderer
 * router listens to hashchange, so setting the hash is a full navigation.
 */
export const menuNavigationScripts: Readonly<
  Record<MenuNavigationRoute, string>
> = Object.freeze(
  Object.fromEntries(
    menuNavigationRoutes.map((route) => [
      route,
      `window.location.hash = '#/${route}';`,
    ]),
  ) as Record<MenuNavigationRoute, string>,
);

export type ApplicationMenuDependencies = {
  appName: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  navigate(route: MenuNavigationRoute): void;
};

type NavigationEntry = {
  label: string;
  accelerator: string;
  route: MenuNavigationRoute;
};

const navigationEntries: readonly NavigationEntry[] = [
  { label: 'Today', accelerator: 'CmdOrCtrl+1', route: 'today' },
  { label: 'Accounts', accelerator: 'CmdOrCtrl+2', route: 'accounts' },
  { label: 'Campaigns', accelerator: 'CmdOrCtrl+3', route: 'campaigns' },
  { label: 'Settings', accelerator: 'CmdOrCtrl+,', route: 'settings' },
];

/**
 * Pure template builder so the menu structure is unit-testable without
 * Electron. `Menu.buildFromTemplate` consumes the result in src/main.ts.
 */
export function createApplicationMenuTemplate(
  deps: ApplicationMenuDependencies,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];

  if (deps.platform === 'darwin') {
    template.push({ label: deps.appName, role: 'appMenu' });
  }

  template.push({
    label: 'File',
    submenu: [{ role: 'close' }],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'pasteAndMatchStyle' },
      { role: 'selectAll' },
    ],
  });

  const viewSubmenu: MenuItemConstructorOptions[] = navigationEntries.map(
    ({ label, accelerator, route }) => ({
      label,
      accelerator,
      click: () => deps.navigate(route),
    }),
  );
  viewSubmenu.push({ type: 'separator' });
  if (!deps.isPackaged) {
    viewSubmenu.push({ role: 'reload' }, { role: 'toggleDevTools' });
  }
  viewSubmenu.push(
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { role: 'togglefullscreen' },
  );
  template.push({ label: 'View', submenu: viewSubmenu });

  template.push({ role: 'windowMenu' });

  return template;
}
