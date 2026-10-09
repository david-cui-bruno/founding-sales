import {z} from 'zod';
import {todayActionSchema,todayActionTargetSchema} from './today.ts';
import {crmCommitmentDueSchema} from './crmCommitments.ts';
import {instant,ianaTimeZone,uuid} from './foundationRows.ts';
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const todayPromiseTargetSchema=z.strictObject({kind:z.literal('internal_task'),taskId:uuid,expectedVersion:z.number().int().positive(),
 review:z.strictObject({commitmentId:uuid,revision:z.number().int().positive(),projectionVersion:z.number().int().nonnegative()}),
 support:z.strictObject({sourceKind:z.enum(['selected_note','mail','call_transcript','meeting_transcript']),sourceId:uuid,sourceRevision:z.number().int().positive(),sourceHash:hash,contextHash:hash,decisionRevision:z.number().int().nonnegative()}),
});
export type TodayPromiseTarget=z.infer<typeof todayPromiseTargetSchema>;
export const todayPromiseActionSchema=z.strictObject({actionId:z.string().min(1).max(200),kind:z.literal('promise'),subject:z.string().min(1).max(300),reason:z.literal('dated_promise'),due:crmCommitmentDueSchema,state:z.enum(['open','overdue']),target:todayPromiseTargetSchema});
export const todayActionV2Schema=z.union([todayActionSchema,todayPromiseActionSchema]);
export const todayTargetV2Schema=z.union([todayActionTargetSchema,todayPromiseTargetSchema]);
export const todayActionsV2ResponseSchema=z.strictObject({version:z.literal(2),workspaceId:uuid,businessTimeZone:ianaTimeZone,asOf:instant,actions:z.array(todayActionV2Schema),promiseCoverage:z.strictObject({scope:z.literal('current_authorized_work'),truncated:z.boolean(),nextAfterId:uuid.nullable()})});
export const todayActionOpenV2RequestSchema=z.strictObject({actionId:z.string().min(1).max(200),target:todayTargetV2Schema});
export const todayActionOpenV2ResponseSchema=z.strictObject({version:z.literal(2),target:todayTargetV2Schema.nullable()});
export type TodayActionV2=z.infer<typeof todayActionV2Schema>;
export type TodayTargetV2=z.infer<typeof todayTargetV2Schema>;
export type TodayActionsV2Response=z.infer<typeof todayActionsV2ResponseSchema>;
