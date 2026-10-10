import type {CrmCapabilityStartupConfiguration} from '@fss/domain/crm/capabilityStartup.ts';
import {createCrmCapabilityVerifiers,type CrmAuthoritySessions} from '@fss/domain/crm/capabilityVerifiers.ts';
import {createNativeCrmMailEvidence} from '@fss/domain/crm/nativeMailEvidence.ts';
import {createApprovedBusinessMailObserver} from '@fss/domain/mail/crmSources.ts';
import {composeCrmGmail,createServerCrmGmailAccessResolver} from './crmGmail.ts';
import {composeCrmBedrock} from './crmBedrock.ts';
import {loadCrmBedrockSurface,type CrmBedrockSurface} from '../providers/crmBedrock.ts';
import type {HandlerComposition} from './main.ts';
/** Optional SDK construction does not invoke a provider or activate a purpose. */
export async function composeCrmCapabilities(input:CrmAuthoritySessions & {configuration:CrmCapabilityStartupConfiguration;gmail?:Parameters<typeof createServerCrmGmailAccessResolver>[0] & {gmail:NonNullable<HandlerComposition['mail']>['gmail']};loadSurface?:(region:string)=>Promise<CrmBedrockSurface>}){
 const verifiers=createCrmCapabilityVerifiers(input);const mailEvidence=createNativeCrmMailEvidence(verifiers.captureVerifier);
 const observer=createApprovedBusinessMailObserver({revalidateAuthority:verifiers.revalidateMetadata});
 const gmail=input.configuration.capture&&input.gmail?composeCrmGmail({gmail:input.gmail.gmail,resolveAccess:createServerCrmGmailAccessResolver({...input.gmail,openSession:input.openSession}),proofVerifier:verifiers.captureVerifier,allocationVerifier:verifiers.allocationVerifier,observer}):{};
 const region=input.configuration.extraction?.region??input.configuration.answer?.region;
 const bedrock=region?composeCrmBedrock({surface:await(input.loadSurface?.(region)??loadCrmBedrockSurface({region})),...input.configuration.extraction?{extraction:input.configuration.extraction}:{},...input.configuration.answer?{answer:input.configuration.answer}:{},mailEvidence,verifyExtraction:verifiers.verifyExtraction,revalidateExtraction:verifiers.revalidateExtraction,verifyPurpose:verifiers.verifyAskPurpose,revalidateAskPurpose:verifiers.revalidateAskPurpose}):{};
 return {handlers:{...gmail,...bedrock},observer,mailEvidence,verifiers};
}
