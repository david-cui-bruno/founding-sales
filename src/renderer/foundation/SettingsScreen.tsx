import { LocalCompanyResearchSection } from './LocalCompanyResearchSection';
import { ResearchSetupSection } from './ResearchSetupSection';
import { RemoteGoogleConnectionsSection } from './RemoteGoogleConnectionsSection';
import { CallCapacitySection } from './CallCapacitySection';
import { TerritoryClearanceSection } from './TerritoryClearanceSection';
import { EmailTemplatesSection } from './EmailTemplatesSection';
import type { LocalWorkspaceApi } from '../../shared/contracts/localWorkspaceContract';
import { WorkflowSection } from './WorkflowSection';
import type { RecoveryProvider } from '../../shared/contracts/recoveryContract';
import { RecoverySection } from './RecoverySection';
import { Monitor, Moon, Rows2, Rows3, Sun, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { OutreachApi } from '../../shared/contracts/outreachContract';
import { ConnectionsSection } from './ConnectionsSection';
import { SuppressionSection } from './SuppressionSection';
import type { PhoneSetupApi } from '../../shared/contracts/phoneSetupContract';
import { PhoneSetupSection } from './PhoneSetupSection';
import type { CalliePreloadApi } from '../../shared/preload';
import { WorkerSetupSection } from './WorkerSetupSection';
import { WorkspaceAccessSection } from './WorkspaceAccessSection';

import type { AppHealth } from '../../shared/healthContract';
import type { DensityPreference, DensityState } from '../app/useDensity';
import type { ThemePreference, ThemeState } from '../app/useTheme';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import type { DiagnosticsState } from './DiagnosticsScreen';
import { HealthObservationStatus } from './DiagnosticsScreen';
import type { HealthObservation } from './useFoundationHealth';

import './settings.css';

const themeOptions: readonly {
  value: ThemePreference;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: 'system', label: 'Match system appearance', icon: Monitor },
  { value: 'light', label: 'Light appearance', icon: Sun },
  { value: 'dark', label: 'Dark appearance', icon: Moon },
];

const densityOptions: readonly {
  value: DensityPreference;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: 'comfortable', label: 'Comfortable density', icon: Rows2 },
  { value: 'compact', label: 'Compact density', icon: Rows3 },
];

const notifyCallCapacitySaved = () => { window.dispatchEvent(new Event('callie:workflow-changed')); };

type SettingsSectionId =
  | 'call-capacity'
  | 'territory'
  | 'email-templates'
  | 'worker'
  | 'phone'
  | 'connections'
  | 'suppressed'
  | 'appearance'
  | 'data'
  | 'diagnostics'
  | 'shortcuts'
  | 'about';

