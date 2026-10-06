import {describe,it,expect} from 'vitest';
import {sequenceSubjectSchema,enrollmentDtoSchema} from '../src/index.ts';
const id='11111111-1111-4111-8111-111111111111';
describe('outreach authority contracts',()=>{
 it('requires exactly the named authority and rejects disguised opportunity IDs',()=>{
  expect(sequenceSubjectSchema.parse({kind:'outreach',outreachPlanId:id})).toEqual({kind:'outreach',outreachPlanId:id});
  expect(sequenceSubjectSchema.parse({kind:'opportunity',opportunityId:id})).toEqual({kind:'opportunity',opportunityId:id});
  for(const subject of [{},{kind:'outreach',opportunityId:id},{kind:'outreach',outreachPlanId:id,opportunityId:id}])expect(sequenceSubjectSchema.safeParse(subject).success).toBe(false);
 });
 it('decodes a legacy enrollment without an outreach property and preserves a null opportunity on new reads',()=>{
  const row={id,sequenceVersionId:id,opportunityId:id,firmId:id,contactId:id,assignedUserId:id,state:'active',startedAt:'2026-10-01T12:00:00Z',endedAt:null,endReason:null,originKind:'prospecting',permissionId:null,firmTimeZone:'America/New_York',holidayCalendarVersion:'none',reviewUnionMilliseconds:null};
  expect(enrollmentDtoSchema.parse(row).outreachPlanId).toBeNull();
  expect(enrollmentDtoSchema.parse({...row,opportunityId:null,outreachPlanId:id})).toMatchObject({opportunityId:null,outreachPlanId:id});
 });
});
