/**
 * macOS dock badge showing the count of due next actions. Pure logic lives
 * here so it is unit-testable without Electron; src/main.ts injects the
 * platform, the due-count query, and `app.dock.setBadge`.
 */

export type DockBadgeDependencies = {
  platform: NodeJS.Platform;
  getDueCount(): number;
  setBadge(text: string): void;
};

export type DockBadgeUpdater = {
  refresh(): void;
};

/** Positive counts render as text; zero or negative clears the badge. */
export function badgeTextForCount(count: number): string {
  return count > 0 ? String(count) : '';
}

/**
 * Creates a refresher that only calls setBadge when the badge text actually
 * changed since the last refresh. No-op off darwin.
 */
export function createDockBadgeUpdater(
  deps: DockBadgeDependencies,
): DockBadgeUpdater {
  let lastText: string | undefined;

  return {
    refresh(): void {
      if (deps.platform !== 'darwin') {
        return;
      }

      const text = badgeTextForCount(deps.getDueCount());
      if (text === lastText) {
        return;
      }

      lastText = text;
      deps.setBadge(text);
    },
  };
}
