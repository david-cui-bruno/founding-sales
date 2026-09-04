import { Monitor, Moon, Rows2, Rows3, Sun, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import type { AppHealth } from '../../shared/healthContract';
import type { DensityPreference, DensityState } from '../app/useDensity';
import type { ThemePreference, ThemeState } from '../app/useTheme';
import { PageHeader } from '../components/PageHeader';
import { StatusBadge } from '../components/StatusBadge';
import type { DiagnosticsState } from './DiagnosticsScreen';

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

type SettingsSectionId =
  | 'appearance'
  | 'data'
  | 'sourcing'
  | 'diagnostics'
  | 'shortcuts'
  | 'about';

const SECTIONS: readonly { id: SettingsSectionId; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data & storage' },
  { id: 'sourcing', label: 'Sourcing' },
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
}: {
  health: AppHealth | null;
  shell?: SettingsShellApi;
}) {
  return (
    <section
      id="settings-data"
      className="settings__section"
      aria-label="Data & storage"
    >
      <h2 className="settings__section-title">Data &amp; storage</h2>
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
}: {
  state: DiagnosticsState;
  onRetry: () => void;
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
          <StatusBadge
            tone={state.health.operationalStatus === 'ready' ? 'success' : 'warning'}
            label={`Operations ${state.health.operationalStatus}`}
          />
          <dl className="settings__counters">
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
          aria-labelledby="database-error"
          aria-live="assertive"
          role="alert"
        >
          <h3 id="database-error">The local database could not be opened</h3>
          <p>
            Error code: <code>LOCAL_DATABASE_UNAVAILABLE</code>
          </p>
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}

const SHORTCUTS: readonly { keys: string; action: string }[] = [
  { keys: '⌘1 – ⌘7', action: 'Go to Today, Leads, Pipeline, Conversations, Learnings, Friday, Review' },
  { keys: '⌘K', action: 'Open the command palette' },
  { keys: '⌘I', action: 'Import leads' },
  { keys: 'J / K', action: 'Move down / up a row' },
  { keys: 'Enter', action: 'Open the focused row' },
  { keys: 'E / H / P', action: 'Complete / snooze / pin the focused Today action' },
];

function ShortcutsSection() {
  return (
    <section
      id="settings-shortcuts"
      className="settings__section"
      aria-label="Keyboard shortcuts"
    >
      <h2 className="settings__section-title">Keyboard shortcuts</h2>
      <table className="settings__shortcuts">
        <thead>
          <tr>
            <th scope="col">Shortcut</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUTS.map((shortcut) => (
            <tr key={shortcut.keys}>
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

export type SettingsScreenProps = {
  state: DiagnosticsState;
  onRetry: () => void;
  theme: ThemeState;
  density: DensityState;
  shell?: SettingsShellApi;
  /** Sourcing status rows, rendered inside the Sourcing section. */
  sourcing?: ReactNode;
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
  theme,
  density,
  shell,
  sourcing,
  children,
}: SettingsScreenProps) {
  const [active, setActive] = useState<SettingsSectionId>('diagnostics');
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
          {active === 'appearance' && (
            <AppearanceSection theme={theme} density={density} />
          )}
          {active === 'data' && (
            <DataStorageSection health={health} shell={shell} />
          )}
          {active === 'sourcing' && (
            <section
              id="settings-sourcing"
              className="settings__section"
              aria-label="Sourcing"
            >
              <h2 className="settings__section-title">Sourcing</h2>
              {sourcing ?? (
                <p className="settings__quiet">Sourcing inbox: not configured</p>
              )}
            </section>
          )}
          {active === 'diagnostics' && (
            <>
              <DiagnosticsSection state={state} onRetry={onRetry} />
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
