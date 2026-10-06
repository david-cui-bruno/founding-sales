import {lookup as dnsLookup} from 'node:dns/promises';import {request as httpsRequest} from 'node:https';import {isIP} from 'node:net';
const CAP=20*1024*1024;
type Answer={status:number;location:string|null;contentType:string;body:Buffer};
type Request={url:string;hostname:string;address:string;timeoutMs:number};
interface Ports{lookup?:(host:string)=>Promise<readonly string[]>;request?:(input:Request)=>Promise<Answer>}
/** Same conservative IPv4 policy as research/sourcePolicy; every DNS answer must pass. */
function publicAddress(address:string){if(isIP(address)!==4)return false;const [a,b]=address.split('.').map(Number);return a!==undefined&&b!==undefined&&a>0&&a<224&&a!==10&&a!==127&&!(a===100&&b>=64&&b<=127)&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===0||b===168))&&!(a===198&&(b===18||b===19||b===51))&&!(a===203&&b===0);}
function checkedUrl(value:string){let url:URL;try{url=new URL(value);}catch{throw new Error('invalid_image_url');}if(value.length>2048||url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!url.hostname.includes('.')||url.hostname.endsWith('.local'))throw new Error('invalid_image_url');url.hash='';return url;}
async function socket(input:Request):Promise<Answer>{return new Promise((resolve,reject)=>{
 const url=new URL(input.url);const req=httpsRequest({hostname:input.address,servername:input.hostname,port:443,path:url.pathname+url.search,method:'GET',rejectUnauthorized:true,headers:{host:input.hostname,accept:'image/png,image/jpeg,image/webp,image/heic','accept-encoding':'identity'},signal:AbortSignal.timeout(input.timeoutMs)},res=>{
 const type=String(res.headers['content-type']??'').split(';')[0]!.trim().toLowerCase();const status=res.statusCode??0;
 if(status>=300&&status<400){res.destroy();resolve({status,location:res.headers.location??null,contentType:type,body:Buffer.alloc(0)});return;}
 if(Number(res.headers['content-length']??0)>CAP||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(new Error('image_too_large'));return;}
 const chunks:Buffer[]=[];let bytes=0;res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>CAP){res.destroy(new Error('image_too_large'));return;}chunks.push(chunk);});res.on('end',()=>resolve({status,location:null,contentType:type,body:Buffer.concat(chunks)}));res.on('error',reject);
 });req.on('error',reject);req.end();
});}
export async function fetchSocialImage(value:string,ports:Ports={}):Promise<{bytes:Buffer;sourceUrl:string;mime:string}>{
 const original=checkedUrl(value).toString();let url=checkedUrl(value);const deadline=Date.now()+15_000;
 const lookup=ports.lookup??(async(host:string)=>(await dnsLookup(host,{all:true,verbatim:true})).map(v=>v.address)),request=ports.request??socket;
 for(let redirects=0;redirects<=3;redirects++){
  const remaining=deadline-Date.now();if(remaining<=0)throw new Error('image_fetch_timeout');
  let timer:ReturnType<typeof setTimeout>|undefined;
  const addresses=await Promise.race([lookup(url.hostname),new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(new Error('image_fetch_timeout')),remaining);})]).finally(()=>clearTimeout(timer));
  if(addresses.length===0||!addresses.every(publicAddress))throw new Error('image_host_not_public');
  const timeoutMs=deadline-Date.now();if(timeoutMs<=0)throw new Error('image_fetch_timeout');
  const answer=await request({url:url.toString(),hostname:url.hostname,address:addresses[0]!,timeoutMs});
  if([301,302,303,307,308].includes(answer.status)&&answer.location){url=checkedUrl(new URL(answer.location,url).toString());continue;}
  if(answer.status!==200)throw new Error('image_fetch_failed');if(answer.body.length>CAP)throw new Error('image_too_large');if(!['image/png','image/jpeg','image/webp','image/heic','image/heif'].includes(answer.contentType))throw new Error('unsupported_image');
  return {bytes:answer.body,sourceUrl:original,mime:answer.contentType};
 }throw new Error('too_many_redirects');
}
