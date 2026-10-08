import {expect,it} from 'vitest';
import {defaultNotificationActivationIdentifier} from '../src/main/notifications/activation.ts';
it('accepts only a default-click stable owned namespace identifier and never trusts native userInfo routing',()=>{
 const identifier=`callie-action:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:${'a'.repeat(64)}`;
 expect(defaultNotificationActivationIdentifier({identifier,actionIdentifier:'com.apple.UNNotificationDefaultActionIdentifier',userInfo:{target:'https://untrusted.example'}})).toBe(identifier);
 expect(defaultNotificationActivationIdentifier({identifier,actionIdentifier:'com.apple.UNNotificationDismissActionIdentifier'})).toBeNull();
 expect(defaultNotificationActivationIdentifier({identifier:'https://untrusted.example',actionIdentifier:'com.apple.UNNotificationDefaultActionIdentifier'})).toBeNull();
 expect(defaultNotificationActivationIdentifier({identifier,actionIdentifier:'custom-send'})).toBeNull();
});
