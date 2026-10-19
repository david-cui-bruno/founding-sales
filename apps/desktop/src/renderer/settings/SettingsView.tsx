import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { MailboxState } from '../../shared/contract.ts';
import type { Generation } from '../app/generation.ts';
import { routeShown, type Route } from '../routes.ts';
import { adminViewOf } from '../settingsView.ts';
import { Alert } from '../ui/alert.tsx';
import { Page, ViewHeader } from '../ui/layout.tsx';
import type { StatusRow } from '../homeView.ts';
import { Administration } from './Administration.tsx';
import { isAttributed, NoticeProvider } from './FormNotice.tsx';
import { CallingCalendarSection } from './CallingCalendarSection.tsx';
import { MailboxSection } from './MailboxSection.tsx';
import { RecordingsFolderSection } from '../recordings/RecordingsFolderSection.tsx';
import { ReplyModelSection } from './ReplyModelSection.tsx';
import { ResearchSettings } from './ResearchSettings.tsx';
import { Panels } from './Panels.tsx';
import { RecoveryControls } from './RecoveryControls.tsx';
import { StatusSection } from './StatusSection.tsx';
import { CrmOwnerSetup } from './CrmOwnerSetup.tsx';
import { DiscoveryStatus } from './DiscoveryStatus.tsx';
import { LinkedinConnection } from './LinkedinConnection.tsx';
import { tabForScreen, useAdmin } from './useAdmin.ts';
import { NotificationStatus } from '../today/NotificationStatus.tsx';
import { navigate } from '../routes.ts';

