import type {CrmCapabilityStartupConfiguration} from '@fss/domain/crm/capabilityStartup.ts';
import {createCrmCapabilityVerifiers,type CrmAuthoritySessions} from '@fss/domain/crm/capabilityVerifiers.ts';
import {createNativeCrmMailEvidence} from '@fss/domain/crm/nativeMailEvidence.ts';
import {createApprovedBusinessMailObserver} from '@fss/domain/mail/crmSources.ts';
import {composeCrmGmail,createServerCrmGmailAccessResolver} from './crmGmail.ts';
import {composeCrmBedrock} from './crmBedrock.ts';
import {loadCrmBedrockSurface,type CrmBedrockSurface} from '../providers/crmBedrock.ts';
import type {HandlerComposition} from './main.ts';
/** Optional extraction construction does not invoke a provider or activate a purpose. */
export async function composeCrmCapabilities(input:CrmAuthoritySessions & {configuration:CrmCapabilityStartupConfiguration;gmail?:Parameters<typeof createServerCrmGmailAccessResolver>[0] & {gmail:NonNullable<HandlerComposition['mail']>['gmail']};loadSurface?:(region:string)=>Promise<CrmBedrockSurface>}){
 const verifiers=createCrmCapabilityVerifiers(input);const mailEvidence=createNativeCrmMailEvidence(verifiers.captureVerifier);
 const observer=createApprovedBusinessMailObserver({revalidateAuthority:verifiers.revalidateMetadata});
 const gmail=input.configuration.capture&&input.gmail?composeCrmGmail({gmail:input.gmail.gmail,resolveAccess:createServerCrmGmailAccessResolver({...input.gmail,openSession:input.openSession}),proofVerifier:verifiers.captureVerifier,allocationVerifier:verifiers.allocationVerifier,observer}):{};
 const extraction=input.configuration.extraction;
 const bedrock=extraction?composeCrmBedrock({surface:await(input.loadSurface?.(extraction.region)??loadCrmBedrockSurface({region:extraction.region})),extraction,mailEvidence,verifyExtraction:verifiers.verifyExtraction,revalidateExtraction:verifiers.revalidateExtraction}):{};
 return {handlers:{...gmail,...bedrock},observer,mailEvidence,verifiers};
}
