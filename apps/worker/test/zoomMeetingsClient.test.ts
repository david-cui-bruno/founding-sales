import { describe, expect, it, vi } from 'vitest';
import { readZoomMeetingsConfiguration, zoomMeetingsClient } from '../src/zoom/meetingsClient.ts';
const secret=['test','sentinel','private'].join('-');
const meeting={id:12345678901,host_email:'host@example.com',type:2,start_time:'2026-10-05T15:00:00Z',duration:30,settings:{use_pmi:false,auto_recording:'none'},start_url:secret,password:secret};
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
const config={accountId:'test-account',clientId:'test-client',clientSecret:secret};
const signal=()=>new AbortController().signal;
describe('narrow Zoom meeting client',()=>{
  it('patches_only_local_recording',async()=>{
    const requests:{url:string;init:RequestInit}[]=[];
    const client=zoomMeetingsClient({...config,http:async(url,init)=>{requests.push({url,init});return url.includes('/oauth/')?json({access_token:secret,expires_in:3600}):init.method==='PATCH'?new Response(null,{status:204}):json(meeting);}});
    expect(await client.setLocalAutoRecording('12345678901',signal())).toMatchObject({kind:'refused',code:'token_expired'}); expect(requests).toHaveLength(0);
    expect(await client.readMeeting('12345678901',signal())).toMatchObject({kind:'ok',value:{id:'12345678901',usePmi:false}});
    expect(await client.setLocalAutoRecording('12345678901',signal())).toMatchObject({kind:'acknowledged'});
    expect(requests.map(r=>r.init.method)).toEqual(['POST','GET','PATCH']);
    expect(JSON.parse(String(requests[2]!.init.body))).toEqual({settings:{auto_recording:'local'}});
    expect(requests.every(r=>r.init.redirect==='error')).toBe(true);
    expect(requests[2]!.url).toBe('https://api.zoom.us/v2/meetings/12345678901');
  });
  it('never_leaks_provider_secrets and never retries an uncertain patch',async()=>{
    let patches=0;
    const client=zoomMeetingsClient({...config,http:async(url,init)=>{
      if(url.includes('/oauth/'))return json({access_token:secret,expires_in:3600});
      if(init.method==='PATCH'){patches++;throw new Error(secret);}return json(meeting);
    }});
    const read=await client.readMeeting('12345678901',signal()); expect(JSON.stringify(read)).not.toContain(secret);
    const result=await client.setLocalAutoRecording('12345678901',signal());expect(result).toMatchObject({kind:'unknown'}); expect(patches).toBe(1);expect(JSON.stringify(result)).not.toContain(secret);
    expect(readZoomMeetingsConfiguration({'zoom-meetings':JSON.stringify({account_id:secret})})).toEqual({client:null,problem:'field:client_id'});
  });
  it('refreshes one rejected read token but not a PATCH',async()=>{
    let tokens=0,gets=0;
    const client=zoomMeetingsClient({...config,http:async(url,init)=>{
      if(url.includes('/oauth/')){tokens++;return json({access_token:secret,expires_in:3600});}
      if(init.method==='PATCH')return json({secret},401);
      gets++;return gets===1?json({secret},401):json(meeting);
    }});
    expect((await client.readMeeting('12345678901',signal())).kind).toBe('ok'); expect(tokens).toBe(2);
    expect(await client.setLocalAutoRecording('12345678901',signal())).toMatchObject({kind:'refused',code:'auth_failed'});expect(tokens).toBe(2);
  });
  it('bounds_headers_and_body_reads',async()=>{
    vi.useFakeTimers();
    try {
      const client=zoomMeetingsClient({...config,http:async()=>new Response(new ReadableStream({start(){}}))});
      const promise=client.readMeeting('12345678901',signal());
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await promise).toMatchObject({kind:'retry',code:'provider_unreachable'});
    } finally {vi.useRealTimers();}
    const client=zoomMeetingsClient({...config,http:async()=>new Response('x'.repeat(1024*1024+1))});
    expect((await client.readMeeting('12345678901',signal())).kind).not.toBe('ok');
  });
});
