import { Monitor, Moon, Rows2, Rows3, Sun, type LucideIcon } from 'lucide-react';

import { useDensity, type DensityPreference } from './useDensity';
import { useTheme, type ThemePreference } from './useTheme';

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
 * Workspace header with appearance and density preferences. Preferences are
 * the founder's only header controls until feature routes add their own
 * toolbars.
 */
export function WorkspaceHeader() {
  const theme = useTheme();
  const density = useDensity();

  return (
    <header className="workspace-header">
      <div
        className="workspace-header__group"
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
              className="workspace-header__toggle"
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
      <div className="workspace-header__group" role="group" aria-label="Density">
        {densityOptions.map((option) => {
          const Icon = option.icon;
          const pressed = density.density === option.value;

          return (
            <button
              key={option.value}
              type="button"
              className="workspace-header__toggle"
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
    </header>
  );
}
