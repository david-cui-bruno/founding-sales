/**
 * The Window menu, as a value (lane g65).
 *
 * Its own module, with no Electron in it, so the template is asserted by the unit
 * tests without loading Electron: importing `electron` outside the app resolves to its
 * npm package, which downloads the Electron binary when it finds none — a network fetch
 * in the middle of `vitest`, and a race when two test files do it at once. G6 kept this
 * in `todayWindow.ts`; `app.ts` builds the real menu from it.
 */

/**
 * The application menu items that open the windows.
 *
 * The menu is the macOS way to reach a window that is not the front one, and since lane
 * g65 Home's sidebar shows the same keys beside the same names. The template is a value
 * so it can be asserted without Electron.
 *
 * **Today, ⌘1, is the main window.** It brings Home forward, and opens it again if it
 * was closed while another window kept the app running. There is no Today window.
 */
export function windowMenuTemplate(open: {
  /** Brings the main window, whose content is Today, to the front. */
  readonly today: () => void;
  readonly replies: () => void;
  readonly firms: () => void;
  readonly sequences: () => void;
  /** Lane G9's Settings, Dashboard and Diagnostics window. Optional so a caller
   * that has not wired it yet still gets the selling windows. */
  readonly administration?: (() => void) | undefined;
  /** Lane g65: the same window, opened on its Dashboard screen. Offered only beside it. */
  readonly dashboard?: (() => void) | undefined;
}): readonly { readonly label: string; readonly submenu: readonly { readonly label: string; readonly accelerator: string; readonly click: () => void }[] }[] {
  const administration = open.administration;
  return [
    {
      label: 'Window',
      submenu: [
        { label: 'Today', accelerator: 'CmdOrCtrl+1', click: open.today },
        { label: 'Replies', accelerator: 'CmdOrCtrl+2', click: open.replies },
        { label: 'Firms', accelerator: 'CmdOrCtrl+3', click: open.firms },
        { label: 'Sequences', accelerator: 'CmdOrCtrl+4', click: open.sequences },
        // Last, and the only optional ones: ⌘1 to ⌘4 are the windows somebody uses
        // to sell, and administration is the one they open when they are not. The
        // Dashboard is a screen of that window, so it takes the next free key rather
        // than moving a key a person already has in their fingers.
        ...(administration === undefined
          ? []
          : [
              { label: 'Administration', accelerator: 'CmdOrCtrl+5', click: administration },
              ...(open.dashboard === undefined
                ? []
                : [{ label: 'Dashboard', accelerator: 'CmdOrCtrl+6', click: open.dashboard }]),
            ]),
      ],
    },
  ];
}
