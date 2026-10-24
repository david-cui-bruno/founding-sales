import { useState, type JSX } from 'react';
import type { SourceObservation } from '@fss/contracts';

/** In-memory disclosure of already-returned captures, never a fetch or interpretation. */
export function CapturedQualificationOriginals({ source }: { source: SourceObservation }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return <div>
    <p>Captured observation {source.id} · {source.blocks.length} original blocks</p>
    <button type="button" aria-expanded={expanded}
      aria-label={`${expanded ? 'Hide' : 'Show'} captured original blocks for observation ${source.id}`}
      onClick={() => { setExpanded(value => !value); }}>
      {expanded ? 'Hide captured original blocks' : 'Show captured original blocks'}
    </button>
    {expanded ? <section aria-label={`Captured original blocks for observation ${source.id}`}>
      <p>Dated captured text only, not accepted facts or verified identity. No qualification or contact authority.</p>
      <p>Retrieved {source.retrievedAt} · Published {source.publishedAt ?? 'unknown'} · First party {String(source.firstParty)} · Truncated {String(source.truncated)}</p>
      {source.blocks.map(block => <div key={block.id}>
        <p>Block {block.id}</p>
        <pre>{block.text}</pre>
      </div>)}
    </section> : null}
  </div>;
}
