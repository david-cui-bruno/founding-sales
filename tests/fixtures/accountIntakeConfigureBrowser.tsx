import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from '../../src/renderer/app/AppShell';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { useTheme } from '../../src/renderer/app/useTheme';
import { useDensity } from '../../src/renderer/app/useDensity';
import type { AppRoute } from '../../src/renderer/app/routes';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { nativeDeskFixture, nativeDeskReviewFixture } from '../../src/renderer/features/today/nativeDesk.fixture';
import type { AccountPreparation } from '../../src/shared/contracts/accountPreparationContract';
import type { OwnerSourceConfiguration } from '../../src/shared/contracts/ownerCommandContract';
import type { RemoteGoogleGrantStatus } from '../../src/shared/contracts/remoteGoogleGrantContract';
import '../../src/renderer/app.css';

// Explicit no-IO fixture for the Campaigns surface. The preparation and the grant are saved presentation
// data exactly as the bridge would return them; the intake write stays forbidden. Nothing here configures,
// reads mail, sends or books.
const configuration: OwnerSourceConfiguration = { version: 1, workspaceId: 'ws', accountId: 'a', pairingId: 'fixture-pairing', revision: 1, state: 'paused', mailboxSubject: null, calendarId: null, research: null };
const base: AccountPreparation = { workspaceId: 'ws', accountId: 'a', pairingId: 'fixture-pairing', checkedAt: '2026-09-09T12:00:00.000Z',
  authority: { accountId: 'a', owner: 'worker', generation: 1, state: 'active' }, executionVersion: 1, configuration, mailCursor: null };
const activeMail: AccountPreparation = { ...base, configuration: { ...configuration, revision: 2, state: 'active', mailboxSubject: 'mailbox' }, mailCursor: { mailboxSubject: 'mailbox', envelopeRevision: 3, scope: null } };
export const preparations: Record<'pausedNoMail' | 'activeMail', AccountPreparation> = { pausedNoMail: base, activeMail };
const owned = 'founder@fixture.invalid';
const grant: RemoteGoogleGrantStatus = { state: 'ready', grant: { provider: 'google', subject: 'mailbox', email: owned, grantedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
  owner: 'remote', purpose: 'permitted_correspondence', capabilities: ['relevant_read'], calendars: { ownedCalendarId: owned, conflictCalendarIds: [owned], confirmed: true } } };
const fixture = nativeDeskFixture(nativeDeskReviewFixture());
fixture.setPreparation(preparations.pausedNoMail);
const grantReads: unknown[] = [];
const forbidden = async (): Promise<never> => { grantReads.push('forbidden'); throw Error('Unavailable fixture capability'); };
Object.assign(fixture.api.delegation, { googleConnections: { status: async (input: unknown) => { grantReads.push(input); return structuredClone(grant); }, disclosure: forbidden, begin: forbidden, revoke: forbidden } });
function Harness() {
  const { setPreference } = useTheme();
  const { setDensity } = useDensity();
  const [route, setRoute] = useState<'today' | 'campaigns'>('campaigns');
  const navigate = (next: AppRoute) => {
    if (next !== 'today' && next !== 'campaigns') throw new Error(`Account intake configure fixture does not render ${next}.`);
    setRoute(next);
  };
  const [tick, setTick] = useState(0);
  window.accountIntakeConfigureBrowser = {
    fixture, grantReads, preparations, navigate,
    refresh: () => window.dispatchEvent(new Event('focus')),
    rerender: () => setTick(value => value + 1),
    preferences: (theme, density) => { setPreference(theme); setDensity(density); },
  };
  return <PresentationRoot><AppShell route={route} onNavigate={navigate}>
    <div data-rerender={tick}><NativeDeskRoute firstUse={fixture.firstUse} key={route} api={fixture.api} surface={route} /></div>
  </AppShell></PresentationRoot>;
}
export type AccountIntakeConfigureBrowser = {
  fixture: typeof fixture; grantReads: unknown[]; preparations: typeof preparations; navigate(route: AppRoute): void;
  refresh(): void; rerender(): void;
  preferences(theme: 'system' | 'light' | 'dark', density: 'comfortable' | 'compact'): void;
};
declare global { interface Window { accountIntakeConfigureBrowser: AccountIntakeConfigureBrowser } }
document.documentElement.lang = 'en';
document.documentElement.dataset.theme = 'light';
document.documentElement.dataset.density = 'comfortable';
document.body.dataset.platform = 'darwin';
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
