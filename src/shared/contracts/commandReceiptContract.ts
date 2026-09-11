import {z} from 'zod';
import {accountIdSchema} from './accountContract';
const revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const reason=z.string().trim().min(1).max(2000);
/** Pure canonical receipt shared by transport and typed captured-approval status. */
export const commandReceiptSchema=z.strictObject({commandId:accountIdSchema,status:z.enum(['pending','applied','rejected']),authorityGeneration:revision,aggregateVersion:revision,reason:reason.nullable()});
export type CommandReceipt=Readonly<z.infer<typeof commandReceiptSchema>>;
