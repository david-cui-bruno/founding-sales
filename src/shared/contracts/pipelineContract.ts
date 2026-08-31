import { z } from 'zod';

import {
  leadPriorityContextSchema,
  lifecycleStageSchema,
  personIdSchema,
  primaryActionSchema,
  salesCycleIdSchema,
} from './commonContract';

export const pipelineCardSchema = z.object({
  personId: personIdSchema, salesCycleId: salesCycleIdSchema, personName: z.string().min(1),
  contextLabel: z.string().nullable(), stage: lifecycleStageSchema, stageEnteredAt: z.string().datetime({ offset: true }),
  priorityContext: leadPriorityContextSchema.nullable(), nextAction: primaryActionSchema.nullable(), lostReasonCode: z.string().nullable(),
}).strict();
export const pipelineSnapshotSchema = z.object({
  stages: z.array(z.object({ stage: lifecycleStageSchema, cards: z.array(pipelineCardSchema) }).strict()),
  revision: z.number().int().nonnegative(),
}).strict();

export type PipelineCard = z.infer<typeof pipelineCardSchema>;
export type PipelineSnapshot = z.infer<typeof pipelineSnapshotSchema>;
