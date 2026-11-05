import {it,expect} from 'vitest';
import {socialPublisherBindingSchema,socialPublisherConnectionInputSchema,socialPublisherConnectionResultSchema,SOCIAL_PUBLISHER_ADAPTER} from '../src/socialPublisher.ts';
const id='10000000-0000-4000-8000-000000000001';
it('binds Buffer-native identity, credential revision and channel without interpreting the service ID as a profile URL',()=>{
 const binding={adapter:SOCIAL_PUBLISHER_ADAPTER,workspaceId:id,ownerUserId:id,accountId:id,accountRevision:1,credentialId:id,credentialRevision:2,organizationId:'1'.repeat(24),channelId:'2'.repeat(24),externalId:'native-service-id'};
 expect(socialPublisherBindingSchema.parse(binding)).toEqual(binding);
 const {credentialId:_credentialId,credentialRevision:_credentialRevision,...identity}=binding;
 expect(socialPublisherBindingSchema.safeParse({...identity,sessionId:id,sessionRevision:2}).success).toBe(false);
 expect(socialPublisherBindingSchema.safeParse({...binding,adapter:'linkedin-web-chromium-v1'}).success).toBe(false);
 expect(socialPublisherBindingSchema.safeParse({...binding,channelId:'https://www.linkedin.com/in/example'}).success).toBe(false);
});
it('requires explicit discovery/selection transport and never returns a key in connection results',()=>{
 expect(socialPublisherConnectionInputSchema.safeParse({operation:'discover',apiKey:'private-key'}).success).toBe(true);
 expect(socialPublisherConnectionInputSchema.safeParse({operation:'connect',accountId:id,apiKey:'private-key',organizationId:'1'.repeat(24),channelId:'2'.repeat(24)}).success).toBe(true);
 expect(socialPublisherConnectionInputSchema.safeParse({operation:'connect',accountId:id,apiKey:'private-key'}).success).toBe(false);
 expect(socialPublisherConnectionInputSchema.safeParse({operation:'start',accountId:id}).success).toBe(false);
 expect(socialPublisherConnectionResultSchema.safeParse({state:'connected',accountId:id,revision:1,externalId:'native-id',displayName:'Owner',apiKey:'private-key'}).success).toBe(false);
});
