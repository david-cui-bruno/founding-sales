import type { JSX } from 'react';
import * as settingsPage from '../settingsPage.ts';
import type { Route } from '../routes.ts';
import { LegacyView } from './LegacyView.tsx';

/**
 * Settings: Administration, the Dashboard and Diagnostics in one view (1.0.12).
 *
 * The three tabs are still the hand-rolled Settings module, which draws its own tab bar,
 * chooses its own screen and reports the route back through `routeShown` — so the shell's
 * route follows the tab without the module being mounted again, and ⌘, or the sidebar
 * row mounts it afresh at Administration. U2 converts the tabs and deletes `LegacyView`.
 */
export function SettingsView({ route, mountKey }: { readonly route: Route; readonly mountKey: string }): JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col px-12 pt-10 pb-20">
      <LegacyView view={settingsPage} route={route} mountKey={mountKey} />
    </div>
  );
}
