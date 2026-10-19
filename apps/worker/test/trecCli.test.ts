import {afterEach,describe,expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {parseFssCommand} from '../src/tools/fss/commands.ts';
const execute=promisify(execFile);
const directories:string[]=[];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'trec-cli-'));directories.push(directory);
 const file=join(directory,'trecfile.txt'),report=join(directory,'report.json');
 const fields=Array<string>(33).fill('');
 Object.assign(fields,{0:'BLLC',1:'123456',2:'Synthetic Brokerage LLC',4:'20',5:'20200101',6:'20271031',18:'101',25:'101',31:'1'});
 await writeFile(file,fields.join('\t')+'\r\n');
 const args=['trec','verify','--file',file,'--source-url','https://www.trec.texas.gov/public/trec-public-information-files-instructions','--retrieved-at','2026-10-19T00:00:00Z','--official-legacy-file','true','--firms-json',JSON.stringify([{firmId:'synthetic-firm',legalName:'Synthetic Brokerage LLC',mailingCountyCode:'101'}]),'--report',report];
 return {file,report,args};
}
const environment={...process.env,DATABASE_URL:'http://[PRIVATE_DATABASE_SECRET',FSS_DATABASE_HOST:'invalid.invalid'};
const entry=new URL('../src/tools/fss.ts',import.meta.url).pathname;
describe('registered local TREC CLI',()=>{
 it('has closed grammar and requires explicit official-file attestation',async()=>{
  const {args}=await fixture();
  expect(parseFssCommand(args).ok).toBe(true);
  expect(parseFssCommand([...args,'--email','private@example.test'])).toMatchObject({ok:false,reason:'flag_unknown'});
  expect(parseFssCommand(args.filter((_,index)=>index!==8&&index!==9)).ok).toBe(false);
 });
 it('executes with poisoned database configuration and writes only the local minimized result',async()=>{
  const {args,report}=await fixture();
  const result=await execute(process.execPath,['--experimental-transform-types',entry,...args],{env:environment,timeout:15000});
  const answer=JSON.parse(result.stdout) as {ok:boolean;value:unknown};
  expect(answer).toMatchObject({ok:true,value:{qualificationAuthority:false,admissionAuthority:false,outreachAuthority:false,results:[{outcome:'matched'}]}});
  expect(JSON.parse(await readFile(report,'utf8'))).toEqual(answer);
  expect(result.stdout+result.stderr).not.toContain('PRIVATE_DATABASE_SECRET');
 });
 it('refuses missing local files without resolving configuration or leaking a path',async()=>{
  const {file,args}=await fixture();await rm(file);
  let failure:unknown;
  try{await execute(process.execPath,['--experimental-transform-types',entry,...args],{env:environment,timeout:15000});}catch(error){failure=error;}
  expect(failure).toMatchObject({code:20});
  const result=failure as {stdout:string;stderr:string};
  expect(JSON.parse(result.stdout)).toMatchObject({ok:false,reason:'trec_verification_unavailable'});
  expect(result.stdout+result.stderr).not.toContain(file);
  expect(result.stdout+result.stderr).not.toContain('PRIVATE_DATABASE_SECRET');
 });
});
