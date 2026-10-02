import { useEffect, useRef, type JSX } from 'react';
import type { MailboxState } from '../../shared/contract.ts';
import type { Generation } from '../app/generation.ts';
import { routeShown, SETTINGS_TABS, type Route, type SettingsTab } from '../routes.ts';
import { adminViewOf } from '../settingsView.ts';
import { Alert } from '../ui/alert.tsx';
import { Page, ViewHeader } from '../ui/layout.tsx';
import { cn } from '../lib/utils.ts';
import type { StatusRow } from '../homeView.ts';
import { Administration } from './Administration.tsx';
import { CallingCalendarSection } from './CallingCalendarSection.tsx';
import { MailboxSection } from './MailboxSection.tsx';
import { ReplyModelSection } from './ReplyModelSection.tsx';
import { ResearchSettings } from './ResearchSettings.tsx';
import { Panels } from './Panels.tsx';
import { RecoveryControls } from './RecoveryControls.tsx';
import { StatusSection } from './StatusSection.tsx';
import { tabForScreen, useAdmin } from './useAdmin.ts';

/**
 * Settings: Administration, the Dashboard and Diagnostics in one view (1.0.12; in React
 * since 1.0.13).
 *
 * Three tabs of one bridge. Pressing a tab switches the screen in place and the route
 * follows through `routeShown`, so nothing is mounted again and a half-typed setting
 * survives a look at the figures; the sidebar's Settings row and ⌘, mount it afresh at
 * Administration, which is what asking for it again means.
 *
 * Needs you's Open lands on the section it named — the calling number, the sending
 * domain, the alerts — once, on the first answer.
 */

const TAB_LABELS: Readonly<Record<SettingsTab, string>> = Object.freeze({
  administration: 'Administration',
  dashboard: 'Dashboard',
  diagnostics: 'Diagnostics',
});

export function SettingsView({
  route,
  identity,
  generation,
  guard,
  mailbox,
  mailboxWaiting,
  hasMailboxBridge,
  status = [],
  isAdmin = false,
  onSwitchMailbox,
}: {
  readonly route: Route;
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
  readonly mailbox: MailboxState | null;
  readonly mailboxWaiting: boolean;
  readonly hasMailboxBridge: boolean;
  /** The routine status rows (slice 3a, C0): `buildHomeView`'s, drawn under Status. */
  readonly status?: readonly StatusRow[];
  readonly isAdmin?: boolean;
  onSwitchMailbox(switchTo: string): void;
}): JSX.Element {
  const tab = route.name === 'settings' ? route.tab : 'administration';
  const section = route.name === 'settings' ? (route.section ?? null) : null;
  const admin = useAdmin(tab, identity, generation, guard);
  const state = admin.state;

  /*
   * Once, when the section Needs you asked for is on screen.
   *
   * Not "on the first answer": the reads are cached in memory, so a second visit
   * renders the tab it was left on before the answer for the tab asked for arrives,
   * and a scroll then would be a scroll to nothing. Waiting for the element is also
   * what makes it at most one scroll — after it, the ref is set.
   */
  const scrolled = useRef(false);
  useEffect(() => {
    if (state === null || section === null || scrolled.current) return;
    const target = document.querySelector(`[data-testid="${section}"]`);
    if (target === null) return;
    scrolled.current = true;
    target.scrollIntoView({ block: 'start' });
  }, [state, section]);

  const view = state === null ? null : adminViewOf(state);

  return (
    <Page data-testid="settings-view" aria-busy={admin.pending > 0}>
      <ViewHeader title="Settings" />
      <nav data-testid="tabs" className="mt-3 flex items-center gap-1 border-b border-border">
        {SETTINGS_TABS.map(name => (
          <button
            key={name}
            type="button"
            data-testid={`tab-${name === 'administration' ? 'settings' : name}`}
            {...(name === tab ? { 'aria-current': 'page' as const } : {})}
            onClick={() => {
              routeShown({ name: 'settings', tab: name });
            }}
            className={cn(
              '-mb-px border-b-2 px-2 py-1.5 text-sm transition-colors',
              name === tab
                ? 'border-foreground font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {TAB_LABELS[name]}
          </button>
        ))}
      </nav>

      {view === null ? null : (
        <>
          <div data-testid="banners" className="mt-3 flex flex-col gap-2 empty:hidden">
            {view.banner === null ? null : (
              <Alert tone="warning" data-testid="banner-offline">
                {view.banner}
              </Alert>
            )}
            {view.notice === null ? null : (
              <Alert tone="info" data-testid="notice">
                {view.notice}
              </Alert>
            )}
          </div>

          {tabForScreen(view.screen) === 'administration' ? (
            <>
              <StatusSection rows={status} />
              <MailboxSection
                mailbox={mailbox}
                waiting={mailboxWaiting}
                available={hasMailboxBridge}
                onSwitch={onSwitchMailbox}
              />
              {state === null ? null : (
                <CallingCalendarSection
                  state={state}
                  busy={key => admin.busy(`integration:${key}`)}
                  onSave={admin.actions.saveIntegration}
                  onRetry={() => {
                    admin.actions.show('administration');
                  }}
                />
              )}
              <Administration view={view} actions={admin.actions} busy={admin.busy} />
              {/* Absent for anyone who is not an admin: the read is the budget (lane R). */}
              <ResearchSettings identity={identity} generation={generation} guard={guard} />
              <ReplyModelSection isAdmin={isAdmin} identity={identity} generation={generation} guard={guard} />
            </>
          ) : tabForScreen(view.screen) === 'dashboard' ? (
            <Panels view={view} />
          ) : (
            <>
              <Panels
                view={view}
                onAcknowledge={admin.actions.acknowledgeAlert}
                acknowledging={alertId => admin.busy(`alert:${alertId}`)}
              />
              <RecoveryControls />
            </>
          )}
        </>
      )}
    </Page>
  );
}
