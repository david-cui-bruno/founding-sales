import type { JSX } from 'react';
import * as settingsPage from '../settingsPage.ts';
import type { Route } from '../routes.ts';
import { RecoveryControls } from '../settings/RecoveryControls.tsx';
import { LegacyView } from './LegacyView.tsx';

/**
 * Settings: Administration, the Dashboard and Diagnostics in one view (1.0.12).
 *
 * The three tabs are still the hand-rolled Settings module, which draws its own tab bar,
 * chooses its own screen and reports the route back through `routeShown` — so the shell's
 * route follows the tab without the module being mounted again, and ⌘, or the sidebar
 * row mounts it afresh at Administration. U2 converts the tabs and deletes `LegacyView`.
 *
 * Diagnostics has two React forms under it — the recoveries of 12.5 and 13.4, which were
 * a runbook and `curl` until 1.0.12. They follow the tab rather than the mount, because
 * the module's own tab bar switches the screen in place and reports the route back.
 */
export function SettingsView({ route, mountKey }: { readonly route: Route; readonly mountKey: string }): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col px-12 pt-10 pb-20">
      <LegacyView view={settingsPage} route={route} mountKey={mountKey} />
      {route.name === 'settings' && route.tab === 'diagnostics' ? <RecoveryControls /> : null}
    </div>
  );
}
