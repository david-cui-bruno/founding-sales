import {EMAIL_FIT_POLICY_VERSION} from '../packages/domain/outreach/selection.ts';
// Offline diagnostic only: Vitest provisions its own PostgreSQL cluster. No
// production URL, search client, crawler, mailbox credentials or send adapter.
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const sha=value=>createHash('sha256').update(value).digest('hex');
const write=(directory,name,value)=>writeFileSync(join(directory,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
async function test(directory,args,extraEnv={}){
 const child=spawn('npm',['run','test','--workspace','apps/worker','--','test/automaticEmailAdmission.test.ts','--reporter=json',`--outputFile=${join(directory,'vitest.json')}`,...args],{cwd:root,stdio:'inherit',env:{...process.env,...extraEnv}});
 return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code===0));});
}
async function main(){
 if(process.argv.length!==3)throw new Error('Usage: npm run evaluate:email-admission -- <new-output-directory>');
 const commit=git('rev-parse','HEAD');
 if(git('diff','HEAD','--name-only')||git('ls-files','--others','--exclude-standard','apps','packages','scripts','tools','test'))throw new Error('Commit the evaluated tree first; tracked changes or untracked code cannot bind an exact implementation.');
 const directory=resolve(process.argv[2]);mkdirSync(directory,{recursive:false,mode:0o700});
 const sourcePath='apps/worker/test/support/emailEvaluationSources.json',challengePath='apps/worker/test/support/emailEvaluationChallenges.json';
 const source=JSON.parse(readFileSync(join(root,sourcePath),'utf8'));
 const challenges=JSON.parse(readFileSync(join(root,challengePath),'utf8'));
 const corpus=[...source.cases,...challenges];
 const environment={FSS_EMAIL_EVALUATED_COMMIT:commit,FSS_EMAIL_EVALUATION_DIRECTORY:directory,FSS_EMAIL_EVALUATION_REPORT:'',FSS_EMAIL_CONTROL_RECEIPT_DIRECTORY:''};
 const passed=await test(directory,[],environment);
 const suite=JSON.parse(readFileSync(join(directory,'vitest.json'),'utf8'));
 const actual=JSON.parse(readFileSync(join(directory,'case-results.json'),'utf8'));
 const tests=suite.testResults.flatMap(file=>file.assertionResults.map(t=>({name:t.fullName,status:t.status,failureMessages:t.failureMessages})));
 const cases=corpus.map(c=>({id:c.id,provenance:c.provenance,expectedAdmission:c.expectedAdmission,expectedEvidenceAccepted:c.expectedEvidenceAccepted,expectedRank:c.expectedRank,actual:actual.find(r=>r.id===c.id)??null,evidence:c.observations.map(o=>({observationId:o.id,url:o.url,retrievedAt:o.retrievedAt,contentHash:o.contentHash,relevantTextHash:o.relevantTextHash,truncated:o.truncated,firstParty:o.firstParty,selectedBlockIds:c.facts.filter(f=>f.observationId===o.id).map(f=>f.blockId)}))}));
 const falseEligible=cases.filter(c=>!c.expectedAdmission&&c.actual?.actualAdmission===true).length;
 const reviewedEligible=cases.filter(c=>c.provenance.kind==='recorded_first_party_extraction'&&c.expectedAdmission&&c.actual?.actualAdmission===true).length;
 const requiredGuardTests=['does not create a prospect when automatic email admission is off','rejects a changed exact-version evaluation without partial admission','rejects revoked and reauthorized mailbox bindings until reevaluation','does not reassign a supported firm owned by someone else','refuses a retired evaluated sequence','sees a concurrent recipient stop committed while the worker waits for the send gate','concurrent workers and later retries preserve one enrollment and its original scheduled execution','refuses new admission when the sender ramp has no room','preserves the original manually enrolled Key prospect without rearming or enrolling it again'];
 const guardsComplete=requiredGuardTests.every(name=>tests.some(t=>t.name.endsWith(name)&&t.status==='passed'));
 const promptSourceSha256=sha(readFileSync(join(root,'packages/domain/sourcing/qualificationPrompt.ts')));
 const recordedPromptMatches=source.recordedPromptSourceSha256===promptSourceSha256&&source.cases.every(c=>c.provenance.promptVersion==='qualification-growth-v6');
 const complete=recordedPromptMatches&&guardsComplete&&passed&&suite.success===true&&actual.length===corpus.length&&new Set(actual.map(r=>r.id)).size===corpus.length&&cases.every(c=>c.actual?.actualAdmission===c.expectedAdmission&&c.actual?.evidenceAccepted===c.expectedEvidenceAccepted&&(!c.expectedAdmission||c.actual?.actualRank===c.expectedRank))&&tests.length>corpus.length&&tests.every(t=>t.status==='passed')&&falseEligible===0&&reviewedEligible>0;
 const report={version:1,evaluatedAt:new Date().toISOString(),evidenceAsOf:source.asOf,implementationCommit:commit,implementationTree:git('rev-parse','HEAD^{tree}'),policyVersion:EMAIL_FIT_POLICY_VERSION,promptVersion:'qualification-growth-v6',promptSourceSha256,recordedPromptMatches,originalPredicateImplementationCommit:source.originalPredicateImplementationCommit,originalPredicateReportSha256:source.originalPredicateReportSha256,corpus:[sourcePath,challengePath].map(path=>({path,sha256:sha(readFileSync(join(root,path)))})),reviewedEligible,falseEligible,complete,scope:'Selected frozen-source replay and synthetic boundary diagnostic through the real worker/database seam; not population precision, fresh model extraction, ordinary discovery yield, live authentication or activation proof.',requiredGuardTests,limitations:['Five first-party extractions retain original October 7 retrieval times and selected v6 facts with an unchanged prompt. Zanno was refreshed on October 8 through the current v6 bounded runner (one cent recorded, five-cent ceiling). Replay does not measure stochastic model accuracy on new pages.','The frozen database decision clock preserves the stated evidenceAsOf. A later run is a regression replay, not a fresh site retrieval; live admission independently rechecks evidence freshness.','Additional challenge cases are synthetic labels, not real leads or an unbiased market sample.','Worker authority is simulated only in disposable databases. Existing fifty integration checks cover owner/mailbox/sequence/stops/dedup/capacity/sender and outcome behavior with fake external providers.','Actual production configuration, deployed exact commit, received-message authentication and durable Shirley send remain separate activation gates. No production control was read or changed by this command.'],cases,tests};
 write(directory,'report.json',report);
 const reportSha256=sha(readFileSync(join(directory,'report.json')));
 write(directory,'report-digest.json',{reportSha256,implementationCommit:commit,complete});
 if(!complete)throw new Error('Evaluation failed or incomplete. Review report.json; no activation input was produced.');
 const controls=join(directory,'controls');mkdirSync(controls,{mode:0o700});
 const controlPassed=await test(controls,['-t','accepts a bound diagnostic report'],{FSS_EMAIL_EVALUATED_COMMIT:commit,FSS_EMAIL_EVALUATION_REPORT:join(directory,'report.json'),FSS_EMAIL_CONTROL_RECEIPT_DIRECTORY:controls});
 if(!controlPassed)throw new Error('Normal disabled-control validation failed; no activation input was produced.');
 const receipt=JSON.parse(readFileSync(join(controls,'disabled-control-receipt.json'),'utf8'));
 if(receipt.saved.enabled!==false||receipt.activationAccepted!==false||receipt.input.evaluation.reportSha256!==reportSha256)throw new Error('Invalid disabled-control receipt.');
 write(directory,'activation-input.json',{scope:'disposable_database_only',productionReady:false,reportSha256,input:receipt.input,requiredBeforeProduction:['Rerun against the exact final deployed implementation and read the live configuration through normal controls. Bind its current configurationSha256, owner, mailbox, approved sequence and revision; never copy fixture IDs.','Verify sending and received authentication under #424, then fulfill the complete #425 activation receipt. Keep enabled=false until all gates pass.']});
 process.stdout.write(JSON.stringify({directory,implementationCommit:commit,cases:cases.length,tests:tests.length,reviewedEligible,falseEligible,reportSha256,productionReady:false})+'\n');
}
try{await main();}catch(error){process.stderr.write((error instanceof Error?error.message:'Evaluation failed')+'\n');process.exitCode=1;}
