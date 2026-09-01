import { useEffect, useRef, useState } from 'react';

import type { PipelineSnapshot } from '../../../shared/contracts/pipelineContract';
import { PipelineStageColumn } from './PipelineStageColumn';

export type PipelineBoardProps = {
  snapshot: PipelineSnapshot;
  onOpenLead(personId: string): void;
};

/**
 * Horizontally scrolling board over the fixed lifecycle columns. Order
 * comes exclusively from the main-process snapshot. While more columns
 * remain off-screen to the right, a gradient scrim signals the overflow.
 */
export function PipelineBoard({ snapshot, onOpenLead }: PipelineBoardProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);

  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) {
      return undefined;
    }
    const update = () => {
      setMoreRight(node.scrollWidth - node.scrollLeft - node.clientWidth > 1);
    };
    update();
    node.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(node);
    return () => {
      node.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [snapshot]);

  return (
    <div
      className={
        moreRight
          ? 'pipeline-board-frame pipeline-board-frame--more'
          : 'pipeline-board-frame'
      }
    >
      <div className="pipeline-board" ref={scrollRef}>
        {snapshot.stages.map((lane) => (
          <PipelineStageColumn
            key={lane.stage}
            lane={lane}
            onOpenLead={onOpenLead}
          />
        ))}
      </div>
      <div className="pipeline-board__scrim" aria-hidden="true" />
    </div>
  );
}
