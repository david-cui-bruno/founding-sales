/**
 * macOS dock badge showing the count of fresh inbound leads awaiting a first
 * touch. Due dates no longer exist anywhere in the app, so this is the only
 * time-sensitive signal the badge may carry. Pure logic lives here so it is
 * unit-testable without Electron; src/main.ts injects the platform, the
 * fresh-inbound count query, and `app.dock.setBadge`.
 */

export type DockBadgeDependencies = {
  platform: NodeJS.Platform;
  getFreshInboundCount(): number;
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

      const text = badgeTextForCount(deps.getFreshInboundCount());
      if (text === lastText) {
        return;
      }

      lastText = text;
      deps.setBadge(text);
    },
  };
}
