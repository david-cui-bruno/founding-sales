import { Monitor, Moon, Rows2, Rows3, Sun, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { DensityPreference, DensityState } from '../app/useDensity';
import type { ThemePreference, ThemeState } from '../app/useTheme';
import { PageHeader } from '../components/PageHeader';
import { HealthDetails, type DiagnosticsState } from './DiagnosticsScreen';

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

/**
 * Settings → Appearance: the same theme and density controls the old top bar
 * carried, persisting through the identical `callie.theme` / `callie.density`
 * keys so existing preferences survive the move.
 */
function AppearanceSection({
  theme,
  density,
}: {
  theme: ThemeState;
  density: DensityState;
}) {
  return (
    <section className="settings__section" aria-label="Appearance">
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

export type SettingsScreenProps = {
  state: DiagnosticsState;
  onRetry: () => void;
  theme: ThemeState;
  density: DensityState;
  children?: ReactNode;
};

/**
 * The Settings route: Appearance preferences first, then the foundation
 * diagnostics that previously filled the whole route. Failure copy stays
 * stable and never exposes raw errors or internal paths.
 */
export function SettingsScreen({
  state,
  onRetry,
  theme,
  density,
  children,
}: SettingsScreenProps) {
  return (
    <div className="settings">
      <PageHeader title="Settings" />
      <AppearanceSection theme={theme} density={density} />
      <section className="settings__section" aria-label="Diagnostics">
        <h2 className="settings__section-title">Diagnostics</h2>
        {state.status === 'loading' && (
          <p role="status">Checking local foundation…</p>
        )}
        {state.status === 'ready' && <HealthDetails health={state.health} />}
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
        {children}
      </section>
    </div>
  );
}
