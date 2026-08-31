import type { PipelineSnapshot } from '../../../shared/contracts/pipelineContract';
import { PipelineStageColumn } from './PipelineStageColumn';

export type PipelineBoardProps = {
  snapshot: PipelineSnapshot;
  onOpenLead(personId: string): void;
};

/**
 * Horizontally scrolling board over the fixed lifecycle columns. Order
 * comes exclusively from the main-process snapshot.
 */
export function PipelineBoard({ snapshot, onOpenLead }: PipelineBoardProps) {
  return (
    <div className="pipeline-board">
      {snapshot.stages.map((lane) => (
        <PipelineStageColumn
          key={lane.stage}
          lane={lane}
          onOpenLead={onOpenLead}
        />
      ))}
    </div>
  );
}
