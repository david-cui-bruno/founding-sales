import {afterAll,beforeAll,expect,it} from 'vitest';
import {z} from 'zod';
import {outreachControlSchema} from '@fss/contracts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';

// Required retired field from the actual installed 1.0.51 app.asar parser,
// whose release stamp pins d49dda37dfb6d95cb7c5aa077da2f32b2724dc79.
// All six ordinary control fields are unchanged from that strict schema.
const legacyEvaluation=z.strictObject({policyVersion:z.string().min(1).max(100),promptVersion:z.string().min(1).max(100),implementationCommit:z.string().regex(/^[a-f0-9]{40}$/),reportSha256:z.string().regex(/^[a-f0-9]{64}$/),configurationSha256:z.string().regex(/^[a-f0-9]{64}$/),reviewedEligible:z.number().int().nonnegative(),falseEligible:z.number().int().nonnegative()});
const legacyControl=outreachControlSchema.extend({emailAdmission:z.strictObject({revision:z.number().int().nonnegative(),enabled:z.boolean(),ownerUserId:z.uuid().nullable(),mailboxId:z.uuid().nullable(),sequenceVersionId:z.uuid().nullable(),evaluation:legacyEvaluation.nullable(),configurationSha256:z.string().nullable(),ready:z.boolean(),reasons:z.array(z.string())})});
let fixture:AuthFixture;
beforeAll(async()=>{fixture=await createAuthFixture();});
afterAll(async()=>fixture.stop());
const post=(token:string,path:string,body:unknown={},headers:Record<string,string>={})=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`,...headers},body},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});

it('removes admission activation/configuration routes and the automatic worker without removing ordinary selling',async()=>{
 const grant=await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin);
 for(const path of ['/outreach/email-admission/save','/outreach/email-admission/readiness','/outreach/email-admission/activation/prepare','/outreach/email-admission/activate']){
  expect((await post(grant.accessToken,path)).status,path).toBe(404);
  expect((await dispatch({method:'GET',path,body:undefined,query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false})).status,path).toBe(404);
 }
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined});
 expect(registry.get('outreach.email_admit')).toBeUndefined();
 for(const kind of ['sequence.action','reply.human_send','outreach.reply','sequence.terminal_stop'])expect(registry.get(kind),kind).toBeDefined();
});

it('keeps authenticated installed strict parsing inert while preserving current control and ignoring forged version headers',async()=>{
 const grant=await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin);
 await fixture.db.query('INSERT INTO outreach_email_admission_settings(workspace_id,revision,enabled) VALUES($1,17,false)',[fixture.alpha.workspaceId]);
 const before=(await fixture.db.query('SELECT * FROM outreach_email_admission_settings WHERE workspace_id=$1',[fixture.alpha.workspaceId])).rows;
 const current=await post(grant.accessToken,'/outreach/control/v2',{}, {'x-client-version':'1.0.51'});
 expect(current.status).toBe(200);
 expect(outreachControlSchema.parse(current.body)).toMatchObject({settings:{enabled:false},senders:[],sequences:[],candidates:[],replies:[]});
 expect(legacyControl.safeParse(current.body).success).toBe(false);
 await fixture.db.query('UPDATE sessions SET client_version=$3 WHERE workspace_id=$1 AND device_id=$2',[fixture.alpha.workspaceId,grant.deviceId,'1.0.51']);
 const old=await post(grant.accessToken,'/outreach/control/v2',{}, {'x-client-version':CURRENT_CLIENT_VERSION});
 expect(old.status).toBe(200);
 expect(legacyControl.parse(old.body)).toMatchObject({emailAdmission:{revision:0,enabled:false,ownerUserId:null,mailboxId:null,sequenceVersionId:null,evaluation:null,configurationSha256:null,ready:false,reasons:['automatic_admission_removed']},settings:{enabled:false}});
 expect(outreachControlSchema.safeParse(old.body).success).toBe(false);
 const original=await post(grant.accessToken,'/outreach/control');
 expect(original.status).toBe(200);expect(outreachControlSchema.parse(original.body)).toEqual(current.body);
 expect((await fixture.db.query('SELECT * FROM outreach_email_admission_settings WHERE workspace_id=$1',[fixture.alpha.workspaceId])).rows).toEqual(before);
 const salesperson=await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson);
 expect((await post(salesperson.accessToken,'/outreach/control/v2')).status).toBe(403);
 const other=await issueSessionFor(fixture,fixture.beta,fixture.beta.admin);
 expect((await post(other.accessToken,'/outreach/control/v2')).status).toBe(200);
 expect((await fixture.db.query('SELECT * FROM outreach_email_admission_settings WHERE workspace_id=$1',[fixture.beta.workspaceId])).rows).toHaveLength(0);
});
