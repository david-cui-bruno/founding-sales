import type { LifecycleStage } from '../../../shared/contracts/commonContract';
import type { PipelineCard } from '../../../shared/contracts/pipelineContract';

/**
 * The lifecycle is fixed. This map owns the only renderer copies of the
 * stage display strings; no component may add, rename, or reorder stages.
 */
export type PipelineStageMeta = {
  label: string;
  description: string;
};

export const PIPELINE_STAGE_META: Readonly<Record<LifecycleStage, PipelineStageMeta>> =
  Object.freeze({
    unreviewed: {
      label: 'Unreviewed',
      description: 'New leads waiting on a first review.',
    },
    ready: {
      label: 'Ready',
      description: 'Reviewed leads cleared for outreach.',
    },
    contacted: {
      label: 'Contacted',
      description: 'Outreach has started.',
    },
    interviewed: {
      label: 'Interviewed',
      description: 'A working interview happened.',
    },
    offered: {
      label: 'Offered',
      description: 'An offer is on the table.',
    },
    won: {
      label: 'Won',
      description: 'Accepted, onboarding or closed.',
    },
    lost_nurture: {
      label: 'Lost-Nurture',
      description: 'Not now. Kept warm for reactivation.',
    },
  });

export const stageLabel = (stage: LifecycleStage): string =>
  PIPELINE_STAGE_META[stage].label;

/**
 * Won cycles stay in the single Won column; onboarding versus closed is
 * carried by card metadata instead of a visible custom stage.
 */
export const wonOutcomeLabel = (card: PipelineCard): string | null => {
  if (card.stage !== 'won') {
    return null;
  }
  return card.nextAction?.channel === 'onboarding' ? 'Onboarding' : 'Closed won';
};

export const lostReasonLabel = (card: PipelineCard): string | null => {
  if (card.stage !== 'lost_nurture' || card.lostReasonCode === null) {
    return null;
  }
  return `Lost: ${card.lostReasonCode.replace(/_/g, ' ')}`;
};
