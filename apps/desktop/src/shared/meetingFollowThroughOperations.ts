import { z } from 'zod';
import { meetingDraftEditSchema, meetingFollowThroughViewV2Schema, saveMeetingUnpublishedPlanSchema, uuid } from '@fss/contracts';

const output = z.strictObject({ view: meetingFollowThroughViewV2Schema.nullable(), reason: z.string().max(80).nullable() });
export const MEETING_FOLLOW_THROUGH_OPERATIONS = {
  'meetings.followThrough': {
    kind: 'read', calls: [{ method: 'GET', path: '/meetings/follow-through?meetingId={uuid}&version=2' }],
    input: z.strictObject({ meetingId: uuid }), output,
    transform: 'current recap and follow-through, never cached on disk',
  },
  'meetings.editRecap': {
    kind: 'command', calls: [{ method: 'POST', path: '/meetings/recap/edit?version=2' }],
    input: z.discriminatedUnion('action', [
      meetingDraftEditSchema.options[0].extend({ commandId: uuid }), meetingDraftEditSchema.options[1].extend({ commandId: uuid }),
      meetingDraftEditSchema.options[2].extend({ commandId: uuid }), meetingDraftEditSchema.options[3].extend({ commandId: uuid }),
      meetingDraftEditSchema.options[4].extend({ commandId: uuid }),
    ]), output, transform: 'durable edit hold and versioned save, discard or cancellation',
  },
  'meetings.saveUnpublishedPlan': {
    kind: 'command', calls: [{ method: 'POST', path: '/meetings/unpublished-plan' }],
    input: saveMeetingUnpublishedPlanSchema.extend({ commandId: uuid }), output,
    transform: 'persist four held unpublished drafts without enrollment, publication or permission',
  },
} as const;
