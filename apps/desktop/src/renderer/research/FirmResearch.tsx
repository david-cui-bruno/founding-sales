import { type JSX } from 'react';
import type { Generation } from '../app/generation.ts';
import { ResearchSection } from './ResearchSection.tsx';
import { useResearch } from './useResearch.ts';

/**
 * The Firm page's Research section, mounted with its own read (lane R).
 *
 * Its own hook rather than a field on the CRM state, for one reason: the firm page's
 * contract is a `z.strictObject` behind `pageVersion`, so a key added to it is a wire
 * break an installed desktop cannot parse. A section that reads its own route is not,
 * and the cost is one extra read when a firm page opens.
 *
 * It mounts only while a firm page is on screen, so nothing is read for the board.
 */
export function FirmResearch({
  firmId,
  identity,
  generation,
  guard,
  enabled,
}: {
  readonly firmId: string;
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
  readonly enabled: boolean;
}): JSX.Element | null {
  const research = useResearch({ firmId, identity, generation, guard });
  if (!research.available) return null;
  return (
    <ResearchSection
      firmId={firmId}
      state={research.state}
      enabled={enabled}
      busy={research.busy}
      onResearchNow={() => {
        research.actions.run(firmId);
      }}
      onAddLink={url => {
        research.actions.addLink({ firmId, url });
      }}
    />
  );
}
