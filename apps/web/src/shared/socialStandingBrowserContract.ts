import {z} from 'zod';
import {uuid,socialStandingCommandSchema,socialStandingPlanReadSchema,socialStandingOptionsSchema,socialStandingActivitySchema,socialStandingReceiptInputSchema} from '@fss/contracts';
import {socialCommandResult} from './socialBrowserContract.ts';
const saved=z.strictObject({planId:uuid,revision:z.number().int().positive()}).nullable();
export const socialStandingCommandResultSchema=socialCommandResult(saved);
export const socialStandingReceiptSchema=z.discriminatedUnion('state',[z.strictObject({state:z.literal('unknown')}),z.strictObject({state:z.literal('accepted'),result:saved}),z.strictObject({state:z.literal('refused'),reason:z.string().regex(/^[a-z_]{1,100}$/u)})]);
// The API owns version/command envelope; browser uses only this finite union.
export const socialStandingBrowserCommandSchema=socialStandingCommandSchema;
export const socialStandingRequests:Readonly<Record<string,z.ZodType>>={
 '/social/standing-plan/read':z.strictObject({}),'/social/standing-plan/options':z.strictObject({}),'/social/standing-plan/activity':z.strictObject({}),'/social/standing-plan/receipt':socialStandingReceiptInputSchema,'/social/standing-plan/command':socialStandingBrowserCommandSchema,
};
export const socialStandingResponses:Readonly<Record<string,z.ZodType>>={
 '/social/standing-plan/read':socialStandingPlanReadSchema,'/social/standing-plan/options':socialStandingOptionsSchema,'/social/standing-plan/activity':socialStandingActivitySchema,'/social/standing-plan/receipt':socialStandingReceiptSchema,'/social/standing-plan/command':socialStandingCommandResultSchema,
};
