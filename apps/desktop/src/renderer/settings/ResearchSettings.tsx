import type { JSX } from 'react';
import type { Generation } from '../app/generation.ts';
import { researchForm, useResearch } from '../research/useResearch.ts';
import { ResearchSettingsSection } from './ResearchSettingsSection.tsx';

/**
 * Settings › Administration › Research, mounted with its own read (lane R).
 *
 * `/research/settings` is one admin-only path that answers `{}` and updates fields, so
 * the "read" here is a command with an empty patch. A salesperson is answered
 * `settings: null` and the section renders nothing at all.
 */
export function ResearchSettings({
  identity,
  generation,
  guard,
}: {
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
}): JSX.Element | null {
  const research = useResearch({ firmId: null, identity, generation, guard });
  if (!research.available) return null;
  return (
    <ResearchSettingsSection
      state={research.state}
      saving={research.busy(researchForm.settings)}
      onSave={research.actions.saveSettings}
    />
  );
}
