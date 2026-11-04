import {startPublisherBrowserHost} from './publisherHost.ts';
import {assertPublisherDebugDisabled,publisherControlToken} from './publisherConfig.ts';

let token:Buffer|undefined;
try{
 assertPublisherDebugDisabled(process.env);
 const prohibited=['DATABASE_URL','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_CONTAINER_CREDENTIALS_RELATIVE_URI','AWS_CONTAINER_CREDENTIALS_FULL_URI','AWS_WEB_IDENTITY_TOKEN_FILE','AWS_ROLE_ARN','GOOGLE_APPLICATION_CREDENTIALS'];
 if(Object.keys(process.env).some(key=>prohibited.includes(key)||/^PG[A-Z_]/u.test(key)||key.startsWith('FSS_')&&!['FSS_SOCIAL_PUBLISHER_TOKEN','FSS_SOCIAL_PUBLISHER_CHROMIUM_PATH'].includes(key)))throw new Error('publisher_host_application_credentials_refused');
 token=publisherControlToken(process.env['FSS_SOCIAL_PUBLISHER_TOKEN']);
 const executablePath=process.env['FSS_SOCIAL_PUBLISHER_CHROMIUM_PATH'];
 const host=await startPublisherBrowserHost({token,...(executablePath?{executablePath}:{})});
 let requested=false;
 const stop=()=>{requested=true;void host.close().catch(()=>{process.exitCode=1;});};
 process.once('SIGTERM',stop);process.once('SIGINT',stop);process.once('SIGHUP',stop);
 await host.closed;
 process.off('SIGTERM',stop);process.off('SIGINT',stop);process.off('SIGHUP',stop);
 if(!requested){process.exitCode=1;console.error('publisher_host_unavailable');}
}catch{
 process.exitCode=1;console.error('publisher_host_startup_failed');
}finally{token?.fill(0);}
