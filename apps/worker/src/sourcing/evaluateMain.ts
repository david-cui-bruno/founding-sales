import {pathToFileURL} from 'node:url';
import {DISCOVERY_DAILY_CREDIT_LIMIT,DISCOVERY_MONTHLY_CREDIT_LIMIT} from '@fss/domain/sourcing/discoveryQuota.ts';
import {SOURCING_EVALUATION_QUERIES} from './evaluationQueries.ts';
/** Planning only. A host-local evaluation ledger cannot enforce the shared account cap. */
export async function main(argv:readonly string[],_env:NodeJS.ProcessEnv):Promise<number>{
 if(argv.length===0||(argv.length===1&&argv[0]==='--dry-run')){
  process.stdout.write(JSON.stringify({mode:'dry_run',queries:SOURCING_EVALUATION_QUERIES,maximumBatchCredits:9,dailyAttemptLimit:DISCOVERY_DAILY_CREDIT_LIMIT,monthlyAttemptLimit:DISCOVERY_MONTHLY_CREDIT_LIMIT},null,2)+'\n');return 0;
 }
 if(argv.length!==1||argv[0]!=='--run'){process.stderr.write('Use --dry-run. Paid local evaluation is disabled.\n');return 2;}
 // Refuse before reading credentials, touching a local ledger or constructing a port.
 process.stderr.write('Paid local evaluation is disabled. Use the audited sourcing.discovery.configure and scheduled discovery path sharing the global account ledger. Do not reset existing usage or holds.\n');return 2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await main(process.argv.slice(2),process.env);
