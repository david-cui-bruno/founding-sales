import { z } from 'zod';
import { uuid } from './foundationRows.ts';
export const mailSourceReadSchema = z
  .object({
    sourceId: uuid,
    sourceRevision: z.number().int().positive(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    locator: z.string().max(200).optional(),
  })
  .strict();
export type MailSourceRead = z.infer<typeof mailSourceReadSchema>;

export const mailControlsReadSchema = z
  .object({ mailboxId: uuid.optional() })
  .strict();

import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
export const mailSourceChangeSchema = z
  .object({
    sourceId: uuid,
    expectedRevision: z.number().int().positive(),
    commandId: commandIdSchema,
    clientVersion: semanticVersionSchema,
  })
  .strict();

export const mailSourcesListSchema = z
  .object({
    mailboxId: uuid.optional(),
    personId: uuid.optional(),
    firmId: uuid.optional(),
    afterId: uuid.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

export const mailSourceAssociateSchema = mailSourceChangeSchema
  .extend({ personId: uuid.optional(), firmId: uuid.optional() })
  .refine(
    (value) => value.personId !== undefined || value.firmId !== undefined,
  );

export const mailSourceStateReadSchema = z.object({ sourceId: uuid }).strict();

const mailContextSchema = z.strictObject({
  contextId: uuid,
  personId: uuid.nullable(),
  firmId: uuid.nullable(),
  opportunityId: uuid.nullable(),
  sourceRevision: z.number().int().positive(),
  review: z.enum(['current', 'review_required']),
  operationalMatchId: uuid.nullable(),
  operationalMatchHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  identityStatus: z.enum(['unresolved', 'observed_label', 'reviewed']),
});
export const mailConversationSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('unavailable'),
    reason: z.string().max(100),
    source: z.null(),
  }),
  z.strictObject({
    state: z.literal('available'),
    source: z.strictObject({
      sourceId: uuid,
      direction: z.enum(['incoming', 'outgoing']),
      subject: z.string().max(998).nullable(),
      sourceRevision: z.number().int().positive(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
      passage: z.string().max(200000).nullable(),
      ownerUserId: uuid,
      mailboxId: uuid,
      accountBinding: z.string().regex(/^[a-f0-9]{64}$/u),
      acquiredGeneration: z.number().int().positive(),
      originalContexts: z.array(mailContextSchema).max(100),
      reviewedContexts: z.array(mailContextSchema).max(100),
      participants: z.array(z.string().max(320)).max(50),
      parserVersion: z.string().max(100),
      representation: z.enum(['plain_text', 'html_flattened']),
      completeness: z.enum(['complete', 'partial', 'unavailable']),
      rawSenderDate: z.string().max(200).nullable(),
      occurredAt: z.string().datetime(),
      observedAt: z.string().datetime(),
      ranges: z
        .array(
          z.strictObject({
            start: z.number().int().nonnegative(),
            end: z.number().int().nonnegative(),
            kind: z.enum(['authored', 'quoted', 'forwarded', 'unknown']),
          }),
        )
        .max(100),
      sentProof: z.boolean(),
    }),
  }),
]);
export type MailConversation = z.infer<typeof mailConversationSchema>;
export const mailSourceListSchema = z.strictObject({
  sources: z
    .array(
      z.strictObject({
        sourceId: uuid,
        sourceRevision: z.number().int().positive(),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
        availability: z.enum(['available', 'deleted', 'awaiting_recapture']),
        occurredAt: z.string().datetime().nullable(),
        completeness: z.enum(['complete', 'partial', 'unavailable']),
      }),
    )
    .max(100),
  nextAfterId: uuid.nullable(),
});
export type MailSourceList = z.infer<typeof mailSourceListSchema>;
export const mailCaptureControlsSchema = z.strictObject({
  mailboxId: uuid,
  enabled: z.boolean(),
  ready: z.boolean(),
  reason: z.string().max(100),
  revision: z.number().int().nonnegative(),
});
export const mailSourceChangedSchema = z.strictObject({
  sourceId: uuid,
  sourceRevision: z.number().int().positive(),
  availability: z
    .enum(['available', 'deleted', 'awaiting_recapture'])
    .optional(),
});
export const mailSourceStateSchema = z
  .strictObject({
    revision: z.number().int().positive(),
    availability: z.enum(['available', 'deleted', 'awaiting_recapture']),
  })
  .nullable();
export const mailSourceChangePayloadSchema = mailSourceChangeSchema.omit({
  commandId: true,
  clientVersion: true,
});
export const mailSourceAssociatePayloadSchema = mailSourceChangePayloadSchema
  .extend({ personId: uuid.optional(), firmId: uuid.optional() })
  .refine(
    (value) => value.personId !== undefined || value.firmId !== undefined,
  );
export const mailSourceRecaptureQueuedSchema = z.strictObject({
  sourceId: uuid,
  sourceRevision: z.number().int().positive(),
  status: z.literal('queued'),
});

/** Last verified provider-original state; connection freshness never claims current Gmail availability. */
export const originalMailObservationSchema=z.strictObject({
 state:z.enum(['unknown','available','trashed','confirmed_missing','transient_unavailable']),
 revision:z.string().regex(/^(0|[1-9][0-9]{0,18})$/u),observedAt:z.string().datetime().nullable(),
 observedGeneration:z.number().int().positive().nullable(),observedAccountBinding:z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
 reason:z.enum(['verified_metadata','verified_trash_label','verified_message_not_found','grant_unavailable','rate_limited','provider_unavailable']).nullable(),
 connectionState:z.enum(['current','disconnected','changed']),
}).refine(value=>value.state==='unknown'?value.observedAt===null&&value.observedGeneration===null&&value.observedAccountBinding===null&&value.reason===null:value.revision!=='0'&&value.observedAt!==null&&value.observedGeneration!==null&&value.observedAccountBinding!==null&&value.reason!==null);
export const mailConversationV2Schema=z.discriminatedUnion('state',[
 mailConversationSchema.options[0],
 mailConversationSchema.options[1].extend({source:mailConversationSchema.options[1].shape.source.extend({originalObservation:originalMailObservationSchema})}),
]);
export type MailConversationV2=z.infer<typeof mailConversationV2Schema>;
