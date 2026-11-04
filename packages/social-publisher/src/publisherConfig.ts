import {timingSafeEqual} from 'node:crypto';

export interface PublisherRemoteBrowser {kind:'remote';endpoint:string;token:Buffer}
export interface PublisherLocalBrowser {kind:'local';executablePath?:string}
export type PublisherBrowserConnection=PublisherRemoteBrowser|PublisherLocalBrowser;
export const PUBLISHER_BROWSER_PATH='/social/publisher-runtime/browser';

/** No raw config or credential bytes in configuration errors. */
export function publisherControlToken(raw:string|undefined):Buffer{
 if(!raw||raw.length!==44||!/^[A-Za-z0-9+/]{43}=$/u.test(raw))throw new Error('publisher_control_token_invalid');
 const token=Buffer.from(raw,'base64');
 if(token.length!==32||token.toString('base64')!==raw)throw new Error('publisher_control_token_invalid');
 return token;
}
export function publisherRemoteEndpoint(raw:string|undefined):string{
 try{
  if(!raw||raw.length>512||raw.includes('?')||raw.includes('#'))throw new Error();
  const url=new URL(raw);
  if(url.protocol!=='wss:'||!url.hostname||url.username||url.password||url.port||url.pathname!==PUBLISHER_BROWSER_PATH||url.href!==raw)throw new Error();
  return url.href;
 }catch{throw new Error('publisher_remote_endpoint_invalid');}
}
export function assertPublisherDebugDisabled(environment:NodeJS.ProcessEnv):void{
 if(environment['DEBUG']||environment['NODE_DEBUG']||environment['PWDEBUG']&&environment['PWDEBUG']!=='0')throw new Error('publisher_debug_logging_refused');
 if(/--(?:inspect|prof|heapsnapshot|trace-event)/u.test(environment['NODE_OPTIONS']??''))throw new Error('publisher_debug_logging_refused');
}
/** All absent means disabled. Any partial configuration fails rather than silently
 * launching locally on production Fargate or borrowing another secret. */
export function publisherProductionConfiguration(environment:NodeJS.ProcessEnv):{sessionKey:Buffer;browser:PublisherRemoteBrowser}|null{
 const rawKey=environment['FSS_SOCIAL_PUBLISHER_SESSION_KEY'],rawEndpoint=environment['FSS_SOCIAL_PUBLISHER_ENDPOINT'],rawToken=environment['FSS_SOCIAL_PUBLISHER_TOKEN'];
 if(rawKey===undefined&&rawEndpoint===undefined&&rawToken===undefined)return null;
 if(!rawKey||!rawEndpoint||!rawToken)throw new Error('publisher_configuration_incomplete');
 if(environment['NODE_TLS_REJECT_UNAUTHORIZED']==='0'||process.env['NODE_TLS_REJECT_UNAUTHORIZED']==='0')throw new Error('publisher_tls_verification_required');
 assertPublisherDebugDisabled(environment);assertPublisherDebugDisabled(process.env);
 const sessionKey=Buffer.from(rawKey,'base64');
 if(sessionKey.length!==32||sessionKey.toString('base64')!==rawKey)throw new Error('social_publisher_session_key_invalid');
 const token=publisherControlToken(rawToken);
 if(timingSafeEqual(sessionKey,token))throw new Error('publisher_separate_control_token_required');
 return {sessionKey,browser:{kind:'remote',endpoint:publisherRemoteEndpoint(rawEndpoint),token}};
}
