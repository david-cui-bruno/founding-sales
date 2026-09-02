import { describe, expect, it, vi } from 'vitest';

import {
  createApplicationMenuTemplate,
  menuNavigationRoutes,
  menuNavigationScripts,
  openImportScript,
  type ApplicationMenuDependencies,
} from '../../src/main/applicationMenu';

type TemplateItem = {
  label?: string;
  role?: string;
  type?: string;
  accelerator?: string;
  click?: () => void;
  submenu?: TemplateItem[];
};

function buildDependencies(
  overrides: Partial<ApplicationMenuDependencies> = {},
): ApplicationMenuDependencies {
  return {
    appName: 'Callie Founder Sales System',
    platform: 'darwin',
    isPackaged: false,
    navigate: vi.fn(),
    openImport: vi.fn(),
    ...overrides,
  };
}

function buildTemplate(
  overrides: Partial<ApplicationMenuDependencies> = {},
): TemplateItem[] {
  return createApplicationMenuTemplate(
    buildDependencies(overrides),
  ) as unknown as TemplateItem[];
}

function submenuOf(items: TemplateItem[], label: string): TemplateItem[] {
  const menu = items.find((item) => item.label === label);
  expect(menu, `expected top-level menu labelled ${label}`).toBeDefined();
  expect(menu?.submenu, `expected ${label} to carry a submenu`).toBeDefined();
  return menu?.submenu ?? [];
}

describe('createApplicationMenuTemplate', () => {
  it('leads with the appMenu role on darwin, labelled with the app name', () => {
    const template = buildTemplate();

    expect(template[0]).toMatchObject({
      label: 'Callie Founder Sales System',
      role: 'appMenu',
    });
  });

  it('omits the appMenu entry off darwin', () => {
    const template = buildTemplate({ platform: 'win32' });

    expect(template.some((item) => item.role === 'appMenu')).toBe(false);
    expect(template[0]?.label).toBe('File');
  });

  it('offers Import Leads… under File with CmdOrCtrl+I and a close role', () => {
    const openImport = vi.fn();
    const file = submenuOf(buildTemplate({ openImport }), 'File');

    const importItem = file.find((item) => item.label === 'Import Leads…');
    expect(importItem?.accelerator).toBe('CmdOrCtrl+I');
    importItem?.click?.();
    expect(openImport).toHaveBeenCalledTimes(1);
    expect(file.some((item) => item.role === 'close')).toBe(true);
  });

  it('keeps the standard Edit roles so Cmd+C/V/X/A always work', () => {
    const edit = submenuOf(buildTemplate(), 'Edit');
    const roles = edit
      .filter((item) => item.role !== undefined)
      .map((item) => item.role);

    expect(roles).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'selectAll',
    ]);
  });

  it('maps View navigation items to routes with numbered accelerators', () => {
    const navigate = vi.fn();
    const view = submenuOf(buildTemplate({ navigate }), 'View');

    const expected: ReadonlyArray<[string, string, string]> = [
      ['Today', 'CmdOrCtrl+1', 'today'],
      ['Leads', 'CmdOrCtrl+2', 'leads'],
      ['Pipeline', 'CmdOrCtrl+3', 'pipeline'],
      ['Conversations', 'CmdOrCtrl+4', 'conversations'],
      ['Learnings', 'CmdOrCtrl+5', 'learnings'],
      ['Friday', 'CmdOrCtrl+6', 'friday'],
      ['Inbox', 'CmdOrCtrl+7', 'inbox'],
      ['Settings', 'CmdOrCtrl+,', 'settings'],
    ];

    for (const [label, accelerator, route] of expected) {
      const item = view.find((candidate) => candidate.label === label);
      expect(item?.accelerator, `${label} accelerator`).toBe(accelerator);
      navigate.mockClear();
      item?.click?.();
      expect(navigate, `${label} navigates`).toHaveBeenCalledWith(route);
    }
  });

  it('includes reload and devtools roles only when not packaged', () => {
    const development = submenuOf(buildTemplate({ isPackaged: false }), 'View');
    const packaged = submenuOf(buildTemplate({ isPackaged: true }), 'View');
    const rolesOf = (items: TemplateItem[]): (string | undefined)[] =>
      items.filter((item) => item.role !== undefined).map((item) => item.role);

    expect(rolesOf(development)).toEqual([
      'reload',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
    ]);
    expect(rolesOf(packaged)).toEqual([
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
    ]);
  });

  it('ends with the windowMenu role', () => {
    const template = buildTemplate();

    expect(template[template.length - 1]).toMatchObject({
      role: 'windowMenu',
    });
  });
});

describe('menu navigation scripts', () => {
  it('builds one constant hash script per fixed route', () => {
    expect(menuNavigationRoutes).toEqual([
      'today',
      'leads',
      'pipeline',
      'conversations',
      'learnings',
      'friday',
      'inbox',
      'settings',
    ]);
    for (const route of menuNavigationRoutes) {
      expect(menuNavigationScripts[route]).toBe(
        `window.location.hash = '#/${route}';`,
      );
    }
  });

  it('routes import to leads and dispatches the open-import event', () => {
    expect(openImportScript).toBe(
      "window.location.hash = '#/leads'; " +
        "window.dispatchEvent(new CustomEvent('callie:open-import'));",
    );
  });
});
