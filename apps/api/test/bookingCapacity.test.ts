import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createAuthFixture,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {routeBookingCapacity} from '../src/routes/bookingCapacity.ts';
import {bookingCapacityResponseSchema} from '@fss/contracts';
describe('booking capacity API read',()=>{
  let f:AuthFixture,token:string;
  beforeAll(async()=>{
    f=await createAuthFixture();token=(await issueSessionFor(f,f.alpha,f.alpha.admin)).accessToken;
    await f.db.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value) VALUES($1,'calendar_integration',1,'{\"integration\":\"calcom\"}')",[f.alpha.workspaceId]);
    await f.db.query("INSERT INTO outreach_settings(workspace_id,booking_url) VALUES($1,'https://cal.com/callie-founder/intro')",[f.alpha.workspaceId]);
  });afterAll(async()=>{await f.stop();});
  const read=async(method='GET',bearer=token)=>await routeBookingCapacity({method,path:'/meetings/booking-capacity',query:new URLSearchParams(),headers:{authorization:`Bearer ${bearer}`},body:undefined},{session:f.db,auth:f.deps,supportedClientVersions:f.deps.config.supportedClientVersions,suppressionJournal:{append:async()=>{}},sendingEnabled:false,upgradeUrl:'https://example.test/update'});
  it('answers an authenticated reader with precise missing-access evidence and the unverified preference',async()=>{
    const answer=await read();expect(answer?.status).toBe(200);
    expect(bookingCapacityResponseSchema.parse(answer?.body)).toMatchObject({preference:{weeklyIntroCalls:3,enforcementVerified:false},provider:{reason:'api_key_missing'}});
  });
  it('refuses a missing authenticated session and any non-read method',async()=>{
    expect((await read('GET','not-an-access-token'))?.status).toBe(401);
    expect((await read('POST'))?.status).toBe(405);
  });
  it('does not reuse another workspace configuration under a different active membership',async()=>{
    const beta=(await issueSessionFor(f,f.beta,f.beta.admin)).accessToken;
    const answer=await read('GET',beta);expect(answer?.status).toBe(200);
    expect(bookingCapacityResponseSchema.parse(answer?.body)).toMatchObject({provider:{reason:'integration_off',bookingUrl:null},recorded:{bookings:[]}});
  });

});
