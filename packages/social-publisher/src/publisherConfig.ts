export interface PublisherConfiguration {credentialKey:Buffer;mediaOrigin:string}
export function publisherProductionConfiguration(environment:NodeJS.ProcessEnv):PublisherConfiguration|undefined {
 const key=environment['FSS_SOCIAL_PUBLISHER_CREDENTIAL_KEY'],origin=environment['FSS_SOCIAL_PUBLISHER_MEDIA_ORIGIN'];
 if(key===undefined&&origin===undefined)return undefined;
 if(!key||!origin)throw new Error('publisher_configuration_incomplete');
 const bytes=Buffer.from(key,'base64');
 if(bytes.length!==32||bytes.toString('base64')!==key)throw new Error('publisher_credential_key_invalid');
 let url:URL;try{url=new URL(origin);}catch{throw new Error('publisher_media_origin_invalid');}
 if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw new Error('publisher_media_origin_invalid');
 return {credentialKey:bytes,mediaOrigin:origin};
}
