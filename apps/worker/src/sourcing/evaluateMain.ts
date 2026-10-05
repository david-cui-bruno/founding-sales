import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {evaluateDiscovery} from './evaluateDiscovery.ts';
import {tavilySearch} from './tavilySearch.ts';
import {SOURCING_EVALUATION_QUERIES} from './evaluationQueries.ts';
export async function main(argv:readonly string[],env:NodeJS.ProcessEnv):Promise<number>{
 if(argv.length===0||argv[0]==='--dry-run'){
  process.stdout.write(JSON.stringify({mode:'dry_run',queries:SOURCING_EVALUATION_QUERIES,maximumBatchCredits:9,dailyAttemptLimit:20,monthlyAttemptLimit:600},null,2)+'\n');return 0;
 }
 if(argv.length!==1||argv[0]!=='--run'){process.stderr.write('Use --dry-run or --run.\n');return 2;}
 const key=env['FSS_TAVILY_API_KEY'];
 if(!key){process.stderr.write('FSS_TAVILY_API_KEY is required; never pass it as a command argument.\n');return 2;}
 try{
  const report=await evaluateDiscovery({directory:join(homedir(),'.local','share','callie','sourcing-evaluation'),provider:tavilySearch(key),queries:SOURCING_EVALUATION_QUERIES});
  process.stdout.write(JSON.stringify({attempts:report.results.length,hits:report.results.reduce((n,r)=>n+(r.result.ok?r.result.hits.length:0),0),stopReason:report.stopReason})+'\n');
  return report.stopReason===null?0:1;
 }catch{process.stderr.write('Evaluation stopped. Check the local ledger and lock; no automatic reset was attempted.\n');return 1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main(process.argv.slice(2),process.env);