function OwnerGroup({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section aria-label={title} className="border-t border-border py-5 first:border-t-0 first:pt-0"><h2 className="mb-3 text-sm font-semibold tracking-tight">{title}</h2><div className="[&>section]:mt-3 [&>section]:border-t-0 [&>section]:pt-0">{children}</div></section>;
}

/** One owner's operational settings. Existing forms retain every command and refusal. */
export function SettingsView({ route, identity, generation, guard, mailbox, mailboxWaiting, hasMailboxBridge, status = [], isAdmin = false, onSwitchMailbox }: {
  readonly route: Route;
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
  readonly mailbox: MailboxState | null;
  readonly mailboxWaiting: boolean;
  readonly hasMailboxBridge: boolean;
  readonly status?: readonly StatusRow[];
  readonly isAdmin?: boolean;
  onSwitchMailbox(switchTo: string): void;
}): JSX.Element {
  const tab = route.name === 'settings' ? route.tab : 'administration';
  const section = route.name === 'settings' ? route.section ?? null : null;
  const admin = useAdmin(tab, identity, generation, guard);
  const state = admin.state;
  const view = state === null ? null : adminViewOf(state);
  const [advanced, setAdvanced] = useState(tab !== 'administration' || section !== null);
  const [emailTechnical, setEmailTechnical] = useState<HTMLDivElement | null>(null);
  const openEmailTechnical = () => {
    setAdvanced(true);
    // Opening a disclosure is presentation only, never a setting command.
    if (emailTechnical) {
      const disclosure = emailTechnical.closest('details');
      if (disclosure instanceof HTMLDetailsElement) disclosure.open = true;
      emailTechnical.scrollIntoView({ block: 'start' });
    }
  };
  const scrolled = useRef(false);
  useEffect(() => {
    if (state === null || section === null || scrolled.current) return;
    const target = document.querySelector(`[data-testid="${section}"]`);
    if (target === null) return;
    // Deep links open containing disclosures before scrolling, never mutate settings.
    for (let parent = target.parentElement; parent !== null; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    scrolled.current = true;
    target.scrollIntoView({ block: 'start' });
  }, [state, section, advanced]);
  const privacyKey = `${identity}:${String(generation)}`;
  const editable = identity !== null && state?.mayMutate === true;
  const configuration = view !== null && tabForScreen(view.screen) === 'administration';
  return <NoticeProvider value={{ text: view?.notice ?? null, form: admin.lastForm }}>
    <Page data-testid="settings-view" aria-busy={admin.pending > 0} className="callie-v2">
      <div className="mx-auto w-full max-w-3xl pb-12">
        <ViewHeader title="Settings" />
        <p className="mb-6 mt-1 text-sm text-muted-foreground">Your account and the limits Callie works within.</p>
        <OwnerGroup title="Account">
          <p className="mb-2 text-sm" data-testid="signed-in-user">{identity === null ? 'Not signed in' : `Signed in${isAdmin ? ' · Administrator' : ''}`}</p>
          <StatusSection rows={status.filter(row => row.key === 'system' || row.key === 'update')} />
          <button type="button" className="mb-3 text-sm underline underline-offset-4" onClick={() => navigate({ name: 'ask' })}>Search records and conversation history</button>
          <MailboxSection mailbox={mailbox} waiting={mailboxWaiting} available={hasMailboxBridge} onSwitch={onSwitchMailbox} />
        </OwnerGroup>
        <div data-testid="banners" className="flex flex-col gap-2 empty:hidden">
        {view?.banner ? <Alert tone="warning" data-testid="banner-offline">{view.banner}</Alert> : null}
        {view?.notice && !isAttributed(admin.lastForm) ? <Alert tone="info" data-testid="notice">{view.notice}</Alert> : null}
        {state?.notice === 'release_record_unknown' ? <details className="text-xs text-muted-foreground"><summary>Technical details</summary><code>{state.notice}</code></details> : null}
        </div>
        {view === null ? <p role="status" className="py-4 text-sm text-muted-foreground">Reading settings. Controls remain unavailable until the server answers.</p> : configuration ? <>
          <OwnerGroup title="Calling">
            <Administration scope="calling" view={view} actions={admin.actions} busy={admin.busy} />
            {state ? <CallingCalendarSection scope="calling" state={state} busy={key => admin.busy(`integration:${key}`)} onSave={admin.actions.saveIntegration} onRetry={() => admin.actions.show('administration')} /> : null}
          </OwnerGroup>
          <OwnerGroup title="Email"><Administration scope="email" view={view} actions={admin.actions} busy={admin.busy} technicalContainer={emailTechnical} onAdvanced={openEmailTechnical} /></OwnerGroup>
          <OwnerGroup title="Research & discovery"><ResearchSettings enabled={editable} identity={identity} generation={generation} guard={guard} /><DiscoveryStatus key={`discovery:${privacyKey}`} available={identity !== null} privacyKey={privacyKey} /></OwnerGroup>
          <OwnerGroup title="LinkedIn"><LinkedinConnection key={privacyKey} enabled={editable} privacyKey={privacyKey} /></OwnerGroup>
        </> : null}
        <details data-testid="settings-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)} className="border-t border-border py-5">
          <summary className="cursor-pointer text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4">Advanced <span className="ml-2 font-normal text-muted-foreground">Time zone, recordings, CRM controls & troubleshooting</span></summary>
          <div className="pt-3">
            <NotificationStatus />
            <div className="flex flex-wrap gap-4 py-2 text-sm" aria-label="Advanced views">
              {(['administration', 'diagnostics'] as const).map(name => <button key={name} data-testid={`tab-${name === 'administration' ? 'settings' : name}`} type="button" className="underline underline-offset-4" aria-current={name === tab ? 'page' : undefined} onClick={() => routeShown({ name: 'settings', tab: name })}>{name === 'administration' ? 'Configuration' : 'Sending recovery'}</button>)}
            </div>
            {configuration && view && state ? <>
              <section aria-label="Email release setup and history" className="border-t border-border py-4">
                <h3 className="mb-2 text-sm font-medium">Email release setup & history</h3>
                <p className="mb-3 text-xs text-muted-foreground">Technical edits remain drafts until you explicitly Save the corresponding Email setting above. The server validates every release reference.</p>
                <div ref={setEmailTechnical} data-testid="email-technical" className="space-y-3" />
              </section>
              <Administration scope="advanced" view={view} actions={admin.actions} busy={admin.busy} />
              <CallingCalendarSection scope="advanced" state={state} busy={key => admin.busy(`integration:${key}`)} onSave={admin.actions.saveIntegration} onRetry={() => admin.actions.show('administration')} />
              <RecordingsFolderSection />
              {isAdmin ? <CrmOwnerSetup key={`crm:${privacyKey}`} available={editable} privacyKey={privacyKey} /> : null}
              <ReplyModelSection isAdmin={isAdmin} identity={identity} generation={generation} guard={guard} />
              <StatusSection rows={status.filter(row => row.key !== 'system' && row.key !== 'update')} />
            </> : view ? <><Panels alertsOnly view={view} {...(tab === 'diagnostics' ? { onAcknowledge: admin.actions.acknowledgeAlert, acknowledging: (id: string) => admin.busy(`alert:${id}`) } : {})} />{tab === 'diagnostics' ? <RecoveryControls /> : null}</> : null}
          </div>
        </details>
      </div>
    </Page>
  </NoticeProvider>;
}
