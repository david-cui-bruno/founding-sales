import {describe,it,expect} from 'vitest';
import {firmQualificationNotStartedSchema,firmQualificationViewSchema} from '../src/sourcingQualification.ts';
const candidateId='00000000-0000-4000-8000-000000000001';
const pending={candidateId,candidateRevision:1,status:'not_started',nativeEligibility:{status:'pending',reason:'evidence_pending',channelAuthority:'not_granted'}};
describe('zero-run Firm qualification action boundary',()=>{
 it('retains a validated current candidate without inventing a run',()=>{expect(firmQualificationViewSchema.parse(pending)).toEqual(pending);});
 it('does not invent native evidence or grant a channel',()=>{expect(firmQualificationNotStartedSchema.safeParse({...pending,nativeEligibility:{status:'verified',channelAuthority:'granted'}}).success).toBe(false);});
 it.each([0,-1,1.5])('rejects invalid revision %s',candidateRevision=>{expect(firmQualificationNotStartedSchema.safeParse({...pending,candidateRevision}).success).toBe(false);});
 it('rejects invalid candidate identity',()=>{expect(firmQualificationNotStartedSchema.safeParse({...pending,candidateId:'unknown'}).success).toBe(false);});
 it('rejects fabricated run or evidence fields',()=>{expect(firmQualificationNotStartedSchema.safeParse({...pending,runId:candidateId,observations:[]}).success).toBe(false);});
});