const SECTIONS: readonly { id: SettingsSectionId; label: string }[] = [
  { id: 'connections', label: 'Connections' },
  { id: 'phone', label: 'Phone' },
  { id: 'call-capacity', label: 'Call capacity' },
  { id: 'territory', label: 'Territory clearance' },
  { id: 'email-templates', label: 'Email templates' },
  { id: 'worker', label: 'Worker connection' },
  { id: 'suppressed', label: 'Suppressed' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data & storage' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'about', label: 'About' },
];

/**
 * Settings → Appearance: the same theme and density controls the old top bar
 * carried, persisting through the identical `callie.theme` / `callie.density`
 * keys so existing preferences survive the move. The buttons keep their
 * aria-pressed contract; the packaged founder-workflow E2E drives them.
 */
function AppearanceSection({
  theme,
  density,
}: {
  theme: ThemeState;
  density: DensityState;
}) {
  return (
    <section
      id="settings-appearance"
      className="settings__section"
      aria-label="Appearance"
    >
      <h2 className="settings__section-title">Appearance</h2>
      <div className="settings__row">
        <span className="settings__row-label">Theme</span>
        <div
          className="settings__toggle-group"
          role="group"
          aria-label="Appearance"
        >
          {themeOptions.map((option) => {
            const Icon = option.icon;
            const pressed = theme.preference === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className="settings__toggle"
                aria-label={option.label}
                aria-pressed={pressed}
                title={option.label}
                onClick={() => theme.setPreference(option.value)}
              >
                <Icon aria-hidden="true" size={16} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="settings__row">
        <span className="settings__row-label">Density</span>
        <div
          className="settings__toggle-group"
          role="group"
          aria-label="Density"
        >
          {densityOptions.map((option) => {
            const Icon = option.icon;
            const pressed = density.density === option.value;
            return (
              <button
                key={option.value}
                type="button"
                className="settings__toggle"
                aria-label={option.label}
                aria-pressed={pressed}
                title={option.label}
                onClick={() => density.setDensity(option.value)}
              >
                <Icon aria-hidden="true" size={16} />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

export type SettingsShellApi = {
  revealDatabase(): Promise<unknown>;
  revealLogDirectory(): Promise<unknown>;
};

/**
 * Settings → Data & storage: the encrypted database location in monospace
 * with copy and reveal affordances. Reveal never sends a renderer path; the
 * main process resolves the location itself.
 */
function DataStorageSection({
  health,
  shell,
  recovery,
  localWorkspaceApi,
}: {
  health: AppHealth | null;
  shell?: SettingsShellApi;
  recovery?: RecoveryProvider;
  localWorkspaceApi?: LocalWorkspaceApi;
}) {
  return (
    <section
      id="settings-data"
      className="settings__section"
      aria-label="Data & storage"
    >
      <h2 className="settings__section-title">Data &amp; storage</h2>
      {recovery !== undefined && <RecoverySection recovery={recovery} />}
      <WorkflowSection api={localWorkspaceApi} />
      {health === null ? (
        <p className="settings__quiet">Available once the foundation is ready.</p>
      ) : (
        <>
          <div className="settings__row settings__row--top">
            <span className="settings__row-label">Database location</span>
            <code className="settings__path">{health.databasePath}</code>
          </div>
          <div className="settings__row-actions">
            <button
              type="button"
              className="settings__action"
              onClick={() => {
                void navigator.clipboard?.writeText(health.databasePath);
              }}
            >
              Copy path
            </button>
            {shell !== undefined && (
              <button
                type="button"
                className="settings__action"
                onClick={() => {
                  shell.revealDatabase().catch((): undefined => undefined);
                }}
              >
                Reveal in Finder
              </button>
            )}
          </div>
          {shell !== undefined && (
            <>
              <p className="settings__quiet">
                PII-safe operational logs are retained for 14 days.
              </p>
              <button
                type="button"
                className="settings__action"
                onClick={() => {
                  shell.revealLogDirectory().catch((): undefined => undefined);
                }}
              >
                Reveal logs in Finder
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Settings → Diagnostics: the same foundation facts the old green-text block
 * carried, as status rows. The exact strings 'Encrypted SQLite ready',
 * 'FTS5 available', and 'Schema N' stay visible; the packaged foundation E2E
 * asserts them.
 */
function DiagnosticsSection({
  state,
  onRetry,
  observation,
}: {
  state: DiagnosticsState;
  onRetry: () => void;
  observation?: HealthObservation;
}) {
  return (
    <section
      id="settings-diagnostics"
      className="settings__section"
      aria-label="Diagnostics"
    >
      <h2 className="settings__section-title">Diagnostics</h2>
      {state.status === 'loading' && (
        <p role="status">Checking local foundation…</p>
      )}
      {state.status === 'ready' && (
        <div className="settings__status-rows" role="status">
          <StatusBadge tone="success" label="Encrypted SQLite ready" />
          <StatusBadge
            tone={state.health.fts5Available ? 'success' : 'danger'}
            label={state.health.fts5Available ? 'FTS5 available' : 'FTS5 unavailable'}
          />
          <StatusBadge
            tone="neutral"
            label={`Schema ${state.health.schemaVersion}`}
          />
          <StatusBadge
            tone={state.health.domainReady ? 'success' : 'warning'}
            label={`Domain ${state.health.domainStatus}`}
          />
          <dl className="settings__counters">
            <div><dt>Startup audit evaluated at</dt><dd><time dateTime={state.health.domainStartupEvaluatedAt}>{state.health.domainStartupEvaluatedAt}</time></dd></div>
            <div className="settings__counter">
              <dt>Cipher</dt>
              <dd>{state.health.cipherVersion}</dd>
            </div>
            <div className="settings__counter">
              <dt>Active job count</dt>
              <dd className="numeric">{state.health.pendingJobs}</dd>
            </div>
            <div className="settings__counter">
              <dt>Recovery count</dt>
              <dd className="numeric">{state.health.interruptedJobsRecovered}</dd>
            </div>
          </dl>
        </div>
      )}
      {state.status === 'failed' && (
        <div
          className="settings__failure"
          aria-labelledby="diagnostic-read-error"
          aria-live="assertive"
          role="alert"
        >
          <h3 id="diagnostic-read-error">The diagnostic read could not be completed</h3>
          <p>
            Error code: <code>DIAGNOSTIC_READ_FAILED</code>
          </p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      <HealthObservationStatus observation={observation} onRetry={onRetry} />
    </section>
  );
}

const SHORTCUTS: readonly { scope: string; keys: string; action: string }[] = [
  { scope: 'Application menu', keys: 'Cmd/Ctrl+1 – Cmd/Ctrl+3', action: 'Go to Today, Accounts, Campaigns' },
  { scope: 'Application menu', keys: 'Cmd/Ctrl+,', action: 'Open Settings' },
  { scope: 'Application', keys: 'Cmd/Ctrl+K', action: 'Open the existing command palette when permitted' },
  { scope: 'Native Desk rows', keys: 'J / K / arrows · Enter · Escape', action: 'Move focused queue row; Enter reviews; Escape closes selected detail only when no higher layer owns it' },
];

function ShortcutsSection() {
  return (
    <section
      id="settings-shortcuts"
      className="settings__section"
      aria-label="Keyboard shortcuts"
    >
      <h2 className="settings__section-title">Keyboard shortcuts</h2>
      <p>Editing fields and open overlays own their keys. Shortcuts do not grant permission to call or send.</p>
      <table className="settings__shortcuts">
        <thead>
          <tr>
            <th scope="col">Scope</th>
            <th scope="col">Shortcut</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((shortcut) => (
            <tr key={shortcut.keys}>
              <td>{shortcut.scope}</td>
              <th scope="row">
                <kbd>{shortcut.keys}</kbd>
              </th>
              <td>{shortcut.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function AboutSection({ health }: { health: AppHealth | null }) {
  return (
    <section
      id="settings-about"
      className="settings__section"
      aria-label="About"
    >
      <h2 className="settings__section-title">About</h2>
      {health === null ? (
        <p className="settings__quiet">Available once the foundation is ready.</p>
      ) : (
        <dl className="settings__counters">
          <div className="settings__counter">
            <dt>App version</dt>
            <dd className="numeric">{health.appVersion}</dd>
          </div>
          <div className="settings__counter">
            <dt>Schema version</dt>
            <dd className="numeric">{health.schemaVersion}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

type SettingsDelegationApi = Pick<CalliePreloadApi['delegation'], 'status' | 'pair'> &
  Partial<Pick<CalliePreloadApi['delegation'], 'configure' | 'sync' | 'googleConnections' | 'researchSetup' | 'readSuppression'>>;

function hasWorkspaceAccess(api: SettingsDelegationApi | undefined): api is SettingsDelegationApi & Pick<CalliePreloadApi['delegation'], 'configure' | 'sync'> {
  return typeof api?.configure === 'function' && typeof api.sync === 'function';
}

export type SettingsScreenProps = {
  state: DiagnosticsState;
  onRetry: () => void;
  observation?: HealthObservation;
  theme: ThemeState;
  density: DensityState;
  shell?: SettingsShellApi;
  recovery?: RecoveryProvider;
  localWorkspaceApi?: LocalWorkspaceApi;
  outreachApi?: OutreachApi;
  phoneSetupApi?: PhoneSetupApi;
  delegationApi?: SettingsDelegationApi;
  /** Settings → Email templates. Absent on an older bridge, which shows the section's honest unavailable state. */
  templatesApi?: CalliePreloadApi['templates'];
  /** Extra diagnostics panels (Apple spike), rendered with Diagnostics. */
  children?: ReactNode;
};

/**
 * The Settings route: a two-pane master-detail. The left rail lists the six
 * sections; the right pane renders ONLY the active section. Diagnostics is
 * the default selection so the packaged foundation E2E finds its exact
 * strings without any clicks. Selection is plain component state; the app
 * router's hash is never touched. Failure copy stays stable and never
 * exposes raw errors or internal paths.
 */
export function SettingsScreen({
  state,
  onRetry,
  observation,
  theme,
  density,
  shell,
  recovery,
  localWorkspaceApi,
  outreachApi,
  phoneSetupApi,
  delegationApi,
  templatesApi,
  children,
}: SettingsScreenProps) {
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [active, setActive] = useState<SettingsSectionId>(() => {
    // Reading is non-consuming: StrictMode may invoke this initializer twice.
    try {
      const section = window.sessionStorage.getItem('callie.settings.section');
      return SECTIONS.find(item => item.id === section)?.id ?? 'diagnostics';
    } catch { return 'diagnostics'; }
  });
  useEffect(() => {
    const clearIntent = () => {
      try { window.sessionStorage.removeItem('callie.settings.section'); }
      catch { /* Storage failure must not prevent event or rail navigation. */ }
    };
    // Consume only after commit, including invalid and not-yet-implemented IDs.
    clearIntent();
    const showSection = (event: Event) => {
      clearIntent();
      const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
      const section = SECTIONS.find(item => item.id === detail);
      if (section) setActive(section.id);
    };
    const showConnections = () => { clearIntent(); setActive('connections'); };
    window.addEventListener('callie:open-settings-section', showSection);
    window.addEventListener('callie:open-connections', showConnections);
    return () => {
      window.removeEventListener('callie:open-settings-section', showSection);
      window.removeEventListener('callie:open-connections', showConnections);
    };
  }, []);
  const health = state.status === 'ready' ? state.health : null;

  return (
    <div className="settings">
      <PageHeader title="Settings" />
      <div className="settings__layout">
        <nav className="settings__sections" aria-label="Settings sections">
          <ul className="settings__section-list">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className={
                    section.id === active
                      ? 'settings__section-link settings__section-link--current'
                      : 'settings__section-link'
                  }
                  aria-current={section.id === active ? 'true' : undefined}
                  onClick={() => setActive(section.id)}
                >
                  {section.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings__detail">
          {active === 'call-capacity' && <CallCapacitySection api={localWorkspaceApi} onSaved={notifyCallCapacitySaved} />}
          {active === 'territory' && <TerritoryClearanceSection api={localWorkspaceApi} />}
          {active === 'email-templates' && <EmailTemplatesSection api={templatesApi} grants={delegationApi?.googleConnections} />}
          {active === 'connections' && <>
            <RemoteGoogleConnectionsSection api={delegationApi?.googleConnections} />
            <ConnectionsSection api={outreachApi} onSaved={() => setConnectionRevision(value => value + 1)} />
            <LocalCompanyResearchSection api={localWorkspaceApi} outreachApi={outreachApi} connectionRevision={connectionRevision} />
          </>}
          {active === 'phone' && <PhoneSetupSection api={phoneSetupApi} />}
          {active === 'suppressed' && <SuppressionSection api={delegationApi} />}
          {active === 'worker' && <>
            <WorkerSetupSection api={delegationApi} />
            <WorkspaceAccessSection api={hasWorkspaceAccess(delegationApi) ? delegationApi : undefined} onChanged={notifyCallCapacitySaved} />
            <ResearchSetupSection api={delegationApi?.researchSetup} />
          </>}
          {active === 'appearance' && (
            <AppearanceSection theme={theme} density={density} />
          )}
          {active === 'data' && (
            <DataStorageSection health={health} shell={shell} recovery={recovery} localWorkspaceApi={localWorkspaceApi} />
          )}
          {active === 'diagnostics' && (
            <>
              <DiagnosticsSection state={state} onRetry={onRetry} observation={observation} />
              {children}
            </>
          )}
          {active === 'shortcuts' && <ShortcutsSection />}
          {active === 'about' && <AboutSection health={health} />}
        </div>
      </div>
    </div>
  );
}
