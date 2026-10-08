import {randomUUID} from 'node:crypto';
import {withTransaction} from '../../db/queryable.ts';
import {createFirm} from '../../crm/firms.ts';
import {receiveCalcomEvent} from '../../meetings/calcom.ts';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {readRoutineSettings,saveRoutineSettings} from '../../outreach/settings.ts';
import {readBookingCapacity} from '../../meetings/bookingCapacity.ts';
const NOW='2026-10-08T12:00:00.000Z';
describe('Cal.com capacity and recorded bookings',()=>{
  let db:TestDatabase,seed:TwoWorkspaces;
  const ctx=():RepositoryContext=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);
  beforeAll(async()=>{
    db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);
    await db.session.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value) VALUES($1,'calendar_integration',1,'{\"integration\":\"calcom\"}')",[seed.alpha.workspaceId]);
    await db.session.query("INSERT INTO outreach_settings(workspace_id,booking_url) VALUES($1,'https://cal.com/callie-founder/intro')",[seed.alpha.workspaceId]);
  });
  afterAll(async()=>{await db.drop();});
  it('reports the missing authorized API key and never treats the three-call preference as enforced',async()=>{
    const result=await readBookingCapacity(ctx(),{client:null,now:NOW});
    expect(result).toMatchObject({preference:{weeklyIntroCalls:3,enforcementVerified:false},provider:{status:'unavailable',reason:'api_key_missing',observedAt:null,eventTypeId:null,weeklyLimit:null},recorded:{bookings:[]}});
  });
  it('reads only the approved personally owned event and labels its weekly setting separately from global capacity',async()=>{
    const result=await readBookingCapacity(ctx(),{now:NOW,client:{
      async readProfile(){return {id:42,username:'callie-founder'};},
      async readEventTypes(input){return input.username==='callie-founder'&&input.eventSlug==='intro'?[{id:73,ownerId:42,slug:'intro',bookingUrl:'https://cal.com/callie-founder/intro',bookingLimitsCount:{week:3}}]:[];},
    }});
    expect(result).toMatchObject({preference:{weeklyIntroCalls:3,enforcementVerified:false},provider:{status:'observed',reason:null,observedAt:NOW,eventTypeId:73,weeklyLimit:3,scope:'event_type'}});
  });

  it('shows retained matched and ambiguous booking evidence with source times without choosing an ambiguous firm',async()=>{
    for(const name of ['Shared Office A','Shared Office B','Known Office'])await withTransaction(db.session,()=>createFirm(ctx(),{name,website:name==='Known Office'?'https://known.example':'https://shared.example',assignedUserId:seed.alpha.salesperson.userId}));
    const book=async(email:string)=>{
      const body={triggerEvent:'BOOKING_CREATED',createdAt:'2026-10-07T14:00:00.000Z',payload:{uid:randomUUID(),startTime:'2026-10-09T15:00:00.000Z',endTime:'2026-10-09T15:30:00.000Z',attendees:[{email}]}};
      return await withTransaction(db.session,()=>receiveCalcomEvent(db.session,{workspaceId:seed.alpha.workspaceId,rawBody:Buffer.from(JSON.stringify(body)),body}));
    };
    const known=await book('manager@known.example'),ambiguous=await book('manager@shared.example');
    const result=await readBookingCapacity(ctx(),{client:null,now:NOW});
    expect(result.recorded.bookings).toEqual(expect.arrayContaining([
      expect.objectContaining({meetingId:known.meetingId,firm:expect.objectContaining({name:'Known Office'}),sourceUpdatedAt:'2026-10-07T14:00:00.000Z',matchReason:null}),
      expect.objectContaining({meetingId:ambiguous.meetingId,firm:null,attendeeEmail:'manager@shared.example',matchReason:'firm_ambiguous'}),
    ]));
  });

  it('keeps retained bookings visible when current provider access is forbidden, with a precise metadata-only refusal',async()=>{
    const result=await readBookingCapacity(ctx(),{now:NOW,client:{async readProfile(){throw new Error('provider_forbidden');},async readEventTypes(){throw new Error('should not read an unverified account');}}});
    expect(result.provider).toMatchObject({status:'unavailable',reason:'provider_forbidden',observedAt:null,eventTypeId:null,weeklyLimit:null});
    expect(result.recorded.bookings.some(row=>row.matchReason==='firm_ambiguous')).toBe(true);
  });

  it('refuses provider evidence for a booking link replaced while the read was pending',async()=>{
    const result=await readBookingCapacity(ctx(),{now:NOW,client:{
      async readProfile(){return {id:42,username:'callie-founder'};},
      async readEventTypes(){
        expect(await withTransaction(db.session,()=>saveRoutineSettings(ctx(),{expectedRevision:1,enabled:false,sequenceVersionId:null,bookingUrl:'https://cal.com/callie-founder/new-intro'}))).toMatchObject({ok:true});
        return [{id:73,ownerId:42,slug:'intro',bookingUrl:'https://cal.com/callie-founder/intro',bookingLimitsCount:{week:3}}];
      },
    }});
    expect(result.provider).toMatchObject({status:'unavailable',reason:'configuration_changed',observedAt:null,eventTypeId:null,weeklyLimit:null});
    await withTransaction(db.session,()=>saveRoutineSettings(ctx(),{expectedRevision:2,enabled:false,sequenceVersionId:null,bookingUrl:'https://cal.com/callie-founder/intro'}));
  });

  it.each([
    {label:'unproven account owner',profile:{username:'callie-founder'},event:{id:73,slug:'intro',bookingUrl:'https://cal.com/callie-founder/intro',bookingLimitsCount:{week:3}}},
    {label:'invalid event identity',profile:{id:42,username:'callie-founder'},event:{id:0,ownerId:42,slug:'intro',bookingUrl:'https://cal.com/callie-founder/intro',bookingLimitsCount:{week:3}}},
    {label:'malformed weekly limit',profile:{id:42,username:'callie-founder'},event:{id:73,ownerId:42,slug:'intro',bookingUrl:'https://cal.com/callie-founder/intro',bookingLimitsCount:{week:2.5}}},
  ])('does not turn $label into verified provider configuration',async({profile,event})=>{
    const result=await readBookingCapacity(ctx(),{now:NOW,client:{async readProfile(){return profile;},async readEventTypes(){return [event];}}});
    expect(result.provider).toMatchObject({status:'unavailable',reason:'provider_invalid_response',eventTypeId:null,weeklyLimit:null});
  });

  it('does not query a team booking link through a personal-account read or guess its capacity',async()=>{
    const before=await readRoutineSettings(ctx());
    expect(await withTransaction(db.session,()=>saveRoutineSettings(ctx(),{enabled:before.enabled,sequenceVersionId:before.sequenceVersionId,expectedRevision:before.revision,bookingUrl:'https://cal.com/team/callie/intro'}))).toMatchObject({ok:true});
    const result=await readBookingCapacity(ctx(),{now:NOW,client:{async readProfile(){throw new Error('not authorized for guessed team scope');},async readEventTypes(){return [];}}});
    expect(result.provider.reason).toBe('booking_link_unsupported');
    const current=await readRoutineSettings(ctx());await withTransaction(db.session,()=>saveRoutineSettings(ctx(),{enabled:before.enabled,sequenceVersionId:before.sequenceVersionId,bookingUrl:before.bookingUrl,expectedRevision:current.revision}));
  });

  it('shows only assigned matched firms to salespeople and hides unresolved attendee identities',async()=>{
    await withTransaction(db.session,()=>createFirm(ctx(),{name:'Other owner office',website:'https://other-owner.example',assignedUserId:seed.alpha.admin.userId}));
    const body={triggerEvent:'BOOKING_CREATED',createdAt:'2026-10-08T11:00:00.000Z',payload:{uid:randomUUID(),startTime:'2026-10-10T15:00:00.000Z',endTime:'2026-10-10T15:30:00.000Z',attendees:[{email:'manager@other-owner.example'}]}};
    const other=await withTransaction(db.session,()=>receiveCalcomEvent(db.session,{workspaceId:seed.alpha.workspaceId,rawBody:Buffer.from(JSON.stringify(body)),body}));
    const salesperson=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.salesperson.userId,role:'salesperson'}),db.session);
    const result=await readBookingCapacity(salesperson,{client:null,now:NOW});
    expect(result.recorded.bookings.map(row=>row.meetingId)).not.toContain(other.meetingId);
    expect(result.recorded.bookings.find(row=>row.matchReason==='firm_ambiguous')).toMatchObject({firm:null,attendeeEmail:null});
    expect(result.recorded.bookings.find(row=>row.firm?.name==='Known Office')).toMatchObject({attendeeEmail:'manager@known.example'});
  });

  it.each([{events:[],reason:'event_not_found'},{events:[{id:73},{id:74}],reason:'event_ambiguous'}])('reports $reason without guessing one provider event',async({events,reason})=>{
    const result=await readBookingCapacity(ctx(),{now:NOW,client:{async readProfile(){return {id:42,username:'callie-founder'};},async readEventTypes(){return events;}}});
    expect(result.provider).toMatchObject({status:'unavailable',reason,eventTypeId:null,weeklyLimit:null});
  });

});
