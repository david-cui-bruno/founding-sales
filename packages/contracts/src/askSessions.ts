import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {askAnswerReadResultSchema} from './askAnswers.ts';
import {askAgentScopeSchema} from './askAgentScope.ts';
const command={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const askSessionCreatePayloadSchema=z.strictObject({scope:askAgentScopeSchema.default({kind:'business'})});
export const askSessionCreateSchema=askSessionCreatePayloadSchema.extend(command);
export const askSessionIdentitySchema=z.strictObject({sessionId:z.uuid(),version:z.number().int().positive()});
export const askSessionReadSchema=z.strictObject({sessionId:z.uuid()});
export const askSessionTurnPayloadSchema=askSessionIdentitySchema.extend({question:z.string().trim().min(1).max(300)});
export const askSessionTurnSchema=askSessionTurnPayloadSchema.extend(command);
export const askSessionChangePayloadSchema=askSessionIdentitySchema.extend({action:z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('scope'),scope:askAgentScopeSchema,confirmExpansion:z.boolean().default(false)}),
 z.strictObject({kind:z.literal('rename'),title:z.string().trim().min(1).max(100)}),
 z.strictObject({kind:z.literal('pin'),pinned:z.boolean()}),
 z.strictObject({kind:z.literal('delete')}),
])});
export const askSessionChangeSchema=askSessionChangePayloadSchema.extend(command);
export const askSessionViewSchema=askSessionIdentitySchema.extend({scope:askAgentScopeSchema.nullable(),title:z.string().max(100).nullable(),pinned:z.boolean(),state:z.enum(['active','deleted']),createdAt:z.iso.datetime(),turns:z.array(askAnswerReadResultSchema).max(50),coverage:z.enum(['current','changed','partial'])});
export const askSessionListSchema=z.strictObject({limit:z.number().int().min(1).max(50).default(20)});
export const askSessionPageSchema=z.strictObject({sessions:z.array(askSessionViewSchema).max(50),truncated:z.boolean()});
export const askSessionTurnAcknowledgmentSchema=askSessionIdentitySchema.extend({requestId:z.uuid(),requestVersion:z.number().int().positive(),state:z.enum(['pending','unavailable'])});
